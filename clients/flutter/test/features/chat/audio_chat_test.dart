import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/core/attachments.dart';
import 'package:nod_client/core/audio.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/design_system/design_system.dart';
import 'package:nod_client/features/chat/audio_message.dart';
import 'package:nod_client/features/chat/audio_playback.dart';
import 'package:nod_client/features/chat/chat_controller.dart';
import 'package:nod_client/features/chat/chat_view.dart';
import 'package:nod_client/features/chat/fakes/fake_nod_repository.dart';
import 'package:nod_client/features/chat/voice_draft.dart';
import 'package:nod_client/features/results/artifact_preview.dart';

class AudioRepository implements NodRepository, NodAudioRepository {
  final backend = FakeNodRepository();
  final ids = <String>[];
  bool fail = false;
  Object? sendError;
  @override
  Stream<NodConnectionState> get connectionStates => backend.connectionStates;
  @override
  Stream<NodEvent> get events => backend.events;
  @override
  Future<NodHistory> loadHistory({String? cursor}) =>
      backend.loadHistory(cursor: cursor);
  @override
  Future<NodState> loadState() => backend.loadState();
  @override
  Future<void> sendAudio(
    String text,
    NodUploadFile recording, {
    required String clientMessageId,
    List<NodArtifact> attachments = const [],
  }) async {
    ids.add(clientMessageId);
    if (sendError != null) throw sendError!;
    if (fail) throw const NodTimeoutException();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class ClipPlayer implements AudioClipPlayer {
  final playingEvents = StreamController<bool>.broadcast(sync: true);
  final positionEvents = StreamController<Duration>.broadcast(sync: true);
  final durationEvents = StreamController<Duration?>.broadcast(sync: true);
  final completedEvents = StreamController<bool>.broadcast(sync: true);
  String? path;
  bool disposed = false;
  int plays = 0;
  int pauses = 0;
  Duration? lastSeek;
  @override
  Stream<bool> get playing => playingEvents.stream;
  @override
  Stream<Duration> get positions => positionEvents.stream;
  @override
  Stream<Duration?> get durations => durationEvents.stream;
  @override
  Stream<bool> get completed => completedEvents.stream;
  @override
  Future<void> open(String value) async {
    path = value;
    durationEvents.add(const Duration(seconds: 12));
  }

  @override
  Future<void> play() async {
    plays++;
    playingEvents.add(true);
  }

  @override
  Future<void> pause() async {
    pauses++;
    playingEvents.add(false);
  }

  @override
  Future<void> seek(Duration value) async {
    lastSeek = value;
    positionEvents.add(value);
  }

  @override
  Future<void> dispose() async {
    disposed = true;
    await playingEvents.close();
    await positionEvents.close();
    await durationEvents.close();
    await completedEvents.close();
  }
}

class ClipRepository implements NodAttachmentsRepository {
  int downloads = 0;
  bool fail = false;
  Completer<void>? gate;
  File? destination;
  String? content;
  @override
  Future<void> downloadAttachment(
    NodArtifact artifact,
    File file, {
    required Future<void> cancelled,
  }) async {
    downloads++;
    destination = file;
    await gate?.future;
    if (fail) throw StateError('synthetic download failure');
    if (content != null) {
      await file.writeAsString(content!);
    } else {
      await file.writeAsBytes(List<int>.filled(100, 0));
    }
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
        const MethodChannel('com.llfbandit.record/messages'),
        (_) async => null,
      );
  for (final format in ['text/html', 'image/svg+xml', 'application/xml']) {
    testWidgets(
      'active $format artifact stays literal without image or web execution',
      (tester) async {
        final root = await tester.runAsync(
          () => Directory.systemTemp.createTemp('nod-active-preview-'),
        );
        addTearDown(() async {
          if (await root!.exists()) await root.delete(recursive: true);
        });
        const active =
            '<svg onload="fetch(\'https://example.com/beacon\')"><script>alert(document.cookie)</script></svg>';
        final repository = ClipRepository()..content = active;
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: NodArtifactPreview(
                artifact: NodArtifact(
                  id: 'synthetic',
                  name: 'active.html',
                  mimeType: format,
                  size: active.length,
                ),
                repository: repository,
                temporaryDirectory: () async => root!,
              ),
            ),
          ),
        );
        for (
          var attempt = 0;
          attempt < 10 && find.text(active).evaluate().isEmpty;
          attempt++
        ) {
          await tester.pump();
          await tester.runAsync(() async {
            await Future<void>.delayed(const Duration(milliseconds: 20));
          });
        }
        await tester.pump();
        expect(
          find.text(active),
          findsOneWidget,
          reason: tester
              .widgetList<Text>(find.byType(Text))
              .map((w) => w.data)
              .join(' | '),
        );
        expect(find.byType(Image), findsNothing);
        expect(find.text('Open or save'), findsOneWidget);
        expect(repository.downloads, 1);
        final path = repository.destination!;
        await tester.pumpWidget(const SizedBox.shrink());
        for (
          var attempt = 0;
          attempt < 10 && await tester.runAsync(path.exists) == true;
          attempt++
        ) {
          await tester.pump();
          await tester.runAsync(() async {
            await Future<void>.delayed(const Duration(milliseconds: 20));
          });
        }
        expect(await tester.runAsync(path.exists), false);
      },
    );
  }

  const file = NodUploadFile(
    path: '/synthetic/voice.wav',
    name: 'voice.wav',
    size: 100,
    mimeType: 'audio/wav',
  );
  test(
    'audio retries reuse identity, changed recordings get new identity',
    () async {
      final repository = AudioRepository()..fail = true;
      final controller = ChatController(repository);
      addTearDown(() async {
        controller.dispose();
        await repository.backend.dispose();
      });
      await controller.start();
      expect(await controller.sendText('', recording: file), false);
      expect(await controller.sendText('', recording: file), false);
      expect(repository.ids[0], repository.ids[1]);
      const changed = NodUploadFile(
        path: '/synthetic/other.wav',
        name: 'voice.wav',
        size: 100,
        mimeType: 'audio/wav',
      );
      repository.fail = false;
      expect(await controller.sendText('', recording: changed), true);
      expect(repository.ids.last, isNot(repository.ids.first));
    },
  );
  testWidgets(
    'Send keeps recording and caption on setup error and clears them only after success',
    (tester) async {
      final repository = AudioRepository()
        ..sendError = const NodAudioException(NodAudioFailure.setup);
      final draft = VoiceDraft()
        ..file = file
        ..seconds = 12;
      addTearDown(repository.backend.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: NodTheme.light,
          home: Scaffold(
            body: NodChat(repository: repository, voiceDraft: draft),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('chat-composer')),
        'Synthetic caption',
      );
      await tester.tap(find.byKey(const Key('chat-send')));
      await tester.pumpAndSettle();
      expect(repository.ids.length, 1);
      expect(draft.file, same(file));
      expect(find.text('Synthetic caption'), findsOneWidget);
      expect(find.text('Couldn’t send voice message'), findsOneWidget);
      expect(
        find.text(const NodAudioException(NodAudioFailure.setup).message),
        findsOneWidget,
      );
      expect(find.byKey(const Key('chat-retry')), findsNothing);
      repository.sendError = null;
      await tester.tap(find.byKey(const Key('chat-send')));
      await tester.pumpAndSettle();
      expect(repository.ids.length, 2);
      expect(repository.ids.first, repository.ids.last);
      expect(draft.file, isNull);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('chat-composer')))
            .controller!
            .text,
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  test('explicit server retry permission uses a new audio identity without automatically retrying', () async {
    final repository = AudioRepository()
      ..sendError = const NodAudioException(
        NodAudioFailure.transcription,
        retryable: true,
      );
    final controller = ChatController(repository);
    addTearDown(() async {
      controller.dispose();
      await repository.backend.dispose();
    });
    await controller.start();
    expect(await controller.sendText('', recording: file), false);
    expect(repository.ids.length, 1);
    repository.sendError = null;
    expect(await controller.sendText('', recording: file), true);
    expect(repository.ids.length, 2);
    expect(repository.ids.first, isNot(repository.ids.last));
  });

  const clip = NodArtifact(
    id: 'synthetic-audio',
    name: '../../voice.wav',
    mimeType: 'audio/wav',
    size: 100,
  );

  test('preparing loads duration silently, pauses other clips only on play, and reuses the download', () async {
    final root = await Directory.systemTemp.createTemp('nod-playback-test-');
    final repository = ClipRepository();
    final player = ClipPlayer();
    final otherPlayer = ClipPlayer();
    final playback = AudioPlayback(
      artifact: clip,
      repository: repository,
      playerFactory: () => player,
      temporaryDirectory: () async => root,
    );
    final other = AudioPlayback(
      artifact: clip,
      repository: repository,
      playerFactory: () => otherPlayer,
      temporaryDirectory: () async => root,
    );
    expect(repository.downloads, 0);
    await playback.prepare();
    await playback.prepare();
    expect(repository.downloads, 1);
    expect(player.path, endsWith('/recording.wav'));
    expect(playback.duration, const Duration(seconds: 12));
    expect(playback.playing, false);
    expect(player.plays, 0);
    await playback.toggle();
    expect(playback.playing, true);
    await other.prepare();
    expect(playback.playing, true);
    expect(other.playing, false);
    expect(otherPlayer.plays, 0);
    await playback.seek(const Duration(seconds: 4));
    expect(playback.position, const Duration(seconds: 4));
    await playback.toggle();
    expect(playback.playing, false);
    await playback.toggle();
    expect(repository.downloads, 2);
    await other.toggle();
    expect(playback.playing, false);
    expect(other.playing, true);
    otherPlayer.completedEvents.add(true);
    await Future<void>.delayed(Duration.zero);
    await other.toggle();
    expect(otherPlayer.lastSeek, Duration.zero);
    expect(repository.downloads, 2);
    playback.dispose();
    other.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(player.disposed, true);
    expect(otherPlayer.disposed, true);
    expect(await root.list().isEmpty, true);
    await root.delete(recursive: true);
  });

  test(
    'leaving during download prevents late playback and removes the local clip',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'nod-playback-cancel-',
      );
      final repository = ClipRepository()..gate = Completer<void>();
      final player = ClipPlayer();
      final playback = AudioPlayback(
        artifact: clip,
        repository: repository,
        playerFactory: () => player,
        temporaryDirectory: () async => root,
      );
      final pending = playback.prepare();
      while (repository.downloads == 0) {
        await Future<void>.delayed(Duration.zero);
      }
      await playback.pause();
      playback.dispose();
      repository.gate!.complete();
      await pending;
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(player.plays, 0);
      expect(await root.list().isEmpty, true);
      await root.delete(recursive: true);
    },
  );

  test('failed download can retry without retaining partial files', () async {
    final root = await Directory.systemTemp.createTemp('nod-playback-retry-');
    final repository = ClipRepository()..fail = true;
    final player = ClipPlayer();
    final playback = AudioPlayback(
      artifact: clip,
      repository: repository,
      playerFactory: () => player,
      temporaryDirectory: () async => root,
    );
    await playback.prepare();
    expect(playback.error, isNotNull);
    expect(await root.list().isEmpty, true);
    repository.fail = false;
    await playback.toggle();
    expect(playback.playing, true);
    expect(playback.error, isNull);
    playback.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 30));
    await root.delete(recursive: true);
  });

  testWidgets(
    'voice player exposes play pause duration seek and pauses when inactive',
    (tester) async {
      final root = await tester.runAsync(
        () => Directory.systemTemp.createTemp('nod-audio-widget-'),
      );
      final player = ClipPlayer();
      final playback = AudioPlayback(
        artifact: clip,
        repository: ClipRepository(),
        playerFactory: () => player,
        temporaryDirectory: () async => root!,
      );
      Widget mount(bool active) => MaterialApp(
        theme: NodTheme.light,
        home: Scaffold(
          body: Center(
            child: AudioMessage(
              artifact: clip,
              repository: ClipRepository(),
              playback: playback,
              active: active,
            ),
          ),
        ),
      );
      await tester.pumpWidget(mount(true));
      for (var attempt = 0; attempt < 20 && playback.loading; attempt++) {
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        });
        await tester.pump();
      }
      await tester.pumpAndSettle();
      expect(find.byTooltip('Play voice message'), findsOneWidget);
      expect(find.text('0:00 / 0:12'), findsOneWidget);
      expect(player.plays, 0);
      await tester.runAsync(playback.toggle);
      await tester.pumpAndSettle();
      expect(find.byTooltip('Pause voice message'), findsOneWidget);
      await tester.tap(find.byTooltip('Pause voice message'));
      await tester.pumpAndSettle();
      expect(playback.playing, false);
      await tester.runAsync(playback.toggle);
      await tester.pumpWidget(mount(false));
      await tester.pumpAndSettle();
      expect(playback.playing, false);
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 30));
        await root!.delete(recursive: true);
      });
    },
  );

  testWidgets(
    'audio history renders an inline player instead of a file button',
    (tester) async {
      final backend = FakeNodRepository(
        history: NodHistory(
          messages: [
            NodMessage(
              id: 'voice-history',
              role: NodMessageRole.owner,
              text: '',
              createdAt: DateTime(2026, 11, 9),
              attachments: [clip],
            ),
          ],
        ),
      );
      addTearDown(backend.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: NodTheme.light,
          home: Scaffold(body: NodChat(repository: backend)),
        ),
      );
      await tester.pump();
      expect(find.byType(AudioMessage), findsOneWidget);
      expect(find.textContaining('voice.wav'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final brightness in Brightness.values) {
    for (final state in ['idle', 'recording', 'ready']) {
      testWidgets('audio composer $state ${brightness.name}', (tester) async {
        final repository = AudioRepository();
        final draft = VoiceDraft()
          ..file = state == 'ready' ? file : null
          ..recording = state == 'recording'
          ..seconds = 12;
        addTearDown(repository.backend.dispose);
        await tester.binding.setSurfaceSize(const Size(390, 844));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            theme: brightness == Brightness.light
                ? NodTheme.light
                : NodTheme.dark,
            home: Scaffold(
              body: NodChat(repository: repository, voiceDraft: draft),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Record a voice message'), findsNothing);
        if (state == 'idle') {
          expect(find.byTooltip('Record voice message'), findsOneWidget);
          final mic = tester.getRect(find.byKey(const Key('chat-record')));
          final input = tester.getRect(find.byKey(const Key('chat-composer')));
          expect(input.contains(mic.center), true);
          expect(find.byTooltip('Discard recording'), findsNothing);
        } else if (state == 'recording') {
          expect(find.text('Recording 0:12'), findsOneWidget);
          expect(find.byTooltip('Stop recording'), findsOneWidget);
          expect(
            tester
                .widget<IconButton>(find.byKey(const Key('chat-send')))
                .onPressed,
            null,
          );
          expect(find.byKey(const Key('chat-composer')), findsNothing);
        } else {
          expect(find.text('Voice message · 0:12'), findsOneWidget);
          expect(find.byTooltip('Discard recording'), findsOneWidget);
          expect(find.byTooltip('Record voice message'), findsNothing);
          expect(find.text('Add a message…'), findsOneWidget);
        }
        expect(tester.takeException(), null);
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(
            'goldens/audio_composer_${state}_${brightness.name}.png',
          ),
        );
      });
    }
  }
  for (final brightness in Brightness.values) {
    testWidgets('inline voice player preview ${brightness.name}', (
      tester,
    ) async {
      var directory = File(Platform.resolvedExecutable).parent;
      for (var index = 0; index < 8; index++) {
        final font = File(
          '${directory.path}/artifacts/material_fonts/Roboto-Regular.ttf',
        );
        if (font.existsSync()) {
          await (FontLoader('Roboto')..addFont(
                Future.value(ByteData.sublistView(font.readAsBytesSync())),
              ))
              .load();
          break;
        }
        directory = directory.parent;
      }
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
      final root = await tester.runAsync(
        () => Directory.systemTemp.createTemp('nod-audio-preview-'),
      );
      final repository = ClipRepository();
      final playback = AudioPlayback(
        artifact: clip,
        repository: repository,
        playerFactory: ClipPlayer.new,
        temporaryDirectory: () async => root!,
      );
      await tester.runAsync(() async {
        await playback.toggle();
        await playback.pause();
        await playback.seek(const Duration(seconds: 4));
      });
      await tester.binding.setSurfaceSize(const Size(390, 320));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final theme = brightness == Brightness.light
          ? NodTheme.light
          : NodTheme.dark;
      await tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: Scaffold(
            body: Center(
              child: Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: theme.colorScheme.primaryContainer,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: AudioMessage(
                  artifact: clip,
                  repository: repository,
                  playback: playback,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(Scaffold),
        matchesGoldenFile('goldens/audio_player_${brightness.name}.png'),
      );
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 30));
        await root!.delete(recursive: true);
      });
    });
  }
}
