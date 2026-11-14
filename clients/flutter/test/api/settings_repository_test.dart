import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:nod_client/api/http_nod_repository.dart';
import 'package:nod_client/api/settings_repository.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/settings.dart';
import 'package:nod_client/features/chat/audio_playback.dart';
import 'package:nod_client/features/settings/memory_settings_page.dart';
import 'package:nod_client/features/settings/settings_media.dart';
import 'package:nod_client/features/settings/settings_page.dart';
import 'package:nod_client/features/settings/settings_widgets.dart';

import 'http_nod_repository_test.dart' as fixture;

void main() {
  late HttpNodRepository transport;
  late NodSettingsRepository repository;
  final requests = <({String method, String path, Object? body})>[];
  var status = 200;
  List<int>? binaryBytes;
  var binaryMime = 'audio/mpeg';
  Completer<void>? binaryGate;
  Object? response = <String, Object?>{};
  setUp(() async {
    status = 200;
    binaryBytes = null;
    binaryMime = 'audio/mpeg';
    binaryGate = null;
    response = <String, Object?>{};
    requests.clear();
    final events = fixture.EventConnection();
    transport = HttpNodRepository(
      credentials: fixture.MemoryCredentials(),
      eventClientFactory: () => events.client,
      client: fixture.RoutingClient((request) async {
        expect(request.url.origin, 'https://nod.example.test');
        expect(request.headers['Origin'], 'https://nod.example.test');
        expect(
          request.headers['Authorization'],
          'Bearer synthetic-settings-token',
        );
        if (request.url.path == '/api/client/capabilities') {
          return _json(200, {
            'contractVersion': 1,
            'authentication': {'mode': 'bearer'},
          });
        }
        if (request.url.path == '/api/session') {
          return _json(200, {
            'user': {'id': 'synthetic-owner'},
            'settings': {
              'theme': 'system',
              'usageData': false,
              'traces': false,
            },
            'capabilities': {'traces': true},
          });
        }
        if (request.url.path == '/api/state') {
          return _json(200, {
            'threadId': 'synthetic-thread',
            'revision': '1',
            'messages': <Object?>[],
            'turns': <Object?>[],
            'configuration': {'conversationResetEnabled': true},
          });
        }
        final bytes = await request.finalize().toBytes();
        requests.add((
          method: request.method,
          path: request.url.path,
          body: bytes.isEmpty ? null : jsonDecode(utf8.decode(bytes)),
        ));
        if (request.url.path == '/api/speech/preview' ||
            request.url.path == '/api/memory/export') {
          expect(request.followRedirects, isFalse);
          await binaryGate?.future;
          if (binaryBytes != null) {
            return http.StreamedResponse(
              Stream.value(binaryBytes!),
              status,
              headers: {
                'content-type': binaryMime,
                'content-disposition':
                    'attachment; filename="../../outside.html"',
              },
            );
          }
        }
        return _json(status, response);
      }),
    );
    await transport.connect(
      NodConnectionConfig(
        origin: Uri.parse('https://nod.example.test'),
        token: 'synthetic-settings-token',
      ),
    );
    repository = NodSettingsRepository(transport);
  });
  tearDown(() async => transport.dispose());

  test('binary routes preserve exact bytes and reject MIME, size and server errors without retry', () async {
    binaryBytes = [0, 255, 19, 7];
    expect(
      (await repository.previewVoice('synthetic-voice', 'pt-BR')).bytes,
      binaryBytes,
    );
    expect(
      requests.single,
      _request('POST', '/api/speech/preview', {
        'voice': 'synthetic-voice',
        'locale': 'pt-BR',
      }),
    );
    binaryMime = 'text/markdown; charset=utf-8';
    binaryBytes = utf8.encode('# Synthetic memory\r\n- Short replies\n');
    expect((await repository.exportMemory()).bytes, binaryBytes);
    expect(requests.last, _request('GET', '/api/memory/export', null));
    binaryMime = 'text/html';
    await expectLater(
      repository.exportMemory(),
      throwsA(isA<NodProtocolException>()),
    );
    binaryMime = 'text/markdown';
    binaryBytes = [];
    await expectLater(
      repository.exportMemory(),
      throwsA(isA<NodProtocolException>()),
    );
    binaryBytes = List.filled(16 * 1024 * 1024 + 1, 1);
    await expectLater(
      repository.exportMemory(),
      throwsA(isA<NodProtocolException>()),
    );
    binaryBytes = null;
    status = 409;
    await expectLater(
      repository.previewVoice(null, 'en'),
      throwsA(isA<NodConflictException>()),
    );
    status = 401;
    await expectLater(
      repository.exportMemory(),
      throwsA(isA<NodUnauthorizedException>()),
    );
    expect(requests.length, 7);
  });

  test('Markdown share fixes the path and removes temporary bytes on return, cancellation and failure', () async {
    binaryBytes = utf8.encode('# Synthetic memory\r\n- Short replies\n');
    binaryMime = 'text/markdown';
    final root = await Directory.systemTemp.createTemp('nod-export-test-');
    addTearDown(() => root.delete(recursive: true));
    for (final throws in [false, true]) {
      File? copy;
      final work = shareMemoryMarkdown(
        repository,
        temporaryDirectory: () async => root,
        isActive: () => true,
        share: (file) async {
          copy = file;
          expect(file.uri.pathSegments.last, 'nod-memory.md');
          expect(await file.readAsBytes(), binaryBytes);
          if (throws) throw StateError('Synthetic share failure');
        },
      );
      if (throws) {
        await expectLater(work, throwsStateError);
      } else {
        await work;
      }
      expect(await copy!.exists(), isFalse);
      expect(await root.list().toList(), isEmpty);
    }
    var active = true;
    binaryGate = Completer<void>();
    final cancelled = shareMemoryMarkdown(
      repository,
      temporaryDirectory: () async => root,
      isActive: () => active,
      share: (_) async => fail('A cancelled export must not share'),
    );
    active = false;
    binaryGate!.complete();
    await cancelled;
    expect(await root.list().toList(), isEmpty);
  });

  test('preview native player port opens audio once and clears on Stop, completion and scope change', () async {
    binaryBytes = [0, 255, 19, 7];
    final root = await Directory.systemTemp.createTemp('nod-preview-test-');
    addTearDown(() => root.delete(recursive: true));
    final players = <_PreviewPlayer>[];
    final preview = SettingsVoicePreview(
      repository: repository,
      temporaryDirectory: () async => root,
      playerFactory: () {
        final player = _PreviewPlayer();
        players.add(player);
        return player;
      },
    );
    addTearDown(preview.dispose);
    await preview.start(null, 'en');
    expect(preview.playing, isTrue);
    expect(await File(players.single.path!).readAsBytes(), binaryBytes);
    expect(players.single.calls, ['open', 'play']);
    await preview.start(null, 'en');
    expect(requests.length, 1);
    await preview.stop();
    expect(players.single.calls, ['open', 'play', 'pause', 'dispose']);
    expect(await root.list().toList(), isEmpty);
    await preview.start(null, 'en');
    players.last.ends.add(true);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(preview.playing, isFalse);
    expect(await root.list().toList(), isEmpty);
    await preview.start(null, 'en');
    await transport.disconnect();
    await Future<void>.delayed(const Duration(milliseconds: 150));
    expect(preview.playing, isFalse);
    expect(players.last.calls.last, 'dispose');
    expect(await root.list().toList(), isEmpty);
  });

  test(
    'stopped, disposed and stale preview requests never play or retry',
    () async {
      binaryBytes = [1, 2, 3];
      final root = await Directory.systemTemp.createTemp('nod-stale-preview-');
      addTearDown(() => root.delete(recursive: true));
      for (final action in ['stop', 'dispose', 'disconnect']) {
        binaryGate = Completer<void>();
        final preview = SettingsVoicePreview(
          repository: repository,
          temporaryDirectory: () async => root,
          playerFactory: () =>
              throw StateError('Must not create a stale player'),
        );
        final work = preview.start(null, 'en');
        await Future<void>.delayed(Duration.zero);
        await preview.start(null, 'en');
        if (action == 'stop') {
          final other = SettingsVoicePreview(
            repository: repository,
            playerFactory: () =>
                throw StateError('Concurrent preview must not play'),
          );
          await Future.wait([other.start(null, 'en'), other.start(null, 'en')]);
          other.dispose();
        }
        if (action == 'stop') await preview.stop();
        if (action == 'dispose') preview.dispose();
        if (action == 'disconnect') await transport.disconnect();
        binaryGate!.complete();
        await work;
        if (action != 'dispose') preview.dispose();
        expect(await root.list().toList(), isEmpty);
      }
      expect(requests.length, 3);
    },
  );

  test(
    'failed preview is visible and starts again only on explicit request',
    () async {
      status = 409;
      final preview = SettingsVoicePreview(repository: repository);
      await preview.start(null, 'en');
      expect(preview.error, isNotNull);
      expect(preview.playing, isFalse);
      expect(preview.loading, isFalse);
      expect(requests.length, 1);
      await preview.start(null, 'en');
      expect(requests.length, 2);
      preview.dispose();
    },
  );

  testWidgets(
    'voice page clears playback when the app backgrounds and when disposed',
    (tester) async {
      response = {
        'transcription': true,
        'speechReply': 'auto',
        'speechVoice': null,
        'voices': <Object?>[],
      };
      binaryBytes = [0, 1, 2];
      final root = await tester.runAsync(
        () => Directory.systemTemp.createTemp('nod-voice-lifecycle-'),
      );
      addTearDown(() => root!.delete(recursive: true));
      final player = _PreviewPlayer();
      final preview = SettingsVoicePreview(
        repository: repository,
        temporaryDirectory: () async => root!,
        playerFactory: () => player,
      );
      await tester.pumpWidget(
        MaterialApp(
          home: NodVoiceSettingsPage(repository: repository, preview: preview),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Preview voice'));
      await tester.runAsync(() async {
        await tester.tap(find.text('Preview voice'));
        for (var i = 0; i < 100 && !preview.playing; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 5));
        }
      });
      await tester.pump();
      expect(preview.error, isNull);
      expect(preview.playing, isTrue);
      expect(find.text('Stop preview'), findsOneWidget);
      await tester.runAsync(() async {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        await Future<void>.delayed(const Duration(milliseconds: 20));
        expect(await root!.list().toList(), isEmpty);
      });
      expect(player.calls, ['open', 'play', 'pause', 'dispose']);
      expect(preview.playing, isFalse);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect(
        requests
            .where((request) => request.path == '/api/speech/preview')
            .length,
        1,
      );
    },
  );

  testWidgets('source actions forward only actual openable message IDs', (
    tester,
  ) async {
    response = {
      'saving': false,
      'sensitive': false,
      'archive': <Object?>[],
      'skills': <Object?>[],
      'notes': [
        {
          'text': 'Synthetic fact',
          'area': 'about',
          'status': 'stated',
          'sources': [
            {
              'id': 'synthetic-message',
              'text': 'Synthetic source',
              'canOpenInCurrentChat': true,
            },
            {
              'id': 'outside-chat',
              'text': 'Other source',
              'canOpenInCurrentChat': false,
            },
            {'text': 'No message ID', 'canOpenInCurrentChat': true},
          ],
        },
      ],
    };
    final opened = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: NodMemorySettingsPage(
          repository: repository,
          onShowMessage: opened.add,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Synthetic fact'));
    await tester.pumpAndSettle();
    expect(find.text('Show message'), findsOneWidget);
    await tester.ensureVisible(find.text('Show message'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show message'));
    expect(opened, ['synthetic-message']);
  });

  test(
    'preferences, consent and task check-ins are narrow authenticated patches',
    () async {
      await repository.savePreferences({
        'rules': 'Ask before deleting files.',
        'timeZone': null,
      });
      await repository.saveAccount({'traces': false});
      await repository.taskCheckIn(7.25);
      await repository.taskCheckIn(null);
      expect(requests, [
        _request('PATCH', '/api/preferences', {
          'rules': 'Ask before deleting files.',
          'timeZone': null,
        }),
        _request('PATCH', '/api/account', {'traces': false}),
        _request('PUT', '/api/trust/limit', {'taskUsd': 7.25}),
        _request('PUT', '/api/trust/limit', {'taskUsd': null}),
      ]);
      for (final amount in [double.nan, double.infinity, 0.99, 1.001]) {
        expect(
          () => repository.taskCheckIn(amount),
          throwsA(isA<NodRequestException>()),
        );
      }
      expect(requests.length, 4);
    },
  );

  test(
    'memory mutations retain archive revision, note category and skill scope',
    () async {
      await repository.editNote('preferences/short-replies', {'confirm': true});
      await repository.archivedNote({
        'path': 'about/old-plan',
        'archived': '2026-11-11T12:00:00.000Z',
        'text': 'Unused',
      }, restore: true);
      await repository.editSkill(
        'calendar-review',
        'Use when reviewing calendars',
        'Read the requested calendar.',
      );
      await repository.importNotes(
        parseNodMemoryImport(
          '## Preferences\n- Short replies\n## People\n- My manager is Alex',
        ),
      );
      expect(
        requests[0],
        _request('PATCH', '/api/memory/notes/preferences/short-replies', {
          'confirm': true,
        }),
      );
      expect(requests[1].body, {
        'path': 'about/old-plan',
        'archived': '2026-11-11T12:00:00.000Z',
      });
      expect(requests[2].path, '/api/memory/skills/calendar-review');
      expect(requests[3].body, {
        'notes': [
          {'area': 'preferences', 'text': 'Short replies'},
          {'area': 'people', 'text': 'My manager is Alex'},
        ],
      });
      for (final path in [
        '../private',
        'about/../private',
        'about/%2e%2e',
        'about/..',
        'https://outside.example',
      ]) {
        expect(
          () => repository.forgetNote(path),
          throwsA(isA<NodRequestException>()),
        );
      }
      expect(requests.length, 4);
    },
  );

  test(
    'provider configuration uses private routes and preserves model connection',
    () async {
      await repository.connectProvider({
        'provider': 'compatible',
        'url': 'http://localhost:11434/v1',
      });
      await repository.connectProvider({
        'provider': 'azure',
        'url': 'https://synthetic.openai.azure.com',
        'deployment': 'synthetic-deployment',
        'model': 'synthetic-model',
      });
      await repository.selectModel(
        'synthetic-connection',
        'synthetic-model',
        'high',
      );
      await repository.startSignIn(
        'openai',
        connectionId: 'synthetic-connection',
      );
      await repository.signInStatus('synthetic-attempt');
      await repository.cancelSignIn('synthetic-attempt');
      expect(
        requests[0],
        _request('POST', '/api/models/endpoints', {
          'url': 'http://localhost:11434/v1',
        }),
      );
      expect(requests[1].path, '/api/models/keys');
      expect(requests[2].body, {
        'connectionId': 'synthetic-connection',
        'modelId': 'synthetic-model',
        'effort': 'high',
      });
      expect(requests[3].body, {
        'provider': 'openai',
        'connectionId': 'synthetic-connection',
      });
      expect(requests[4].path, '/api/models/oauth/status/synthetic-attempt');
      expect(requests[5].method, 'DELETE');
      expect(
        requests.any((request) => request.path == '/api/messages'),
        isFalse,
      );
    },
  );

  testWidgets('same-provider connections are selectable by safe key identity', (
    tester,
  ) async {
    response = {
      'selection': null,
      'connections': [
        for (final ending in ['a111', 'b222'])
          {
            'id': 'connection-$ending',
            'provider': 'openai',
            'label': 'OpenAI',
            'status': 'connected',
            'method': 'key',
            'keyEnding': ending,
            'models': [
              {
                'id': 'synthetic-model',
                'name': 'Synthetic model',
                'contextWindow': 4096,
                'efforts': <String>[],
              },
            ],
          },
      ],
    };
    await tester.pumpWidget(
      MaterialApp(home: NodSettingsPage(transport: transport)),
    );
    await tester.tap(find.text('Models'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'b222');
    await tester.pumpAndSettle();
    final model = find.text('Synthetic model');
    expect(model, findsOneWidget);
    await tester.ensureVisible(model);
    await tester.tap(model);
    await tester.pumpAndSettle();
    expect(requests.where((request) => request.method != 'GET').single.body, {
      'connectionId': 'connection-b222',
      'modelId': 'synthetic-model',
      'effort': 'off',
    });
  });

  testWidgets(
    'sharing sends no consent until the explicit review is accepted',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(home: NodSettingsPage(transport: transport)),
      );
      await tester.tap(find.text('Privacy & data'));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Switch).last);
      await tester.pumpAndSettle();
      expect(requests, isEmpty);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(requests, isEmpty);
      await tester.tap(find.byType(Switch).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();
      expect(
        requests.single,
        _request('PATCH', '/api/account', {'traces': true}),
      );
    },
  );

  testWidgets(
    'a rejected edit keeps its draft and does not reissue the write',
    (tester) async {
      status = 409;
      response = {'error': 'Synthetic conflict'};
      await tester.pumpWidget(
        MaterialApp(
          home: SettingsEditPage(
            title: 'Rules',
            fields: const {'Rules': ''},
            save: (values) async {
              await repository.savePreferences({'rules': values['Rules']});
            },
          ),
        ),
      );
      await tester.enterText(
        find.byType(TextField),
        'Ask before deleting files.',
      );
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Ask before deleting files.',
      );
      expect(requests.single.body, {'rules': 'Ask before deleting files.'});
      expect(find.byType(SettingsEditPage), findsOneWidget);
    },
  );

  testWidgets(
    'a saved private form returns once and obscures configuration entry',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.push<void>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => SettingsEditPage(
                      title: 'Private connection',
                      fields: const {'API key': ''},
                      secretFields: const {'API key'},
                      save: (values) async {
                        await repository.connectProvider({
                          'provider': 'compatible',
                          'url': 'http://localhost:11434/v1',
                        });
                      },
                    ),
                  ),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.obscureText, isTrue);
      expect(field.enableSuggestions, isFalse);
      expect(field.enableIMEPersonalizedLearning, isFalse);
      await tester.enterText(find.byType(TextField), 'synthetic-placeholder');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.byType(SettingsEditPage), findsNothing);
      expect(requests.length, 1);
    },
  );

  test('server conflict is not retried or converted to success', () async {
    status = 409;
    response = {'error': 'Synthetic conflict'};
    await expectLater(
      repository.resetConversation('stale-thread'),
      throwsA(isA<NodConflictException>()),
    );
    expect(requests.single.body, {'threadId': 'stale-thread'});
    status = 401;
    await expectLater(
      repository.memory(),
      throwsA(isA<NodUnauthorizedException>()),
    );
    expect(requests.length, 2);
    status = 200;
    response = <Object?>[];
    await expectLater(
      repository.models(),
      throwsA(isA<NodProtocolException>()),
    );
  });
}

class _PreviewPlayer implements AudioClipPlayer {
  final calls = <String>[];
  final ends = StreamController<bool>.broadcast();
  String? path;
  @override
  Stream<bool> get completed => ends.stream;
  @override
  Stream<bool> get playing => const Stream.empty();
  @override
  Stream<Duration> get positions => const Stream.empty();
  @override
  Stream<Duration?> get durations => const Stream.empty();
  @override
  Future<void> open(String path) async {
    calls.add('open');
    this.path = path;
    if (!await File(path).exists()) throw StateError('Missing audio');
  }

  @override
  Future<void> play() async => calls.add('play');
  @override
  Future<void> pause() async => calls.add('pause');
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> dispose() async {
    calls.add('dispose');
    await ends.close();
  }
}

Matcher _request(String method, String path, Object? body) =>
    isA<({String method, String path, Object? body})>()
        .having((request) => request.method, 'method', method)
        .having((request) => request.path, 'path', path)
        .having((request) => request.body, 'body', body);

http.StreamedResponse _json(int status, Object? body) => http.StreamedResponse(
  Stream.value(utf8.encode(jsonEncode(body))),
  status,
  headers: {'content-type': 'application/json'},
);
