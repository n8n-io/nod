import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../api/private_requests_repository.dart';
import '../../core/private_requests.dart';

class NodPrivateBrowser extends StatefulWidget {
  const NodPrivateBrowser({
    super.key,
    required this.repository,
    required this.turnId,
  });

  final NodPrivateRequestsRepository repository;
  final String turnId;

  @override
  State<NodPrivateBrowser> createState() => _NodPrivateBrowserState();
}

class _NodPrivateBrowserState extends State<NodPrivateBrowser>
    with WidgetsBindingObserver {
  StreamSubscription<ui.Image>? _frames;
  ui.Image? _image;
  final _text = TextEditingController();
  Future<void> _inputs = Future<void>.value();
  String? _error;
  bool _failedInput = false;
  bool _active = true;
  bool _done = false;
  bool _changing = false;
  int _generation = 0;
  Offset? _pointer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _connect();
  }

  Future<ui.Image> _decode(List<int> bytes) async {
    final codec = await ui.instantiateImageCodec(Uint8List.fromList(bytes));
    try {
      return (await codec.getNextFrame()).image;
    } finally {
      codec.dispose();
    }
  }

  Future<void> _connect() async {
    final generation = ++_generation;
    await _frames?.cancel();
    if (!mounted || !_active || generation != _generation) return;
    final transport = widget.repository.transport;
    if (transport is! NodPrivateBrowserTransport) {
      setState(
        () => _error =
            'This connection does not support the authenticated browser view.',
      );
      return;
    }
    setState(() {
      _error = null;
      _failedInput = false;
    });
    _frames = (transport as NodPrivateBrowserTransport)
        .browserHandoffFrames(widget.turnId)
        .asyncMap(_decode)
        .listen(
          (frame) {
            if (!mounted || !_active || generation != _generation) {
              frame.dispose();
              return;
            }
            final previous = _image;
            setState(() => _image = frame);
            previous?.dispose();
          },
          onError: (Object _) => _lostView(
            generation,
            'The browser view disconnected. Reconnect without repeating your last input.',
          ),
          onDone: () => _lostView(
            generation,
            'This browser view ended. Reconnect to check whether the handoff is still open.',
            cancelStream: false,
          ),
        );
  }

  void _lostView(int generation, String message, {bool cancelStream = true}) {
    if (!mounted || generation != _generation || _done) return;
    ++_generation;
    if (cancelStream) unawaited(_frames?.cancel());
    _text.clear();
    _pointer = null;
    setState(() {
      _failedInput = true;
      _error = message;
      _image?.dispose();
      _image = null;
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    if (!_active) {
      _generation++;
      _frames?.cancel();
      _text.clear();
      _image?.dispose();
      _image = null;
    } else {
      _connect();
    }
    if (mounted) setState(() {});
  }

  bool get _enabled =>
      _active &&
      _image != null &&
      _error == null &&
      !_done &&
      !_changing &&
      !_failedInput;

  void _enqueue(Future<void> Function() action) {
    if (!_enabled) return;
    final generation = _generation;
    _inputs = _inputs.then((_) async {
      if (!mounted ||
          !_active ||
          _failedInput ||
          _done ||
          generation != _generation) {
        return;
      }
      try {
        await action();
      } catch (_) {
        if (!mounted || generation != _generation) return;
        _failedInput = true;
        if (mounted) {
          setState(
            () => _error = 'That input was not confirmed and was not repeated. Check the page before trying again.',
          );
        }
      }
    });
  }

  Map<String, Object?> _mouse(String event, Offset point) => {
    'type': 'mouse',
    'event': event,
    'x': point.dx.clamp(0.0, 1.0),
    'y': point.dy.clamp(0.0, 1.0),
    'button': 'left',
  };

  void _key(String key) => _enqueue(
    () => widget.repository.browserInput(widget.turnId, [
      {'type': 'key', 'key': key},
    ]),
  );

  Future<void> _returnControl() async {
    if (!_enabled) return;
    final generation = _generation;
    setState(() => _changing = true);
    await _inputs;
    if (!mounted) return;
    if (_failedInput || !_active || generation != _generation) {
      setState(() => _changing = false);
      return;
    }
    try {
      await widget.repository.browserDone(widget.turnId);
      if (!mounted) return;
      _done = true;
      _text.clear();
      Navigator.of(context).pop();
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'Return was not confirmed. Reconnect to check the task before trying again.';
          _failedInput = true;
          _changing = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _generation++;
    _done = true;
    WidgetsBinding.instance.removeObserver(this);
    _frames?.cancel();
    _image?.dispose();
    _text.clear();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final image = _image;
    return Scaffold(
      appBar: AppBar(title: const Text('Browser')),
      body: Column(
        children: [
          const Padding(
            padding: EdgeInsets.all(12),
            child: Text(
              'You control Nod’s browser, not your phone’s browser. Return control when finished.',
            ),
          ),
          if (_error != null)
            Padding(padding: const EdgeInsets.all(12), child: Text(_error!)),
          Expanded(
            child: image == null
                ? Center(
                    child: _error == null && _active
                        ? const CircularProgressIndicator()
                        : const Icon(Icons.web_asset_off),
                  )
                : LayoutBuilder(
                    builder: (context, bounds) {
                      final scale = math.min(
                        bounds.maxWidth / image.width,
                        bounds.maxHeight / image.height,
                      );
                      final width = image.width * scale;
                      final height = image.height * scale;
                      Offset normalized(Offset offset) =>
                          Offset(offset.dx / width, offset.dy / height);
                      return Center(
                        child: SizedBox(
                          width: width,
                          height: height,
                          child: GestureDetector(
                            onTapUp: _enabled
                                ? (event) {
                                    final point = normalized(
                                      event.localPosition,
                                    );
                                    _enqueue(
                                      () => widget.repository.browserInput(
                                        widget.turnId,
                                        [
                                          _mouse('down', point),
                                          _mouse('up', point),
                                        ],
                                      ),
                                    );
                                  }
                                : null,
                            onPanStart: _enabled
                                ? (event) {
                                    final point = normalized(
                                      event.localPosition,
                                    );
                                    _pointer = point;
                                    _enqueue(
                                      () => widget.repository.browserInput(
                                        widget.turnId,
                                        [_mouse('down', point)],
                                      ),
                                    );
                                  }
                                : null,
                            onPanUpdate: _enabled
                                ? (event) {
                                    final point = normalized(
                                      event.localPosition,
                                    );
                                    _pointer = point;
                                    _enqueue(
                                      () => widget.repository.browserInput(
                                        widget.turnId,
                                        [_mouse('move', point)],
                                      ),
                                    );
                                  }
                                : null,
                            onPanEnd: _enabled
                                ? (_) {
                                    final point = _pointer;
                                    if (point != null) {
                                      _enqueue(
                                        () => widget.repository.browserInput(
                                          widget.turnId,
                                          [_mouse('up', point)],
                                        ),
                                      );
                                    }
                                    _pointer = null;
                                  }
                                : null,
                            onPanCancel: () {
                              final point = _pointer;
                              if (point != null) {
                                _enqueue(
                                  () => widget.repository.browserInput(
                                    widget.turnId,
                                    [_mouse('up', point)],
                                  ),
                                );
                              }
                              _pointer = null;
                            },
                            child: RawImage(image: image, fit: BoxFit.fill),
                          ),
                        ),
                      );
                    },
                  ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: TextField(
              controller: _text,
              enabled: _enabled,
              obscureText: true,
              enableSuggestions: false,
              autocorrect: false,
              decoration: InputDecoration(
                labelText: 'Type into the selected browser field',
                suffixIcon: IconButton(
                  tooltip: 'Send text to browser',
                  onPressed: _enabled
                      ? () {
                          final text = _text.text;
                          _text.clear();
                          if (text.isNotEmpty) {
                            _enqueue(
                              () => widget.repository.browserInput(
                                widget.turnId,
                                [
                                  {'type': 'text', 'text': text},
                                ],
                              ),
                            );
                          }
                        }
                      : null,
                  icon: const Icon(Icons.send),
                ),
              ),
            ),
          ),
          Wrap(
            alignment: WrapAlignment.center,
            children: [
              TextButton(
                onPressed: _enabled ? () => _key('Tab') : null,
                child: const Text('Tab'),
              ),
              TextButton(
                onPressed: _enabled ? () => _key('Enter') : null,
                child: const Text('Enter'),
              ),
              TextButton(
                onPressed: _enabled ? () => _key('BackSpace') : null,
                child: const Text('Backspace'),
              ),
              for (final delta in [-400, 400])
                IconButton(
                  tooltip: delta < 0 ? 'Scroll up' : 'Scroll down',
                  onPressed: _enabled
                      ? () => _enqueue(
                          () => widget.repository.browserInput(widget.turnId, [
                            {'type': 'wheel', 'deltaX': 0, 'deltaY': delta},
                          ]),
                        )
                      : null,
                  icon: Icon(
                    delta < 0 ? Icons.arrow_upward : Icons.arrow_downward,
                  ),
                ),
              for (final action in ['back', 'reload'])
                TextButton(
                  onPressed: _enabled
                      ? () => _enqueue(
                          () => widget.repository.browserNavigate(
                            widget.turnId,
                            action,
                          ),
                        )
                      : null,
                  child: Text(action == 'back' ? 'Back' : 'Reload'),
                ),
              TextButton(
                onPressed: _changing
                    ? null
                    : () async {
                        await _inputs;
                        if (mounted) await _connect();
                      },
                child: const Text('Reconnect view'),
              ),
              FilledButton(
                onPressed: _enabled ? _returnControl : null,
                child: const Text('Return to Nod'),
              ),
            ],
          ),
          SizedBox(height: MediaQuery.paddingOf(context).bottom),
        ],
      ),
    );
  }
}
