import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/features/chat/voice_draft.dart';
import 'package:record/record.dart';

class Recorder extends AudioRecorder {
  bool allowed = true;
  int starts = 0;
  int cancels = 0;
  String? path;
  @override
  Future<bool> hasPermission({bool request = true}) async => allowed;
  @override
  Future<void> start(RecordConfig config, {required String path}) async {
    starts++;
    this.path = path;
    expect(config.encoder, AudioEncoder.wav);
    expect(config.sampleRate, 16000);
    expect(config.numChannels, 1);
    await File(path).writeAsBytes(List.filled(100, 0));
  }

  @override
  Future<String?> stop() async => path;
  @override
  Future<void> cancel() async {
    cancels++;
  }

  @override
  Future<void> dispose() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
        const MethodChannel('com.llfbandit.record/messages'),
        (_) async => null,
      );
  late Directory directory;
  late Recorder recorder;
  late VoiceDraft draft;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('nod-test-');
    recorder = Recorder();
    draft = VoiceDraft(
      recorder: recorder,
      temporaryDirectory: () async => directory,
    );
  });
  tearDown(() async {
    draft.dispose();
    await Future<void>.delayed(Duration.zero);
    if (await directory.exists()) await directory.delete(recursive: true);
  });
  test('permission denied does not open microphone', () async {
    recorder.allowed = false;
    await draft.start();
    expect(draft.error, contains('Microphone access'));
    expect(recorder.starts, 0);
    expect(draft.busy, false);
  });
  test(
    'stop keeps a sendable WAV, discard deletes the temporary recording',
    () async {
      await draft.start();
      await draft.start();
      expect(recorder.starts, 1);
      expect(draft.recording, true);
      await draft.stop();
      expect(draft.recording, false);
      expect(draft.file!.mimeType, 'audio/wav');
      expect(draft.file!.size, 100);
      final path = draft.file!.path;
      await draft.discard();
      expect(draft.file, null);
      expect(await File(path).exists(), false);
    },
  );
  test('discard during recording cancels capture', () async {
    await draft.start();
    await draft.discard();
    expect(recorder.cancels, 1);
    expect(draft.recording, false);
    expect(draft.file, null);
  });
  test('five minute limit stops capture and retains the draft', () async {
    await draft.start();
    draft.seconds = 299;
    await Future<void>.delayed(const Duration(milliseconds: 1100));
    expect(draft.recording, false);
    expect(draft.file, isNotNull);
    expect(draft.duration, '5:00');
  });
}
