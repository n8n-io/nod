import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../../api/settings_repository.dart';
import '../../core/nod_errors.dart';
import '../chat/audio_playback.dart';

Future<void> shareMemoryMarkdown(
  NodSettingsRepository repository, {
  required Future<void> Function(File file) share,
  required bool Function() isActive,
  Future<Directory> Function()? temporaryDirectory,
}) async {
  final generation = repository.connectionGeneration;
  bool current() => isActive() && generation == repository.connectionGeneration;
  Directory? directory;
  try {
    final response = await repository.exportMemory();
    if (!current()) return;
    final root = await (temporaryDirectory ?? getTemporaryDirectory)();
    directory = await root.createTemp('nod-memory-');
    if (!current()) return;
    final file = File('${directory.path}/nod-memory.md');
    await file.writeAsBytes(response.bytes, flush: true);
    if (!current()) return;
    await share(file);
  } finally {
    if (directory != null) await directory.delete(recursive: true);
  }
}

class SettingsVoicePreview extends ChangeNotifier {
  SettingsVoicePreview({
    required this.repository,
    AudioClipPlayer Function()? playerFactory,
    Future<Directory> Function()? temporaryDirectory,
  }) : _playerFactory = playerFactory ?? NativeAudioClipPlayer.new,
       _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory;

  final NodSettingsRepository repository;
  final AudioClipPlayer Function() _playerFactory;
  final Future<Directory> Function() _temporaryDirectory;
  static SettingsVoicePreview? _active;
  static bool _switching = false;
  AudioClipPlayer? _player;
  Directory? _directory;
  StreamSubscription<bool>? _completion;
  Timer? _scopeTimer;
  Future<void>? _work;
  Future<void>? _stopping;
  bool _disposed = false;
  int _epoch = 0;
  bool loading = false;
  bool playing = false;
  String? error;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> start(String? voice, String locale) async {
    if (_disposed || loading || playing || _stopping != null || _switching) {
      return;
    }
    _switching = true;
    try {
      final previous = _active;
      if (previous != null && previous != this) {
        await previous.stop();
        if (previous._work != null) {
          error = 'The previous preview request is still finishing. Wait before starting another.';
          _notify();
          return;
        }
      }
    } finally {
      _switching = false;
    }
    if (_disposed || loading || playing || _stopping != null) return;
    _active = this;
    final epoch = ++_epoch;
    final generation = repository.connectionGeneration;
    bool current() =>
        !_disposed &&
        epoch == _epoch &&
        generation == repository.connectionGeneration;
    loading = true;
    error = null;
    _notify();
    _scopeTimer = Timer.periodic(const Duration(milliseconds: 100), (_) {
      if (!current()) unawaited(stop());
    });
    final work = _prepare(voice, locale, current);
    _work = work;
    try {
      await work;
    } catch (_) {
      if (current()) {
        error = 'Could not play the preview. It was not retried. Select Preview voice to make a new request.';
      }
      await _clear();
    } finally {
      _work = null;
      loading = false;
      if (!playing) {
        _scopeTimer?.cancel();
        _scopeTimer = null;
        if (_active == this) _active = null;
      }
      _notify();
    }
  }

  Future<void> _prepare(
    String? voice,
    String locale,
    bool Function() current,
  ) async {
    final response = await repository.previewVoice(voice, locale);
    if (!current()) return;
    final root = await _temporaryDirectory();
    if (!current()) return;
    final directory = await root.createTemp('nod-voice-');
    _directory = directory;
    if (!current()) {
      await _clear();
      return;
    }
    final extension = switch (response.mimeType) {
      'audio/mpeg' => 'mp3',
      'audio/wav' || 'audio/x-wav' => 'wav',
      'audio/mp4' || 'audio/x-m4a' => 'm4a',
      'audio/aac' => 'aac',
      'audio/ogg' => 'ogg',
      'audio/flac' => 'flac',
      'audio/webm' => 'webm',
      _ => throw const NodProtocolException(),
    };
    final file = File('${directory.path}/preview.$extension');
    await file.writeAsBytes(response.bytes, flush: true);
    if (!current()) return;
    final player = _playerFactory();
    _player = player;
    _completion = player.completed.listen((done) {
      if (done && current()) unawaited(stop());
    });
    await player.open(file.path);
    if (!current()) return;
    playing = true;
    unawaited(
      player.play().catchError((Object _) async {
        if (current()) {
          error = 'Could not play the preview. It was not retried.';
          await stop();
        }
      }),
    );
  }

  Future<void> stop() =>
      _stopping ??= _stop().whenComplete(() => _stopping = null);

  Future<void> _stop() async {
    ++_epoch;
    _scopeTimer?.cancel();
    _scopeTimer = null;
    playing = false;
    try {
      await _player?.pause();
    } catch (_) {}
    await _clear();
    if (_work == null && _active == this) _active = null;
    _notify();
  }

  Future<void> _clear() async {
    final completion = _completion;
    _completion = null;
    await completion?.cancel();
    final player = _player;
    _player = null;
    try {
      await player?.dispose();
    } catch (_) {}
    final directory = _directory;
    _directory = null;
    if (directory != null && await directory.exists()) {
      await directory.delete(recursive: true);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(stop());
    super.dispose();
  }
}
