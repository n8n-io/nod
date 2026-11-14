import 'dart:async';
import 'dart:convert';

final class SseMessage {
  const SseMessage({required this.data, this.event, this.id, this.retry});

  final String data;
  final String? event;
  final String? id;
  final Duration? retry;
}

final class SseDecoder extends StreamTransformerBase<List<int>, SseMessage> {
  const SseDecoder();

  @override
  Stream<SseMessage> bind(Stream<List<int>> stream) {
    final parser = _SseParser();
    StreamSubscription<String>? subscription;
    late final StreamController<SseMessage> controller;
    controller = StreamController<SseMessage>(
      sync: true,
      onListen: () {
        subscription = stream
            .transform(const Utf8Decoder(allowMalformed: true))
            .listen(
              (text) {
                for (final event in parser.add(text)) {
                  controller.add(event);
                }
              },
              onError: controller.addError,
              onDone: () {
                for (final event in parser.close()) {
                  controller.add(event);
                }
                unawaited(controller.close());
              },
            );
      },
      onPause: () => subscription?.pause(),
      onResume: () => subscription?.resume(),
      onCancel: () => subscription?.cancel(),
    );
    return controller.stream;
  }
}

final class _SseParser {
  String _buffer = '';
  String? _event;
  String? _id;
  Duration? _retry;
  final List<String> _data = [];

  List<SseMessage> add(String text) {
    _buffer += text;
    return _drain(closing: false);
  }

  List<SseMessage> close() => _drain(closing: true);

  List<SseMessage> _drain({required bool closing}) {
    final messages = <SseMessage>[];
    while (_buffer.isNotEmpty) {
      final carriage = _buffer.indexOf('\r');
      final newline = _buffer.indexOf('\n');
      final candidates = [carriage, newline].where((index) => index >= 0);
      if (candidates.isEmpty) break;
      final index = candidates.reduce(
        (left, right) => left < right ? left : right,
      );
      if (!closing &&
          _buffer.codeUnitAt(index) == 13 &&
          index == _buffer.length - 1) {
        break;
      }
      final line = _buffer.substring(0, index);
      var consumed = 1;
      if (_buffer.codeUnitAt(index) == 13 &&
          index + 1 < _buffer.length &&
          _buffer.codeUnitAt(index + 1) == 10) {
        consumed = 2;
      }
      _buffer = _buffer.substring(index + consumed);
      final message = _accept(line);
      if (message != null) messages.add(message);
    }
    if (closing) {
      if (_buffer.isNotEmpty) {
        final message = _accept(_buffer);
        if (message != null) messages.add(message);
        _buffer = '';
      }
      final message = _dispatch();
      if (message != null) messages.add(message);
    }
    return messages;
  }

  SseMessage? _accept(String line) {
    if (line.isEmpty) return _dispatch();
    if (line.startsWith(':')) return null;
    final separator = line.indexOf(':');
    final field = separator < 0 ? line : line.substring(0, separator);
    var value = separator < 0 ? '' : line.substring(separator + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'event':
        _event = value;
        return null;
      case 'data':
        _data.add(value);
        return null;
      case 'id':
        if (!value.contains('\u0000')) _id = value;
        return null;
      case 'retry':
        final milliseconds = int.tryParse(value);
        if (milliseconds != null && milliseconds >= 0) {
          _retry = Duration(milliseconds: milliseconds);
        }
        return null;
      default:
        return null;
    }
  }

  SseMessage? _dispatch() {
    if (_data.isEmpty) {
      _event = null;
      return null;
    }
    final message = SseMessage(
      data: _data.join('\n'),
      event: _event,
      id: _id,
      retry: _retry,
    );
    _data.clear();
    _event = null;
    return message;
  }
}
