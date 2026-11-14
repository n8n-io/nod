import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:nod_client/api/api.dart';
import 'package:nod_client/api/rich_results_repository.dart';
import 'package:nod_client/core/api_transport.dart';
import 'package:nod_client/core/app_connections.dart';
import 'package:nod_client/core/attachments.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/usage.dart';
import 'package:nod_client/features/chat/chat.dart';

import '../fixtures/schedule_fixture.dart';
import '../fixtures/usage_fixture.dart';

void main() {
  const token = 'synthetic-secret-token';
  final config = NodConnectionConfig(
    origin: Uri.parse('https://nod.example.test'),
    token: token,
  );

  test('JSON discards an old pairing response and exposes only a credential-free generation', () async {
    final connections = [EventConnection(), EventConnection()];
    var index = 0;
    final started = Completer<void>();
    final listening = Completer<void>();
    final body = StreamController<List<int>>()..onListen = listening.complete;
    final client = RoutingClient((request) async {
      if (request.url.path == '/api/memory/stale') {
        started.complete();
        return http.StreamedResponse(body.stream, 200);
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        _ => _jsonResponse(404, {}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => connections[index++].client,
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    final NodConnectionScope scope = repository;
    final generation = scope.connectionGeneration;
    final old = repository.requestJson('GET', '/api/memory/stale');
    final refusal = expectLater(old, throwsA(isA<NodRequestException>()));
    await started.future;
    await listening.future;
    await repository.disconnect();
    await repository.connect(
      NodConnectionConfig(
        origin: Uri.parse('https://replacement.example.test'),
        token: 'synthetic-replacement',
      ),
    );
    expect(scope.connectionGeneration, greaterThan(generation));
    body.add(utf8.encode('{"private":"old pairing data"}'));
    await body.close();
    await refusal;
    expect(
      await repository.requestJson('GET', '/api/state'),
      isA<Map<Object?, Object?>>(),
    );
  });

  test('binary transport applies a whole-response deadline even while bytes keep arriving', () async {
    final events = EventConnection();
    final client = RoutingClient((request) async {
      if (request.url.path == '/api/speech/preview') {
        return http.StreamedResponse(
          Stream<int>.periodic(
            const Duration(milliseconds: 5),
            (i) => i,
          ).take(100).map((i) => [i]),
          200,
        );
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        _ => _jsonResponse(404, {}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => events.client,
      requestTimeout: const Duration(milliseconds: 40),
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    await expectLater(
      repository.requestBytes(
        'POST',
        '/api/speech/preview',
        body: {'text': 'Synthetic'},
      ),
      throwsA(isA<NodTimeoutException>()),
    );
  });

  test('binary transport contains auth, refuses redirects, bounds bytes and fences disconnect', () async {
    final events = EventConnection();
    var mode = 'ok';
    final gate = Completer<void>();
    final started = Completer<void>();
    final seen = <http.BaseRequest>[];
    final client = RoutingClient((request) async {
      if (request.url.path == '/api/memory/export' ||
          request.url.path == '/api/speech/preview') {
        seen.add(request);
        expect(request.headers['Authorization'], 'Bearer $token');
        expect(request.followRedirects, false);
        if (request.method == 'POST') {
          expect(jsonDecode(utf8.decode(await request.finalize().toBytes())), {
            'text': 'Synthetic preview',
          });
        }
        if (mode == 'redirect') {
          return http.StreamedResponse(
            Stream.value([]),
            302,
            headers: {'location': 'https://other.example/'},
          );
        }
        if (mode == 'large') {
          return http.StreamedResponse(
            Stream.value(List.filled(16 * 1024 * 1024 + 1, 0)),
            200,
          );
        }
        if (mode == 'delayed') {
          started.complete();
          await gate.future;
        }
        return http.StreamedResponse(
          Stream.value(utf8.encode('# Synthetic note')),
          200,
          headers: {'content-type': 'text/markdown; charset=utf-8'},
        );
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        _ => _jsonResponse(404, {}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => events.client,
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    final NodBinaryTransport binary = repository;
    final response = await binary.requestBytes('GET', '/api/memory/export');
    expect(utf8.decode(response.bytes), '# Synthetic note');
    expect(response.mimeType, 'text/markdown');
    await binary.requestBytes(
      'POST',
      '/api/speech/preview',
      body: {'text': 'Synthetic preview'},
    );
    final requests = seen.length;
    for (final path in [
      'https://other.example/api/data',
      '//other.example/api/data',
      '/api/../private',
      '/api/data#token',
      '/api/%2e%2e/private',
    ]) {
      await expectLater(
        Future.sync(() => binary.requestBytes('GET', path)),
        throwsA(isA<NodProtocolException>()),
      );
    }
    expect(seen.length, requests);
    mode = 'redirect';
    await expectLater(
      binary.requestBytes('GET', '/api/memory/export'),
      throwsA(isA<NodException>()),
    );
    mode = 'large';
    await expectLater(
      binary.requestBytes('GET', '/api/memory/export'),
      throwsA(isA<NodProtocolException>()),
    );
    mode = 'delayed';
    final late = binary.requestBytes('GET', '/api/memory/export');
    final refusal = expectLater(late, throwsA(isA<NodException>()));
    await started.future;
    await repository.disconnect();
    gate.complete();
    await refusal;
    expect(
      seen.every((request) => request.url.host == config.origin.host),
      true,
    );
  });

  test('rich state, reactions and addressed attachment and voice messages use actual routes', () async {
    final visuals = jsonDecode(
      await File('test/fixtures/client-api/rich-results.json').readAsString(),
    ) as List;
    final events = EventConnection();
    final writes = <Map<String, Object?>>[];
    final state = _state(
      messages: [
        for (var i = 0; i < visuals.length; i++)
          {
            ..._message('visual-$i', null, ''),
            'role': 'assistant',
            'presentation': visuals[i],
            'reactions': [
              {'actor': 'user', 'reaction': '👍'},
            ],
          },
      ],
    );
    final client = RoutingClient((request) async {
      if (request.method == 'POST' && request.url.path == '/api/messages') {
        writes.add(
          Map<String, Object?>.from(
            jsonDecode(utf8.decode(await request.finalize().toBytes())) as Map,
          ),
        );
        return _jsonResponse(200, {'ok': true});
      }
      if (request.url.path == '/api/messages/audio') {
        final body = utf8.decode(await request.finalize().toBytes());
        expect(body, contains('"threadId":"thread-1"'));
        expect(body, contains('"replyToMessageId":"visual-0"'));
        expect(body, contains('"questionAnswer":{"custom":true}'));
        expect(body, contains('"clientMessageId":"voice-reply"'));
        expect(body, contains('"attachmentIds":["artifact"]'));
        return _jsonResponse(200, {'ok': true});
      }
      if (request.url.path == '/api/messages/visual-0/reaction') {
        expect(jsonDecode(utf8.decode(await request.finalize().toBytes())), {
          'reaction': null,
        });
        return _jsonResponse(200, {'ok': true});
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, state),
        '/api/messages' => _jsonResponse(200, {
          'messages': state['messages'],
          'hasMore': false,
        }),
        _ => _jsonResponse(404, {}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => events.client,
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    final loaded = await repository.loadState();
    expect(loaded.messages.map((m) => m.presentation?.data), visuals);
    expect(loaded.messages.first.reactions.single.reaction, '👍');
    final controller = ChatController(repository);
    addTearDown(controller.dispose);
    await controller.start();
    controller.replyTo(controller.messages.first);
    const artifact = NodArtifact(
      id: 'artifact',
      name: 'Synthetic.txt',
      mimeType: 'text/plain',
      size: 1,
    );
    expect(await controller.sendText('', attachments: [artifact]), true);
    expect(writes.single['replyToMessageId'], 'visual-0');
    expect(writes.single['attachmentIds'], ['artifact']);
    expect(writes.single['threadId'], 'thread-1');
    expect(controller.replyTarget, isNull);
    await repository.sendReply(
      '',
      clientMessageId: 'voice-reply',
      threadId: 'thread-1',
      replyToMessageId: 'visual-0',
      customAnswer: true,
      attachments: [artifact],
      recording: NodUploadFile(
        name: 'synthetic.wav',
        size: 4,
        mimeType: 'audio/wav',
        read: () => Stream.value([0, 0, 0, 0]),
      ),
    );
    await NodRichResultsRepository(repository).react('visual-0', null);
  });

  test('addressed question replies preserve choices, retries, stale and reset fencing', () async {
    final events = EventConnection();
    const questionId = '538a7c2d-a2a1-42a3-bc84-c98b777d87cc';
    const firstId = 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004';
    const secondId = 'c5ed5115-813d-4d3d-a6ce-94b6d36ce005';
    var waiting = true;
    var failFirst = true;
    var reset = false;
    final writes = <Map<Object?, Object?>>[];
    final accepted = <String>{};
    var dispatches = 0;
    Map<String, Object?> state() => {
      ..._state(
        messages: [
          {
            ..._message(questionId, null, 'Which draft?'),
            'role': 'assistant',
            'turnId': 'task-turn',
            'answerChoices': {
              'multiple': true,
              'options': [
                {
                  'id': firstId,
                  'label': 'First',
                  'description': 'Private draft',
                },
                {'id': secondId, 'label': 'Second'},
              ],
            },
            'answerChoicesPending': waiting,
          },
        ],
      ),
      'threadId': reset ? 'replacement-thread' : 'original-thread',
      'pendingAnswerChoiceMessageIds': waiting ? [questionId] : <String>[],
      'verificationRequests': [
        {'id': firstId, 'turnId': 'task-turn', 'kind': 'otp'},
      ],
    };
    final client = RoutingClient((request) async {
      expect(request.headers['Authorization'], 'Bearer $token');
      if (request.method == 'POST' && request.url.path == '/api/messages') {
        final body =
            jsonDecode(utf8.decode(await request.finalize().toBytes())) as Map;
        writes.add(body);
        if (body['threadId'] != 'original-thread' ||
            body['replyToMessageId'] != questionId) {
          return _jsonResponse(409, {'code': 'conversation_reset'});
        }
        if (accepted.contains(body['clientMessageId'])) {
          return _jsonResponse(200, {'ok': true});
        }
        if (!waiting) {
          return _jsonResponse(409, {'code': 'question_unavailable'});
        }
        expect(body['text'], 'First: Private draft\nSecond');
        expect(body['questionAnswer'], {
          'choiceIds': [firstId, secondId],
        });
        accepted.add(body['clientMessageId'] as String);
        dispatches++;
        waiting = false;
        if (failFirst) {
          failFirst = false;
          throw const SocketException('synthetic lost receipt');
        }
        return _jsonResponse(200, {'ok': true});
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, state()),
        '/api/messages' => _jsonResponse(200, {
          'messages': state()['messages'],
        }),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => events.client,
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    final controller = ChatController(repository);
    addTearDown(controller.dispose);
    await controller.start();
    final question = controller.messages.single;
    expect(question.turnId, 'task-turn');
    expect(controller.verificationRequests.single.kind, 'otp');
    expect(controller.hasChoices(question), isTrue);
    expect(
      await controller.answerChoices(question, [secondId, firstId]),
      isFalse,
    );
    expect(
      await controller.answerChoices(question, [secondId, firstId]),
      isTrue,
    );
    expect(writes[0]['clientMessageId'], writes[1]['clientMessageId']);
    expect(dispatches, 1);
    expect(controller.hasChoices(question), isFalse);
    expect(await controller.answerChoices(question, [firstId]), isFalse);
    controller.replyTo(question);
    expect(await controller.sendText('Different answer'), isFalse);
    expect(writes.last['questionAnswer'], {'custom': true});
    expect(dispatches, 1);
    reset = true;
    events.add({'type': 'refresh'});
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(controller.replyTarget, isNull);
    expect(controller.messages.where((message) => message.isPending), isEmpty);
  });

  test('declined approval and check-in replies are addressed text, never choice approvals', () async {
    final events = EventConnection();
    final writes = <Map<Object?, Object?>>[];
    final client = RoutingClient((request) async {
      if (request.method == 'POST' && request.url.path == '/api/messages') {
        writes.add(
          jsonDecode(utf8.decode(await request.finalize().toBytes())) as Map,
        );
        return _jsonResponse(200, {'ok': true});
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => events.client,
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    await repository.sendReply(
      'No, stop this task',
      clientMessageId: 'decline',
      threadId: 'thread-1',
      replyToMessageId: 'approval-question',
    );
    await repository.sendReply(
      'Keep going',
      clientMessageId: 'continue',
      threadId: 'thread-1',
      replyToMessageId: 'check-in-question',
    );
    expect(writes.map((body) => body['replyToMessageId']), [
      'approval-question',
      'check-in-question',
    ]);
    expect(writes.every((body) => !body.containsKey('questionAnswer')), isTrue);
  });

  test('browser handoff decodes split frames and disconnect cancels without credentials in URL', () async {
    final events = EventConnection();
    final chunks = StreamController<List<int>>();
    var cancelled = false;
    chunks.onCancel = () {
      cancelled = true;
    };
    final client = RoutingClient(
      (request) async => switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        _ => _jsonResponse(404, {}),
      },
    );
    final opened = Completer<void>();
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => events.client,
      browserClientFactory: () => RoutingClient((request) async {
        expect(request.url.origin, config.origin.toString());
        expect(request.url.queryParameters, {
          'turnId': '538a7c2d-a2a1-42a3-bc84-c98b777d87cc',
        });
        expect(request.headers['Authorization'], 'Bearer $token');
        expect(request.followRedirects, isFalse);
        opened.complete();
        return http.StreamedResponse(chunks.stream, 200);
      }),
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    final frames = <List<int>>[];
    final done = Completer<void>();
    repository
        .browserHandoffFrames('538a7c2d-a2a1-42a3-bc84-c98b777d87cc')
        .listen(frames.add, onDone: done.complete);
    await opened.future;
    chunks.add([0, 0]);
    chunks.add([0, 3, 1]);
    chunks.add([2, 3, 0, 0, 0, 1, 4]);
    await Future<void>.delayed(Duration.zero);
    expect(frames, [
      [1, 2, 3],
      [4],
    ]);
    await repository.disconnect();
    await done.future;
    expect(cancelled, isTrue);
    await chunks.close();
  });

  for (final bytes in [
    [0, 128, 0, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 4, 1],
  ]) {
    test(
      'browser handoff rejects oversized, empty or truncated frames $bytes',
      () async {
        final events = EventConnection();
        final client = RoutingClient(
          (request) async => switch (request.url.path) {
            '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
            '/api/session' => _jsonResponse(200, _session()),
            '/api/state' => _jsonResponse(200, _state()),
            _ => _jsonResponse(404, {}),
          },
        );
        final repository = HttpNodRepository(
          credentials: MemoryCredentials(),
          client: client,
          eventClientFactory: () => events.client,
          browserClientFactory: () => RoutingClient(
            (_) async => http.StreamedResponse(Stream.value(bytes), 200),
          ),
        );
        addTearDown(repository.dispose);
        await repository.connect(config);
        await expectLater(
          repository.browserHandoffFrames(
            '538a7c2d-a2a1-42a3-bc84-c98b777d87cc',
          ),
          emitsError(isA<NodProtocolException>()),
        );
      },
    );
  }

  test('authenticated JSON never follows a redirect carrying private request values', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final other = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() async {
      await server.close(force: true);
      await other.close(force: true);
    });
    var forwarded = 0;
    other.listen((request) async {
      forwarded++;
      await request.drain<void>();
      await request.response.close();
    });
    server.listen((request) async {
      expect(request.headers.value('authorization'), 'Bearer $token');
      if (request.uri.path == '/api/private-fixture') {
        expect(
          await utf8.decoder.bind(request).join(),
          '{"value":"synthetic-private-value"}',
        );
        request.response.statusCode = 307;
        request.response.headers.set(
          'location',
          'http://127.0.0.1:${other.port}/api/private-fixture',
        );
        await request.response.close();
        return;
      }
      final body = switch (request.uri.path) {
        '/api/client/capabilities' => _capabilities(),
        '/api/session' => _session(),
        '/api/state' => _state(),
        _ => <String, Object?>{},
      };
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(body));
      await request.response.close();
    });
    final events = EventConnection();
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      eventClientFactory: () => events.client,
    );
    addTearDown(repository.dispose);
    await repository.connect(
      NodConnectionConfig(
        origin: Uri.parse('http://127.0.0.1:${server.port}'),
        token: token,
      ),
    );
    await expectLater(
      repository.requestJson(
        'POST',
        '/api/private-fixture',
        body: {'value': 'synthetic-private-value'},
      ),
      throwsA(isA<NodRequestException>()),
    );
    expect(forwarded, 0);
  });

  test('task message focus loads bounded server context, addresses older question and fences reset', () async {
    final events = EventConnection();
    var thread = 'thread-1';
    final contextGate = Completer<void>();
    final contextStarted = Completer<void>();
    final writes = <Map<Object?, Object?>>[];
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      eventClientFactory: () => events.client,
      client: RoutingClient((request) async {
        expect(request.headers['Authorization'], 'Bearer $token');
        if (request.url.path == '/api/messages/around/older-question') {
          expect(request.followRedirects, isFalse);
          return _jsonResponse(200, [
            {
              ..._message('older-question', null, 'Continue this task?'),
              'role': 'assistant',
            },
          ]);
        }
        if (request.url.path == '/api/messages/around/delayed-question') {
          contextStarted.complete();
          await contextGate.future;
          return _jsonResponse(200, [
            {
              ..._message('delayed-question', null, 'Old private link'),
              'role': 'assistant',
            },
          ]);
        }
        if (request.method == 'POST' && request.url.path == '/api/messages') {
          writes.add(
            jsonDecode(utf8.decode(await request.finalize().toBytes())) as Map,
          );
          return _jsonResponse(200, {'ok': true});
        }
        return switch (request.url.path) {
          '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
          '/api/session' => _jsonResponse(200, _session()),
          '/api/state' => _jsonResponse(200, {..._state(), 'threadId': thread}),
          '/api/messages' => _jsonResponse(200, {'messages': <Object?>[]}),
          _ => _jsonResponse(404, {'error': 'not found'}),
        };
      }),
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    final controller = ChatController(repository);
    addTearDown(controller.dispose);
    await controller.start();
    expect(
      (await controller.focusMessage('older-question'))?.id,
      'older-question',
    );
    expect(controller.replyTarget?.id, 'older-question');
    expect(await controller.sendText('No, stop this task'), isTrue);
    expect(writes.single['replyToMessageId'], 'older-question');
    expect(writes.single['threadId'], 'thread-1');
    expect(writes.single.containsKey('questionAnswer'), isFalse);
    final focusing = controller.focusMessage('delayed-question');
    await contextStarted.future;
    thread = 'replacement-thread';
    contextGate.complete();
    expect(await focusing, isNull);
    expect(controller.replyTarget, isNull);
    expect(
      controller.messages.any((message) => message.id == 'delayed-question'),
      isFalse,
    );
    expect(await controller.focusMessage('missing-question'), isNull);
    expect(controller.replyTarget, isNull);
    expect(writes, hasLength(1));
  });

  test('feature transport refuses off-origin and non-API destinations', () {
    final repository = HttpNodRepository(credentials: MemoryCredentials());
    addTearDown(repository.dispose);
    for (final path in [
      'https://outside.example/api/state',
      '//outside.example/api/state',
      '/api/../private',
      '/api/%2e%2e/private',
      '/private',
      '/api/state#fragment',
    ]) {
      expect(
        () => repository.requestJson('GET', path),
        throwsA(isA<NodProtocolException>()),
      );
    }
  });

  test(
    'schedule routes authenticate, fence revisions and preserve history cursor',
    () async {
      final events = EventConnection();
      final methods = <String>[];
      final client = RoutingClient((request) async {
        expect(request.headers['Authorization'], 'Bearer $token');
        if (request.url.path == '/api/schedules') {
          return _jsonResponse(200, [fixture]);
        }
        if (request.url.path.startsWith('/api/schedules/')) {
          methods.add(request.method);
          if (request.method == 'DELETE') {
            return _jsonResponse(200, {'ok': true});
          }
          final body = jsonDecode(
            utf8.decode(await request.finalize().toBytes()),
          ) as Map;
          expect(body, {'enabled': false, 'expectedRevision': 3});
          return _jsonResponse(200, {
            ...fixture,
            'enabled': false,
            'revision': 4,
          });
        }
        if (request.url.path == '/api/schedule-runs') {
          expect(request.url.queryParameters, {
            'scheduleId': fixture['id'],
            'cursor': 'opaque/page+=',
          });
          return _jsonResponse(200, {'runs': <Object?>[], 'nextCursor': null});
        }
        return switch (request.url.path) {
          '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
          '/api/session' => _jsonResponse(200, _session()),
          '/api/state' => _jsonResponse(200, _state()),
          _ => _jsonResponse(404, {'error': 'not found'}),
        };
      });
      final repository = HttpNodRepository(
        credentials: MemoryCredentials(),
        client: client,
        eventClientFactory: () => events.client,
      );
      addTearDown(repository.dispose);
      await repository.connect(config);
      final schedule = (await repository.loadSchedules()).single;
      expect(
        (await repository.updateSchedule(schedule, {
          'enabled': false,
        })).revision,
        4,
      );
      expect(
        (await repository.loadScheduleHistory(
          schedule.id,
          cursor: 'opaque/page+=',
        )).runs,
        isEmpty,
      );
      await repository.deleteSchedule(schedule.id);
      expect(methods, ['PATCH', 'DELETE']);
    },
  );

  test(
    'usage uses bearer auth, cursor pagination and explicit limit writes',
    () async {
      final events = EventConnection();
      final writes = <Object?>[];
      final client = RoutingClient((request) async {
        expect(request.headers['Authorization'], 'Bearer $token');
        if (request.url.path == '/api/trust') {
          return _jsonResponse(200, usageFixture);
        }
        if (request.url.path == '/api/trust/entries') {
          expect(request.url.queryParameters, {
            'at': '2026-11-01T12:00:00.000Z',
            'id': '12345678-1234-4234-8234-123456789abc',
          });
          return _jsonResponse(200, {'entries': <Object?>[], 'next': null});
        }
        if (request.url.path == '/api/trust/limit') {
          expect(request.method, 'PUT');
          final body = jsonDecode(
            utf8.decode(await request.finalize().toBytes()),
          ) as Map;
          writes.add(body['monthlyUsd']);
          expect(body.keys, ['monthlyUsd']);
          return _jsonResponse(200, {
            'limit': body['monthlyUsd'] == null
                ? null
                : {'monthlyUsd': body['monthlyUsd'], 'reached': false},
            'taskUsd': 5,
          });
        }
        return switch (request.url.path) {
          '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
          '/api/session' => _jsonResponse(200, _session()),
          '/api/state' => _jsonResponse(200, _state()),
          _ => _jsonResponse(404, {'error': 'not found'}),
        };
      });
      final repository = HttpNodRepository(
        credentials: MemoryCredentials(),
        client: client,
        eventClientFactory: () => events.client,
      );
      addTearDown(repository.dispose);
      await repository.connect(config);
      final report = await repository.loadUsage();
      expect(report.spentUsd, 12.5);
      expect(report.page.entries[1].costUsd, null);
      expect(
        report.page.entries.first.actions.single,
        contains('Synthetic instruction'),
      );
      expect((await repository.loadUsageEntries(report.page.next!)).next, null);
      expect((await repository.saveMonthlyLimit(50))!.monthlyUsd, 50);
      expect(await repository.saveMonthlyLimit(null), null);
      await expectLater(
        repository.saveMonthlyLimit(double.nan),
        throwsA(isA<NodRequestException>()),
      );
      expect(writes, [50, null]);
    },
  );

  test(
    'usage rejects malformed and nonfinite costs as protocol failures',
    () async {
      final events = EventConnection();
      final client = RoutingClient(
        (request) async => switch (request.url.path) {
          '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
          '/api/session' => _jsonResponse(200, _session()),
          '/api/state' => _jsonResponse(200, _state()),
          '/api/trust' => _jsonResponse(200, {
            ...usageFixture,
            'month': {'spentUsd': -1},
          }),
          _ => _jsonResponse(404, {}),
        },
      );
      final repository = HttpNodRepository(
        credentials: MemoryCredentials(),
        client: client,
        eventClientFactory: () => events.client,
      );
      addTearDown(repository.dispose);
      await repository.connect(config);
      await expectLater(
        repository.loadUsage(),
        throwsA(isA<NodProtocolException>()),
      );
      expect(
        () => NodUsageReport.fromJson({
          ...usageFixture,
          'month': {
            ...(usageFixture['month'] as Map<String, Object?>),
            'spentUsd': double.infinity,
          },
        }),
        throwsFormatException,
      );
    },
  );

  test(
    'forgetting credentials prevents automatic sign-in on next launch',
    () async {
      final credentials = MemoryCredentials()..value = config;
      final repository = HttpNodRepository(
        credentials: credentials,
        client: RoutingClient(
          (request) async => throw StateError('No request expected'),
        ),
      );
      addTearDown(repository.dispose);
      await repository.forgetCredentials();
      expect(credentials.value, null);
      expect(await repository.connectStored(), false);
    },
  );

  test('audio reports bounded setup failures without exposing arbitrary server content', () async {
    final events = EventConnection();
    var status = 400;
    var retryable = true;
    var error =
        'Set up audio in Settings → General → Voice. Choose free voices or connect a voice service.';
    final client = RoutingClient((request) async {
      if (request.url.path == '/api/messages/audio') {
        return _jsonResponse(status, {'error': error, 'retryable': retryable});
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => events.client,
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    final recording = NodUploadFile(
      name: 'voice.wav',
      size: 100,
      mimeType: 'audio/wav',
      read: () => Stream.value(List<int>.filled(100, 0)),
    );
    await expectLater(
      repository.sendAudio(
        '',
        recording,
        clientMessageId: '12345678-1234-4234-8234-123456789abc',
      ),
      throwsA(
        isA<NodAudioException>()
            .having((e) => e.kind, 'kind', NodAudioFailure.setup)
            .having((e) => e.retryable, 'retryable', true),
      ),
    );
    error = 'No speech was detected. Check your microphone and record again.';
    await expectLater(
      repository.sendAudio(
        '',
        recording,
        clientMessageId: '12345678-1234-4234-8234-123456789abc',
      ),
      throwsA(
        isA<NodAudioException>().having(
          (e) => e.kind,
          'kind',
          NodAudioFailure.noSpeech,
        ),
      ),
    );
    error = 'Synthetic private provider response';
    retryable = false;
    await expectLater(
      repository.sendAudio(
        '',
        recording,
        clientMessageId: '12345678-1234-4234-8234-123456789abc',
      ),
      throwsA(isA<NodRequestException>()),
    );
    status = 413;
    await expectLater(
      repository.sendAudio(
        '',
        recording,
        clientMessageId: '12345678-1234-4234-8234-123456789abc',
      ),
      throwsA(
        isA<NodAudioException>().having(
          (e) => e.kind,
          'kind',
          NodAudioFailure.tooLarge,
        ),
      ),
    );
  });

  test('audio sends authenticated multipart with stable identity and caption history', () async {
    final eventConnection = EventConnection();
    var calls = 0;
    final client = RoutingClient((request) async {
      if (request.url.path == '/api/messages/audio') {
        calls++;
        expect(request.followRedirects, false);
        expect(request.headers['Authorization'], contains('Bearer'));
        final body = utf8.decode(await request.finalize().toBytes());
        expect(body, contains('name="message"'));
        expect(body, contains('"threadId":"thread-1"'));
        expect(body, contains('"clientMessageId":"synthetic-audio-id"'));
        expect(body, contains('filename="voice.wav"'));
        expect(body, contains('audio/wav'));
        return _jsonResponse(calls == 1 ? 503 : 200, {
          'messageId': 'synthetic-audio-id',
        });
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(
          200,
          _state(
            messages: [
              {
                ..._message('audio-1', null, 'transcript'),
                'audioCaption': 'Voice message caption',
              },
            ],
          ),
        ),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => eventConnection.client,
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    final file = NodUploadFile(
      read: () => Stream.value(List.filled(100, 0)),
      name: 'voice.wav',
      size: 100,
      mimeType: 'audio/wav',
    );
    await expectLater(
      repository.sendAudio('', file, clientMessageId: 'synthetic-audio-id'),
      throwsA(isA<NodException>()),
    );
    await repository.sendAudio('', file, clientMessageId: 'synthetic-audio-id');
    expect(calls, 2);
    expect(
      (await repository.loadState()).messages.single.text,
      'Voice message caption',
    );
  });

  test('native attachments stream multipart, survive history reload and never follow redirects with bearer auth', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final directory = await Directory.systemTemp.createTemp(
      'nod-attachment-test-',
    );
    addTearDown(() async {
      await server.close(force: true);
      await directory.delete(recursive: true);
    });
    const id = 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004';
    const artifact = {
      'id': id,
      'name': 'synthetic.txt',
      'mimeType': 'text/plain',
      'size': 16,
      'url': '/api/artifacts/$id',
    };
    var sent = false;
    var redirect = false;
    var stall = false;
    final downloadStarted = Completer<void>();
    final releaseDownload = Completer<void>();
    addTearDown(() {
      if (!releaseDownload.isCompleted) releaseDownload.complete();
    });
    var externalCalls = 0;
    Map<String, dynamic>? submitted;
    server.listen((request) async {
      try {
        expect(
          request.headers.value('authorization'),
          'Bearer synthetic-token',
        );
        Object response;
        switch (request.uri.path) {
          case '/api/client/capabilities':
            response = _capabilities();
          case '/api/session':
            response = _session();
          case '/api/state':
            response = _state();
          case '/api/uploads':
            expect(
              request.headers.contentType?.mimeType,
              'multipart/form-data',
            );
            final body = utf8.decode(
              await request.fold<List<int>>(
                [],
                (all, next) => all..addAll(next),
              ),
            );
            expect(body, contains('filename="synthetic.txt"'));
            expect(body, contains('synthetic bytes!'));
            response = artifact;
          case '/api/uploads/renew':
            expect(jsonDecode(await utf8.decoder.bind(request).join()), {
              'ids': [id],
            });
            response = [artifact];
          case '/api/messages':
            if (request.method == 'POST') {
              submitted = jsonDecode(
                await utf8.decoder.bind(request).join(),
              ) as Map<String, dynamic>;
              sent = true;
              response = {'messageId': id};
            } else {
              response = {
                'messages': sent
                    ? [
                        {
                          ..._message(id, id, ''),
                          'attachments': [artifact],
                        },
                      ]
                    : <Map<String, Object?>>[],
                'hasMore': false,
              };
            }
          case '/api/artifacts/$id':
            if (redirect) {
              request.response.statusCode = 302;
              request.response.headers.set(
                'location',
                'http://127.0.0.1:${server.port}/external',
              );
            } else if (stall) {
              request.response.add(utf8.encode('synthetic'));
              await request.response.flush();
              downloadStarted.complete();
              await releaseDownload.future;
            } else {
              request.response.add(utf8.encode('synthetic bytes!'));
            }
            await request.response.close();
            return;
          case '/external':
            externalCalls++;
            response = {};
          default:
            request.response.statusCode = 404;
            response = {};
        }
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode(response));
        await request.response.close();
      } on SocketException {
        return;
      } on HttpException {
        return;
      } catch (_) {
        await request.response.close();
        rethrow;
      }
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      eventClientFactory: () => EventConnection().client,
    );
    addTearDown(repository.dispose);
    await repository.connect(
      NodConnectionConfig(
        origin: Uri.parse('http://127.0.0.1:${server.port}'),
        token: 'synthetic-token',
      ),
    );
    final progress = <double>[];
    final uploaded = await repository.uploadAttachment(
      NodUploadFile(
        name: 'synthetic.txt',
        size: 16,
        mimeType: 'text/plain',
        read: () => Stream.value(utf8.encode('synthetic bytes!')),
      ),
      cancelled: Completer<void>().future,
      onProgress: progress.add,
    );
    expect(progress.last, 1);
    expect((await repository.renewAttachments([uploaded.id])).single.id, id);
    await repository.sendAttachments('', [uploaded], clientMessageId: id);
    expect(submitted!['attachmentIds'], [id]);
    expect(submitted!['text'], '');
    expect(
      (await repository.loadHistory()).messages.single.attachments.single.id,
      id,
    );
    final file = File('${directory.path}/download.txt');
    await repository.downloadAttachment(
      uploaded,
      file,
      cancelled: Completer<void>().future,
    );
    expect(await file.readAsString(), 'synthetic bytes!');
    redirect = true;
    final blocked = File('${directory.path}/blocked');
    await expectLater(
      repository.downloadAttachment(
        uploaded,
        blocked,
        cancelled: Completer<void>().future,
      ),
      throwsA(isA<NodException>()),
    );
    expect(await blocked.exists(), isFalse);
    expect(externalCalls, 0);
    redirect = false;
    stall = true;
    final cancelled = Completer<void>();
    final partial = File('${directory.path}/partial');
    final downloading = repository.downloadAttachment(
      uploaded,
      partial,
      cancelled: cancelled.future,
    );
    final rejected = expectLater(downloading, throwsA(isA<NodException>()));
    await downloadStarted.future;
    cancelled.complete();
    await rejected.timeout(const Duration(seconds: 5));
    expect(await partial.exists(), isFalse);
    releaseDownload.complete();
  });

  test('app sign-in uses bearer APIs and confirms the exact attempt', () async {
    final eventConnection = EventConnection();
    final requests = <http.BaseRequest>[];
    var completed = false;
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      eventClientFactory: () => eventConnection.client,
      client: RoutingClient((request) async {
        requests.add(request);
        expect(request.headers['Authorization'], 'Bearer $token');
        return switch (request.url.path) {
          '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
          '/api/session' => _jsonResponse(200, _session()),
          '/api/state' => _jsonResponse(200, _state()),
          '/api/apps/catalog' => _jsonResponse(200, [
            {'slug': 'gmail', 'name': 'Gmail', 'status': 'not_configured'},
          ]),
          '/api/apps/gmail/connect' => _jsonResponse(200, {
            'url': 'https://auth.example.test/sign-in?attempt=synthetic',
          }),
          '/api/apps/setup-status' => _jsonResponse(200, {
            'completed': completed
                ? [
                    (jsonDecode((request as http.Request).body)
                        as Map)['hashes'][0],
                  ]
                : <String>[],
            'apps': [
              {
                'hash': (jsonDecode(
                  (request as http.Request).body,
                ) as Map)['hashes'][0],
                'available': true,
              },
            ],
          }),
          '/api/apps/setup-cancel' => _jsonResponse(200, {'ok': true}),
          _ => _jsonResponse(404, {}),
        };
      }),
    );
    addTearDown(repository.dispose);
    await repository.connect(config);
    final app = (await repository.loadApps(catalog: true)).single;
    final attempt = await repository.startAppSignIn(app);
    expect(attempt.url.toString(), isNot(contains(token)));
    expect(attempt.hash, matches(RegExp(r'^[a-f0-9]{64}$')));
    expect(
      await repository.appSignInStatus(attempt),
      NodAppSignInStatus.waiting,
    );
    completed = true;
    expect(
      await repository.appSignInStatus(attempt),
      NodAppSignInStatus.connected,
    );
    await repository.cancelAppSignIn(attempt);
    final cancel = requests.last as http.Request;
    expect(jsonDecode(cancel.body), {'hash': attempt.hash});
    final start = requests.firstWhere(
      (request) => request.url.path.endsWith('/connect'),
    ) as http.Request;
    expect(jsonDecode(start.body), {'returnTo': 'window'});
    await repository.startAppSignIn(
      const NodAppConnection(
        slug: 'gmail',
        name: 'Gmail',
        status: 'connected',
        connectionId: 'existing-account',
        broker: true,
      ),
    );
    expect(jsonDecode((requests.last as http.Request).body), {
      'returnTo': 'window',
    });
    await repository.startAppSignIn(
      const NodAppConnection(
        slug: 'gmail',
        name: 'Gmail',
        status: 'disconnected',
        connectionId: 'existing-account',
        broker: true,
      ),
    );
    expect(jsonDecode((requests.last as http.Request).body), {
      'returnTo': 'window',
      'connectionId': 'existing-account',
    });
  });

  test(
    'app sign-in refuses unsafe URLs without exposing server details',
    () async {
      final eventConnection = EventConnection();
      var url = 'javascript:alert(1)';
      var cancelled = 0;
      final repository = HttpNodRepository(
        credentials: MemoryCredentials(),
        eventClientFactory: () => eventConnection.client,
        client: RoutingClient((request) async {
          if (request.url.path == '/api/apps/setup-cancel') cancelled++;
          return switch (request.url.path) {
            '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
            '/api/session' => _jsonResponse(200, _session()),
            '/api/state' => _jsonResponse(200, _state()),
            '/api/apps/gmail/connect' => _jsonResponse(200, {'url': url}),
            '/api/apps/setup-cancel' => _jsonResponse(200, {'ok': true}),
            _ => _jsonResponse(404, {}),
          };
        }),
      );
      addTearDown(repository.dispose);
      await repository.connect(config);
      const app = NodAppConnection(
        slug: 'gmail',
        name: 'Gmail',
        status: 'not_configured',
      );
      for (final unsafe in [
        'javascript:alert(1)',
        'file:///private/file',
        'https://user:pass@example.test',
        'http://untrusted.test',
      ]) {
        url = unsafe;
        await expectLater(
          repository.startAppSignIn(app),
          throwsA(isA<NodProtocolException>()),
        );
      }
      expect(cancelled, 4);
    },
  );

  test('rejects a token without storing or exposing it', () async {
    final credentials = MemoryCredentials();
    final client = RoutingClient((request) async {
      return _jsonResponse(401, {'error': 'Rejected $token'});
    });
    final repository = HttpNodRepository(
      credentials: credentials,
      client: client,
      eventClientFactory: () => throw StateError('events must not open'),
    );
    addTearDown(repository.dispose);

    Object? thrown;
    try {
      await repository.connect(config);
    } on Object catch (error) {
      thrown = error;
    }

    expect(thrown, isA<NodUnauthorizedException>());
    expect(thrown.toString(), isNot(contains(token)));
    expect(credentials.value, isNull);
  });

  test('maps timeout and offline failures to typed errors', () async {
    final timeoutRepository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: RoutingClient(
        (request) => Completer<http.StreamedResponse>().future,
      ),
      requestTimeout: const Duration(milliseconds: 1),
    );
    addTearDown(timeoutRepository.dispose);
    await expectLater(
      timeoutRepository.connect(config),
      throwsA(isA<NodTimeoutException>()),
    );

    final offlineRepository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: RoutingClient((request) async {
        throw const SocketException('synthetic offline');
      }),
    );
    addTearDown(offlineRepository.dispose);
    await expectLater(
      offlineRepository.connect(config),
      throwsA(isA<NodOfflineException>()),
    );
  });

  test('maps credential read failures without starting a connection', () async {
    const backendDetail = 'private secret-service backend detail';
    var eventsOpened = false;
    final repository = HttpNodRepository(
      credentials: ThrowingCredentials(readError: StateError(backendDetail)),
      client: RoutingClient((request) async {
        throw StateError('requests must not start');
      }),
      eventClientFactory: () {
        eventsOpened = true;
        return EventConnection().client;
      },
    );
    addTearDown(repository.dispose);

    Object? thrown;
    try {
      await repository.connectStored();
    } on Object catch (error) {
      thrown = error;
    }

    expect(thrown, isA<NodCredentialStorageException>());
    expect(thrown.toString(), isNot(contains(backendDetail)));
    expect(eventsOpened, isFalse);
    expect(
      await repository.connectionStates.first,
      isA<NodConnectionState>().having(
        (state) => state.phase,
        'phase',
        NodConnectionPhase.disconnected,
      ),
    );
  });

  test('maps credential write failures and closes event resources', () async {
    const backendDetail = 'private libsecret write detail';
    final eventConnection = EventConnection();
    final repository = HttpNodRepository(
      credentials: ThrowingCredentials(writeError: StateError(backendDetail)),
      client: RoutingClient((request) async {
        return switch (request.url.path) {
          '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
          '/api/session' => _jsonResponse(200, _session()),
          '/api/state' => _jsonResponse(200, _state()),
          _ => _jsonResponse(404, {'error': 'not found'}),
        };
      }),
      eventClientFactory: () => eventConnection.client,
    );
    addTearDown(repository.dispose);

    Object? thrown;
    try {
      await repository.connect(config);
    } on Object catch (error) {
      thrown = error;
    }

    expect(thrown, isA<NodCredentialStorageException>());
    expect(thrown.toString(), isNot(contains(backendDetail)));
    expect(eventConnection.cancelled, isTrue);
    expect(
      await repository.connectionStates.first,
      isA<NodConnectionState>().having(
        (state) => state.phase,
        'phase',
        NodConnectionPhase.disconnected,
      ),
    );
    await expectLater(
      repository.loadState(),
      throwsA(isA<NodOfflineException>()),
    );
  });

  test('maps credential delete failures without backend detail', () async {
    const backendDetail = 'private secret-service delete detail';
    final repository = HttpNodRepository(
      credentials: ThrowingCredentials(deleteError: StateError(backendDetail)),
      client: RoutingClient((request) async {
        throw StateError('requests must not start');
      }),
    );
    addTearDown(repository.dispose);

    Object? thrown;
    try {
      await repository.forgetCredentials();
    } on Object catch (error) {
      thrown = error;
    }

    expect(thrown, isA<NodCredentialStorageException>());
    expect(thrown.toString(), isNot(contains(backendDetail)));
  });

  test('uses bearer auth for session, state, send and stop', () async {
    final credentials = MemoryCredentials();
    final eventConnection = EventConnection(
      expectedAuthorization: 'Bearer $token',
    );
    final requests = <http.BaseRequest>[];
    final bodies = <Map<String, Object?>>[];
    final client = RoutingClient((request) async {
      requests.add(request);
      if (request is http.Request && request.body.isNotEmpty) {
        bodies.add(
          Map<String, Object?>.from(
            jsonDecode(request.body) as Map<Object?, Object?>,
          ),
        );
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        '/api/messages' => _jsonResponse(200, {
          'messageId': 'client-1',
          'turnId': 'turn-1',
        }),
        '/api/thread/stop' => _jsonResponse(200, {'ok': true}),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final repository = HttpNodRepository(
      credentials: credentials,
      client: client,
      eventClientFactory: () => eventConnection.client,
    );
    addTearDown(repository.dispose);

    await repository.connect(config).timeout(const Duration(seconds: 1));
    await repository
        .sendText('Hello', clientMessageId: 'client-1')
        .timeout(const Duration(seconds: 1));
    await repository.stop().timeout(const Duration(seconds: 1));

    expect(
      requests.every(
        (request) => request.headers['Authorization'] == 'Bearer $token',
      ),
      isTrue,
    );
    expect(eventConnection.authorizationMatches, isTrue);
    expect(bodies.single, {
      'text': 'Hello',
      'clientMessageId': 'client-1',
      'threadId': 'thread-1',
    });
    expect(credentials.value?.token == token, isTrue);
  });

  test('late connection subscribers receive the current state once', () async {
    final eventConnection = EventConnection();
    final client = RoutingClient((request) async {
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => eventConnection.client,
    );
    addTearDown(repository.dispose);
    await repository.connect(config);

    final phases = <NodConnectionPhase>[];
    final subscription = repository.connectionStates.listen(
      (state) => phases.add(state.phase),
    );
    await Future<void>.delayed(Duration.zero);

    expect(phases, [NodConnectionPhase.connected]);
    await subscription.cancel();
    await repository.disconnect();
    expect(phases, [NodConnectionPhase.connected]);
    expect(
      await repository.connectionStates.first,
      isA<NodConnectionState>().having(
        (state) => state.phase,
        'phase',
        NodConnectionPhase.disconnected,
      ),
    );
  });

  for (final capped in [false, true]) {
    test(
      'connected chat reconciles hidden messages from another UI (capped: $capped)',
      () async {
        final events = EventConnection();
        final sendGate = Completer<http.StreamedResponse>();
        final oldVisible = {
          ..._message('old-visible', null, 'Keep older history'),
          'createdAt': '2026-11-05T12:00:00.000Z',
        };
        final hidden = _message('hidden', null, 'Retired confirmation');
        final recent = {
          ..._message('recent', null, 'Current reply'),
          'createdAt': '2026-11-07T12:00:00.000Z',
        };
        var retired = false;
        var historyReads = 0;
        final hiddenIds = capped
            ? List.generate(150, (index) => 'other-hidden-$index')
            : ['hidden'];
        final client = RoutingClient((request) async {
          switch (request.url.path) {
            case '/api/client/capabilities':
              return _jsonResponse(200, _capabilities());
            case '/api/session':
              return _jsonResponse(200, _session());
            case '/api/state':
              return _jsonResponse(200, {
                ..._state(messages: retired ? [recent] : [hidden, recent]),
                'hiddenMessageIds': retired ? hiddenIds : <String>[],
                'hiddenMessageCount': retired ? (capped ? 151 : 1) : 0,
              });
            case '/api/messages':
              if (request.method == 'POST') return sendGate.future;
              historyReads++;
              if (!retired) {
                return _jsonResponse(200, {
                  'messages': [oldVisible, hidden, recent],
                });
              }
              return request.url.queryParameters.containsKey('before')
                  ? _jsonResponse(200, {
                      'messages': [oldVisible],
                      'hasMore': false,
                    })
                  : _jsonResponse(200, {
                      'messages': [recent],
                      'hasMore': true,
                    });
            default:
              return _jsonResponse(404, {});
          }
        });
        final repository = HttpNodRepository(
          credentials: MemoryCredentials(),
          client: client,
          eventClientFactory: () => events.client,
        );
        final controller = ChatController(repository);
        addTearDown(() async {
          controller.dispose();
          await repository.dispose();
        });
        await repository.connect(config);
        await controller.start();
        expect(controller.messages.map((message) => message.id), [
          'old-visible',
          'hidden',
          'recent',
        ]);
        final sending = controller.sendText('Keep my in-flight send');
        expect(
          controller.messages.where((message) => message.isPending),
          hasLength(1),
        );
        retired = true;
        final refreshed = repository.events
            .where((event) => event is NodRefreshEvent)
            .first;
        events.add({'type': 'refresh'});
        final refresh = await refreshed as NodRefreshEvent;
        expect(refresh.state.hiddenMessageCount, capped ? 151 : 1);
        expect(refresh.state.hiddenMessageIds, hiddenIds);
        await Future<void>.delayed(Duration.zero);
        expect(
          controller.messages
              .where((message) => !message.isPending)
              .map((message) => message.id),
          ['old-visible', 'recent'],
        );
        expect(
          controller.messages.where((message) => message.isPending).single.text,
          'Keep my in-flight send',
        );
        expect(controller.isLoading, isFalse);
        expect(controller.failure, isNull);
        expect(historyReads, capped ? 3 : 1);
        if (!capped) {
          events.add({'type': 'message', 'message': hidden});
          events.add({
            'type': 'delta',
            'messageId': 'hidden',
            'text': 'stale delta',
          });
          await Future<void>.delayed(Duration.zero);
          expect(
            controller.messages.any((message) => message.id == 'hidden'),
            isFalse,
          );
        }
        sendGate.complete(_jsonResponse(200, {'messageId': 'accepted'}));
        expect(await sending, isTrue);
      },
    );
  }

  test(
    'a newer hide refresh fences an in-flight older history reload',
    () async {
      final events = EventConnection();
      final stalePage = Completer<http.StreamedResponse>();
      final older = {
        ..._message('older', null, 'Still visible'),
        'createdAt': '2026-11-05T12:00:00.000Z',
      };
      final retired = _message('retired', null, 'Hidden beyond metadata cap');
      final recent = _message('recent', null, 'Latest');
      var count = 0;
      var historyReads = 0;
      final client = RoutingClient((request) async {
        switch (request.url.path) {
          case '/api/client/capabilities':
            return _jsonResponse(200, _capabilities());
          case '/api/session':
            return _jsonResponse(200, _session());
          case '/api/state':
            return _jsonResponse(200, {
              ..._state(messages: [recent]),
              'hiddenMessageCount': count,
              'hiddenMessageIds': count == 0
                  ? <String>[]
                  : List.generate(150, (index) => 'hidden-$index'),
            });
          case '/api/messages':
            historyReads++;
            if (historyReads == 2) return stalePage.future;
            return _jsonResponse(200, {
              'messages': historyReads == 1
                  ? [older, retired, recent]
                  : [older, recent],
              'hasMore': false,
            });
          default:
            return _jsonResponse(404, {});
        }
      });
      final repository = HttpNodRepository(
        credentials: MemoryCredentials(),
        client: client,
        eventClientFactory: () => events.client,
      );
      final controller = ChatController(repository);
      addTearDown(() async {
        controller.dispose();
        await repository.dispose();
      });
      await repository.connect(config);
      await controller.start();
      for (final hiddenCount in [151, 152]) {
        count = hiddenCount;
        final refresh = repository.events
            .where((event) => event is NodRefreshEvent)
            .first;
        events.add({'type': 'refresh'});
        await refresh;
        await Future<void>.delayed(Duration.zero);
        expect(
          controller.messages.any((message) => message.id == 'retired'),
          isFalse,
        );
      }
      expect(historyReads, 3);
      expect(controller.messages.map((message) => message.id), [
        'older',
        'recent',
      ]);
      stalePage.complete(
        _jsonResponse(200, {
          'messages': [older, retired, recent],
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(controller.messages.map((message) => message.id), [
        'older',
        'recent',
      ]);
      expect(controller.failure, isNull);
    },
  );

  test(
    'reconciles refresh events and deduplicates client message IDs',
    () async {
      final eventConnection = EventConnection();
      var stateReads = 0;
      final client = RoutingClient((request) async {
        return switch (request.url.path) {
          '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
          '/api/session' => _jsonResponse(200, _session()),
          '/api/state' => _jsonResponse(
            200,
            stateReads++ == 0
                ? _state(messages: [_message('message-1', 'client-1', 'One')])
                : _state(
                    messages: [
                      _message('message-1', 'client-1', 'One'),
                      _message('message-2', 'client-1', 'Replacement'),
                      _message('message-3', 'client-3', 'Three'),
                      _message('message-3', 'client-4', 'Latest'),
                    ],
                  ),
          ),
          _ => _jsonResponse(404, {'error': 'not found'}),
        };
      });
      final repository = HttpNodRepository(
        credentials: MemoryCredentials(),
        client: client,
        eventClientFactory: () => eventConnection.client,
      );
      addTearDown(repository.dispose);
      await repository.connect(config);

      final refresh = repository.events
          .where((event) => event is NodRefreshEvent)
          .cast<NodRefreshEvent>()
          .first;
      final delta = repository.events
          .where((event) => event is NodMessageDeltaEvent)
          .cast<NodMessageDeltaEvent>()
          .first;
      final activity = repository.events
          .where((event) => event is NodActivityEvent)
          .cast<NodActivityEvent>()
          .first;
      eventConnection.add({'type': 'refresh'});
      eventConnection.add({
        'type': 'delta',
        'threadId': 'thread-1',
        'turnId': 'turn-1',
        'streamId': 'stream-1',
        'text': 'Hello',
        'done': true,
      });
      eventConnection.add({
        'type': 'activity',
        'items': [
          {
            'turnId': 'turn-1',
            'title': 'Synthetic work',
            'since': '2026-11-06T12:00:00.000Z',
          },
        ],
      });
      final state = (await refresh).state;
      final deltaEvent = await delta;
      final activityEvent = await activity;

      expect(state.messages.map((message) => message.id), [
        'message-2',
        'message-3',
      ]);
      expect(state.messages.first.text, 'Replacement');
      expect(state.messages.last.text, 'Latest');
      expect(deltaEvent.messageId, 'stream-1');
      expect(deltaEvent.done, isTrue);
      expect(activityEvent.turn, NodTurnState.running);
      expect(activityEvent.items.single.title, 'Synthetic work');
    },
  );

  test(
    'loads history with an opaque cursor bound to the active thread',
    () async {
      final eventConnection = EventConnection();
      final historyRequests = <Uri>[];
      final client = RoutingClient((request) async {
        if (request.url.path == '/api/messages' && request.method == 'GET') {
          historyRequests.add(request.url);
          return _jsonResponse(200, {
            'messages': historyRequests.length == 1
                ? [_message('history-1', null, 'Earlier')]
                : <Object?>[],
            'hasMore': historyRequests.length == 1,
          });
        }
        return switch (request.url.path) {
          '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
          '/api/session' => _jsonResponse(200, _session()),
          '/api/state' => _jsonResponse(200, _state()),
          _ => _jsonResponse(404, {'error': 'not found'}),
        };
      });
      final repository = HttpNodRepository(
        credentials: MemoryCredentials(),
        client: client,
        eventClientFactory: () => eventConnection.client,
      );
      addTearDown(repository.dispose);
      await repository.connect(config);

      final first = await repository.loadHistory();
      final second = await repository.loadHistory(cursor: first.nextCursor);

      expect(first.messages.single.id, 'history-1');
      expect(first.nextCursor, isNotNull);
      expect(second.messages, isEmpty);
      expect(historyRequests.last.queryParameters, {
        'threadId': 'thread-1',
        'before': '2026-11-06T12:00:00.000Z',
        'beforeId': 'history-1',
      });
    },
  );

  test('maps reset and duplicate client ID conflicts', () async {
    final eventConnection = EventConnection();
    var messageCalls = 0;
    final client = RoutingClient((request) async {
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        '/api/messages' when request.method == 'GET' => _jsonResponse(409, {
          'error': 'This conversation has been reset.',
        }),
        '/api/messages' => _jsonResponse(
          409,
          messageCalls++ == 0
              ? {'error': 'This message ID is already in use.'}
              : {'error': 'Conflict'},
        ),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => eventConnection.client,
    );
    addTearDown(repository.dispose);
    await repository.connect(config);

    await expectLater(
      repository.loadHistory(),
      throwsA(
        isA<NodConflictException>().having(
          (error) => error.kind,
          'kind',
          NodConflictKind.conversationReset,
        ),
      ),
    );
    await expectLater(
      repository.sendText('One', clientMessageId: 'duplicate-id'),
      throwsA(
        isA<NodConflictException>().having(
          (error) => error.kind,
          'kind',
          NodConflictKind.duplicateClientMessage,
        ),
      ),
    );
  });

  test('reconnects exponentially and reconciles state', () async {
    final first = EventConnection();
    final recovered = EventConnection();
    var eventClients = 0;
    var stateReads = 0;
    final delays = <Duration>[];
    final client = RoutingClient((request) async {
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(
          200,
          _state(
            revision: 'revision-${++stateReads}',
            messages: [_message('message-$stateReads', null, 'State')],
          ),
        ),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    http.Client eventFactory() {
      eventClients++;
      return switch (eventClients) {
        1 => first.client,
        2 || 3 => RoutingClient((request) async {
          throw const SocketException('synthetic reconnect failure');
        }),
        _ => recovered.client,
      };
    }

    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: eventFactory,
      reconnectDelays: const [
        Duration(milliseconds: 1),
        Duration(milliseconds: 2),
        Duration(milliseconds: 4),
      ],
      delay: (duration) async {
        delays.add(duration);
      },
    );
    addTearDown(repository.dispose);
    final streamErrors = <Object>[];
    final errorSubscription = repository.events.listen(
      (_) {},
      onError: (Object error) => streamErrors.add(error),
    );
    addTearDown(errorSubscription.cancel);
    var connected = 0;
    final reconnected = Completer<void>();
    final connectionSubscription = repository.connectionStates.listen((state) {
      if (state.phase == NodConnectionPhase.connected) {
        connected++;
        if (connected == 2 && !reconnected.isCompleted) reconnected.complete();
      }
    });
    addTearDown(connectionSubscription.cancel);

    await repository.connect(config);
    await first.close();
    await reconnected.future.timeout(const Duration(seconds: 1));

    expect(delays, const [
      Duration(milliseconds: 1),
      Duration(milliseconds: 2),
      Duration(milliseconds: 4),
    ]);
    expect(stateReads, 2);
    expect(streamErrors, everyElement(isA<NodOfflineException>()));
  });

  test('disposal cancels the active event stream', () async {
    final eventConnection = EventConnection();
    final client = RoutingClient((request) async {
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final repository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => eventConnection.client,
    );

    await repository.connect(config);
    await repository.dispose();

    expect(eventConnection.cancelled, isTrue);
  });
}

Map<String, Object?> _capabilities() => {
  'contractVersion': 1,
  'authentication': {'mode': 'bearer'},
};

Map<String, Object?> _session() => {
  'user': {'id': 'owner-1'},
};

Map<String, Object?> _state({
  String revision = 'revision-1',
  List<Map<String, Object?>>? messages,
}) => {
  'threadId': 'thread-1',
  'revision': revision,
  'messages': messages ?? <Map<String, Object?>>[],
  'turns': <Map<String, Object?>>[],
};

Map<String, Object?> _message(String id, String? clientMessageId, String text) {
  final message = <String, Object?>{
    'id': id,
    'role': 'user',
    'text': text,
    'createdAt': '2026-11-06T12:00:00.000Z',
  };
  if (clientMessageId != null) message['clientMessageId'] = clientMessageId;
  return message;
}

http.StreamedResponse _jsonResponse(int status, Object body) {
  return http.StreamedResponse(
    Stream.value(utf8.encode(jsonEncode(body))),
    status,
    headers: {'content-type': 'application/json'},
  );
}

final class RoutingClient extends http.BaseClient {
  RoutingClient(this._handler);

  final Future<http.StreamedResponse> Function(http.BaseRequest request)
  _handler;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      _handler(request);
}

final class EventConnection {
  EventConnection({String? expectedAuthorization}) {
    _controller = StreamController<List<int>>(
      onCancel: () {
        cancelled = true;
      },
    );
    client = RoutingClient((request) async {
      expect(request.followRedirects, isFalse);
      if (expectedAuthorization != null) {
        authorizationMatches =
            request.headers['Authorization'] == expectedAuthorization;
      }
      return http.StreamedResponse(
        _controller.stream,
        200,
        headers: {'content-type': 'text/event-stream'},
      );
    });
  }

  late final StreamController<List<int>> _controller;
  late final http.Client client;
  bool authorizationMatches = false;
  bool cancelled = false;

  void add(Map<String, Object?> event) {
    _controller.add(utf8.encode('data: ${jsonEncode(event)}\n\n'));
  }

  Future<void> close() => _controller.close();
}

final class ThrowingCredentials implements NodCredentialStorage {
  ThrowingCredentials({this.readError, this.writeError, this.deleteError});

  final Object? readError;
  final Object? writeError;
  final Object? deleteError;

  @override
  Future<void> delete() async {
    if (deleteError case final error?) throw error;
  }

  @override
  Future<NodConnectionConfig?> read() async {
    if (readError case final error?) throw error;
    return null;
  }

  @override
  Future<void> write(NodConnectionConfig config) async {
    if (writeError case final error?) throw error;
  }
}

final class MemoryCredentials implements NodCredentialStorage {
  NodConnectionConfig? value;

  @override
  Future<void> delete() async {
    value = null;
  }

  @override
  Future<NodConnectionConfig?> read() async => value;

  @override
  Future<void> write(NodConnectionConfig config) async {
    value = config;
  }
}
