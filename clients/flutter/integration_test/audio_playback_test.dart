import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:just_audio/just_audio.dart';
import 'package:nod_client/core/attachments.dart';
import 'package:nod_client/design_system/design_system.dart';
import 'package:nod_client/features/chat/audio_message.dart';
import 'package:nod_client/features/chat/audio_playback.dart';
import 'package:path_provider/path_provider.dart';

class LocalClipRepository implements NodAttachmentsRepository {
  LocalClipRepository(this.file);

  final File file;
  int downloads = 0;

  @override
  Future<void> downloadAttachment(
    NodArtifact artifact,
    File destination, {
    required Future<void> cancelled,
  }) async {
    downloads++;
    await file.copy(destination.path);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'voice bubble loads native duration before play and native playback supports pause and seek',
    (tester) async {
      final root = await (await getTemporaryDirectory()).createTemp(
        'nod-native-audio-test-',
      );
      final player = AudioPlayer();
      try {
        const rate = 16000;
        const samples = rate * 2;
        final bytes = ByteData(44 + samples * 2);
        void ascii(int offset, String text) {
          for (var index = 0; index < text.length; index++) {
            bytes.setUint8(offset + index, text.codeUnitAt(index));
          }
        }

        ascii(0, 'RIFF');
        bytes.setUint32(4, bytes.lengthInBytes - 8, Endian.little);
        ascii(8, 'WAVE');
        ascii(12, 'fmt ');
        bytes.setUint32(16, 16, Endian.little);
        bytes.setUint16(20, 1, Endian.little);
        bytes.setUint16(22, 1, Endian.little);
        bytes.setUint32(24, rate, Endian.little);
        bytes.setUint32(28, rate * 2, Endian.little);
        bytes.setUint16(32, 2, Endian.little);
        bytes.setUint16(34, 16, Endian.little);
        ascii(36, 'data');
        bytes.setUint32(40, samples * 2, Endian.little);
        for (var index = 0; index < samples; index++) {
          bytes.setInt16(
            44 + index * 2,
            (math.sin(index * 2 * math.pi * 440 / rate) * 1000).round(),
            Endian.little,
          );
        }
        final file = await File('${root.path}/synthetic.wav')
            .writeAsBytes(bytes.buffer.asUint8List());
        final repository = LocalClipRepository(file);
        final artifact = NodArtifact(
          id: 'synthetic-audio',
          name: 'synthetic.wav',
          mimeType: 'audio/wav',
          size: bytes.lengthInBytes,
        );
        final playback = AudioPlayback(
          artifact: artifact,
          repository: repository,
          temporaryDirectory: () async => root,
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: NodTheme.light,
            home: Scaffold(
              body: AudioMessage(
                artifact: artifact,
                repository: repository,
                playback: playback,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle(const Duration(milliseconds: 100));
        expect(playback.error, isNull);
        expect(playback.duration!.inMilliseconds, closeTo(2000, 100));
        expect(playback.playing, false);
        expect(playback.position, Duration.zero);
        expect(repository.downloads, 1);
        expect(find.text('0:00 / 0:02'), findsOneWidget);
        expect(find.byTooltip('Play voice message'), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
        final duration = await player.setFilePath(file.path);
        expect(duration!.inMilliseconds, closeTo(2000, 100));
        await player.setVolume(0);
        final finished = player.play();
        await Future<void>.delayed(const Duration(milliseconds: 200));
        expect(player.playing, true);
        await player.pause();
        await finished;
        expect(player.playing, false);
        await player.seek(const Duration(seconds: 1));
        expect(player.position.inMilliseconds, closeTo(1000, 100));
      } finally {
        await tester.pumpWidget(const SizedBox());
        await player.dispose();
        await root.delete(recursive: true);
      }
    },
  );
}
