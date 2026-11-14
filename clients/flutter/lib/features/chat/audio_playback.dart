import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/attachments.dart';

abstract interface class AudioClipPlayer {
  Stream<bool> get playing;
  Stream<Duration> get positions;
  Stream<Duration?> get durations;
  Stream<bool> get completed;
  Future<void> open(String path);
  Future<void> play();
  Future<void> pause();
  Future<void> seek(Duration position);
  Future<void> dispose();
}

class NativeAudioClipPlayer implements AudioClipPlayer {
  final _player = AudioPlayer();
  @override
  Stream<bool> get playing => _player.playingStream;
  @override
  Stream<Duration> get positions => _player.positionStream;
  @override
  Stream<Duration?> get durations => _player.durationStream;
  @override
  Stream<bool> get completed => _player.processingStateStream.map(
    (state) => state == ProcessingState.completed,
  );
  @override
  Future<void> open(String path) async {
    await _player.setFilePath(path);
  }

  @override
  Future<void> play() => _player.play();
  @override
  Future<void> pause() => _player.pause();
  @override
  Future<void> seek(Duration position) => _player.seek(position);
  @override
  Future<void> dispose() => _player.dispose();
}

class AudioPlayback extends ChangeNotifier {
  AudioPlayback({
    required this.artifact,
    required this.repository,
    AudioClipPlayer Function()? playerFactory,
    Future<Directory> Function()? temporaryDirectory,
  }) : _playerFactory = playerFactory ?? NativeAudioClipPlayer.new,
       _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory;

  final NodArtifact artifact;
  final NodAttachmentsRepository repository;
  final AudioClipPlayer Function() _playerFactory;
  final Future<Directory> Function() _temporaryDirectory;
  static AudioPlayback? _active;
  static Future<void> pauseActive() async {
    await _active?.pause();
  }

  final _cancelled = Completer<void>();
  final _subscriptions = <StreamSubscription<Object?>>[];
  Directory? _directory;
  AudioClipPlayer? _player;
  Future<void>? _preparing;
  bool _disposed = false;
  bool _wantPlay = false;
  bool _ended = false;
  bool loading = false;
  bool playing = false;
  Duration position = Duration.zero;
  Duration? duration;
  String? error;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> _prepare() async {
    final root = await _temporaryDirectory();
    if (_disposed) return;
    _directory = await root.createTemp('nod-audio-');
    if (_disposed) return;
    final extension = switch (artifact.mimeType.split(';').first) {
      'audio/wav' || 'audio/x-wav' => 'wav',
      'audio/mpeg' => 'mp3',
      'audio/mp4' || 'audio/x-m4a' => 'm4a',
      'audio/aac' => 'aac',
      'audio/ogg' => 'ogg',
      'audio/flac' => 'flac',
      'audio/webm' => 'webm',
      _ => 'audio',
    };
    final file = File('${_directory!.path}/recording.$extension');
    await repository.downloadAttachment(
      artifact,
      file,
      cancelled: _cancelled.future,
    );
    if (_disposed) return;
    final player = _playerFactory();
    _player = player;
    _subscriptions.addAll([
      player.playing.listen((value) {
        playing = value;
        _notify();
      }),
      player.positions.listen((value) {
        position = value;
        _notify();
      }),
      player.durations.listen((value) {
        duration = value;
        _notify();
      }),
      player.completed.listen((value) {
        _ended = value;
        if (value) {
          playing = false;
          unawaited(pause());
        }
        _notify();
      }),
    ]);
    await player.open(file.path);
  }

  Future<void> prepare() async {
    if (_disposed || loading || _player != null) return;
    loading = true;
    error = null;
    _notify();
    try {
      final work = _prepare();
      _preparing = work;
      try {
        await work;
      } finally {
        _preparing = null;
      }
    } catch (_) {
      if (!_disposed) {
        error = 'Could not load this recording. Check your connection or try another audio format.';
        await _close();
      }
    } finally {
      loading = false;
      _notify();
    }
  }

  Future<void> toggle() async {
    if (_disposed || loading) return;
    if (playing) {
      await pause();
      return;
    }
    final previous = _active;
    _active = this;
    _wantPlay = true;
    try {
      if (previous != null && previous != this) await previous.pause();
      await prepare();
      if (_disposed || !_wantPlay || _active != this || _player == null) return;
      if (_ended) {
        await _player!.seek(Duration.zero);
        _ended = false;
      }
      unawaited(
        _player!.play().catchError((Object _) {
          if (!_disposed) {
            playing = false;
            error = 'Could not play this recording. Try again.';
            _notify();
          }
        }),
      );
    } catch (_) {
      if (!_disposed) {
        error = 'Could not play this recording. Try again.';
        _notify();
      }
    }
  }

  Future<void> pause() async {
    _wantPlay = false;
    try {
      await _player?.pause();
    } catch (_) {}
    playing = false;
    _notify();
  }

  Future<void> seek(Duration target) async {
    if (_disposed || loading || _player == null || duration == null) return;
    try {
      _ended = false;
      await _player!.seek(
        Duration(
          milliseconds: target.inMilliseconds.clamp(
            0,
            duration!.inMilliseconds,
          ),
        ),
      );
    } catch (_) {
      error = 'Could not move playback. Try again.';
      _notify();
    }
  }

  Future<void> _releasePlayer() async {
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
    _subscriptions.clear();
    final player = _player;
    _player = null;
    if (player != null) await player.dispose();
  }

  Future<void> _cleanup() async {
    final directory = _directory;
    _directory = null;
    if (directory != null && await directory.exists()) {
      await directory.delete(recursive: true);
    }
  }

  Future<void> _close() async {
    try {
      await _preparing;
    } catch (_) {}
    try {
      await _releasePlayer();
    } catch (_) {}
    try {
      await _cleanup();
    } catch (_) {}
  }

  @override
  void dispose() {
    _disposed = true;
    _wantPlay = false;
    if (_active == this) _active = null;
    _cancelled.complete();
    unawaited(_close());
    super.dispose();
  }
}
