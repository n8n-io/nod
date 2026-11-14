import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../../core/attachments.dart';

class VoiceDraft extends ChangeNotifier {
  VoiceDraft({
    AudioRecorder? recorder,
    Future<Directory> Function()? temporaryDirectory,
  }) : _recorder = recorder ?? AudioRecorder(),
       _temporaryDirectory = temporaryDirectory ?? getTemporaryDirectory;

  final Future<Directory> Function() _temporaryDirectory;
  Completer<void>? _operation;

  final AudioRecorder _recorder;
  Directory? _directory;
  Timer? _timer;
  bool recording = false;
  bool busy = false;
  bool _disposed = false;
  int seconds = 0;
  NodUploadFile? file;
  String? error;

  String get duration =>
      '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> start() async {
    if (busy || recording || file != null) return;
    busy = true;
    _operation = Completer<void>();
    error = null;
    _notify();
    try {
      if (!await _recorder.hasPermission()) {
        error = 'Microphone access is denied. Allow it in system settings, then try again.';
        return;
      }
      if (_disposed) return;
      await _cleanup();
      _directory = await (await _temporaryDirectory()).createTemp('nod-voice-');
      if (_disposed) return;
      await _recorder.start(
        const RecordConfig(
          encoder: AudioEncoder.wav,
          sampleRate: 16000,
          numChannels: 1,
        ),
        path: '${_directory!.path}/voice.wav',
      );
      if (_disposed) {
        await _recorder.cancel();
        return;
      }
      seconds = 0;
      recording = true;
      _timer = Timer.periodic(const Duration(seconds: 1), (_) {
        seconds++;
        if (seconds >= 300) unawaited(stop());
        _notify();
      });
    } catch (_) {
      error = 'Could not start recording. Check your microphone and try again.';
    } finally {
      busy = false;
      try {
        if (!recording) await _cleanup();
      } catch (_) {
        error = 'Could not remove temporary recording. Try again.';
      } finally {
        _operation?.complete();
        _notify();
      }
    }
  }

  Future<void> suspend() async {
    await _operation?.future;
    if (!_disposed) await stop();
  }

  Future<void> stop() async {
    if (busy || !recording) return;
    busy = true;
    _timer?.cancel();
    _notify();
    try {
      final path = await _recorder.stop();
      if (path == null) throw StateError('No recording');
      final size = await File(path).length();
      if (size <= 44 || size > 25 * 1024 * 1024) {
        throw StateError('Invalid recording');
      }
      file = NodUploadFile(
        path: path,
        name: 'voice.wav',
        size: size,
        mimeType: 'audio/wav',
      );
    } catch (_) {
      error = 'Could not save recording. Please record again.';
    } finally {
      recording = false;
      busy = false;
      _notify();
    }
  }

  Future<void> discard() async {
    if (busy) return;
    busy = true;
    _timer?.cancel();
    try {
      if (recording) await _recorder.cancel();
      await _cleanup();
      file = null;
      seconds = 0;
      error = null;
    } catch (_) {
      error = 'Could not discard recording. Try again.';
    } finally {
      recording = false;
      busy = false;
      _notify();
    }
  }

  Future<void> _cleanup() async {
    final directory = _directory;
    if (directory != null && await directory.exists()) {
      await directory.delete(recursive: true);
    }
    _directory = null;
  }

  Future<void> _close() async {
    try {
      await _operation?.future;
      await _recorder.dispose();
      await _cleanup();
    } catch (_) {}
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    unawaited(_close());
    super.dispose();
  }
}
