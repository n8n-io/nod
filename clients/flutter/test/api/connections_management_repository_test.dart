import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:nod_client/api/api.dart';
import 'package:nod_client/api/connections_management_repository.dart';
import 'package:nod_client/core/api_transport.dart';
import 'package:nod_client/core/connections_management.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/features/connections/channel_setup_page.dart';
import 'package:nod_client/features/connections/connection_setup_page.dart';
import 'package:qr_flutter/qr_flutter.dart';

void main() {
  const token = 'synthetic-secret-token';
  final config = NodConnectionConfig(
    origin: Uri.parse('https://nod.example.test'),
    token: token,
  );

  testWidgets(
    'linked WhatsApp creates only the chosen policy-approved binding and cancels it on close',
    (tester) async {
      final fixture = LinkedWhatsAppFixture();
      await openWhatsApp(tester, fixture);
      expect(find.byType(QrImageView), findsNothing);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Show QR code'),
            )
            .onPressed,
        isNull,
      );
      await tester.enterText(find.byType(TextField), '15555550123');
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pump();
      await tester.ensureVisible(find.text('Show QR code'));
      await tester.tap(find.text('Show QR code'));
      await tester.pumpAndSettle();
      expect(fixture.creates.single, {
        'mode': 'bot',
        'allowedNumber': '15555550123',
        'policyConfirmed': true,
      });
      expect(find.byType(QrImageView), findsOneWidget);
      expect(
        tester.widget<QrImageView>(find.byType(QrImageView)).semanticsLabel,
        'Link WhatsApp to Nod',
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(fixture.cancelled, [fixture.id]);
      expect(fixture.enabled, isFalse);
      expect(find.text('Open WhatsApp setup'), findsOneWidget);
    },
  );

  testWidgets(
    'linked WhatsApp self-chat never submits a personal-number binding',
    (tester) async {
      final fixture = LinkedWhatsAppFixture();
      await openWhatsApp(tester, fixture);
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Use my own number').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pump();
      await tester.ensureVisible(find.text('Show QR code'));
      await tester.tap(find.text('Show QR code'));
      await tester.pumpAndSettle();
      expect(fixture.creates.single, {
        'mode': 'self-chat',
        'policyConfirmed': true,
      });
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      expect(fixture.cancelled.length, 1);
    },
  );

  testWidgets(
    'linked QR expires locally, hides in background and refreshes to connected without unlinking',
    (tester) async {
      final fixture = LinkedWhatsAppFixture(enabled: true)
        ..lifetime = const Duration(seconds: 1);
      await openWhatsApp(tester, fixture);
      expect(find.byType(QrImageView), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 1100));
      expect(find.byType(QrImageView), findsNothing);
      fixture.lifetime = const Duration(minutes: 1);
      final pending = Completer<Object?>();
      fixture.pendingRead = pending;
      await tester.ensureVisible(find.text('Refresh WhatsApp status'));
      await tester.tap(find.text('Refresh WhatsApp status'));
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      pending.complete(fixture.status());
      await tester.pump();
      final reads = fixture.reads;
      await tester.pump(const Duration(seconds: 5));
      expect(fixture.reads, reads);
      expect(find.byType(QrImageView), findsNothing);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.byType(QrImageView), findsOneWidget);
      fixture.state = 'connected';
      await tester.ensureVisible(find.text('Refresh WhatsApp status'));
      await tester.tap(find.text('Refresh WhatsApp status'));
      await tester.pumpAndSettle();
      expect(find.byType(QrImageView), findsNothing);
      await tester.ensureVisible(find.text('Done'));
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      expect(fixture.enabled, isTrue);
      expect(fixture.cancelled, isEmpty);
    },
  );

  testWidgets(
    'renewal fences a stale in-flight read and cancellation uses only the renewed pairing',
    (tester) async {
      final fixture = LinkedWhatsAppFixture(enabled: true)..state = 'expired';
      await openWhatsApp(tester, fixture);
      final oldId = fixture.id;
      final pending = Completer<Object?>();
      fixture.pendingRead = pending;
      await tester.ensureVisible(find.text('Refresh WhatsApp status'));
      await tester.tap(find.text('Refresh WhatsApp status'));
      await tester.pump();
      await tester.ensureVisible(find.text('Start again'));
      await tester.tap(find.text('Start again'));
      await tester.pumpAndSettle();
      expect(fixture.restarted, [oldId]);
      expect(find.byType(QrImageView), findsOneWidget);
      pending.complete({'pairingId': oldId, 'state': 'expired'});
      await tester.pumpAndSettle();
      expect(find.byType(QrImageView), findsOneWidget);
      await tester.ensureVisible(find.text('Cancel setup'));
      await tester.tap(find.text('Cancel setup'));
      await tester.pumpAndSettle();
      expect(fixture.cancelled, [fixture.id]);
      expect(fixture.id == oldId, isFalse);
    },
  );

  testWidgets(
    'read and cancellation failure hide QR and keep unfinished setup open for an exact retry',
    (tester) async {
      final fixture = LinkedWhatsAppFixture(enabled: true);
      await openWhatsApp(tester, fixture);
      fixture.failRead = true;
      await tester.ensureVisible(find.text('Refresh WhatsApp status'));
      await tester.tap(find.text('Refresh WhatsApp status'));
      await tester.pumpAndSettle();
      expect(find.byType(QrImageView), findsNothing);
      fixture.failCancel = true;
      await tester.ensureVisible(find.text('Cancel setup'));
      await tester.tap(find.text('Cancel setup'));
      await tester.pumpAndSettle();
      expect(find.text('Open WhatsApp setup'), findsNothing);
      expect(fixture.enabled, isTrue);
      fixture.failCancel = false;
      await tester.tap(find.text('Cancel setup'));
      await tester.pumpAndSettle();
      expect(fixture.cancelled, [fixture.id]);
      expect(fixture.enabled, isFalse);
    },
  );

  testWidgets(
    'managed linked setup permits renewal but never disconnects or cancels on close',
    (tester) async {
      final fixture = LinkedWhatsAppFixture(enabled: true, managed: true)
        ..state = 'logged_out';
      await openWhatsApp(tester, fixture);
      expect(find.text('Disconnect'), findsNothing);
      await tester.ensureVisible(find.text('Start again'));
      await tester.tap(find.text('Start again'));
      await tester.pumpAndSettle();
      expect(fixture.restarted.length, 1);
      expect(find.byType(QrImageView), findsOneWidget);
      await tester.ensureVisible(find.text('Cancel setup'));
      await tester.tap(find.text('Cancel setup'));
      await tester.pumpAndSettle();
      expect(fixture.cancelled, isEmpty);
      expect(fixture.enabled, isTrue);
    },
  );

  testWidgets(
    'disconnect removes a connected linked device only after owner confirmation',
    (tester) async {
      final fixture = LinkedWhatsAppFixture(enabled: true)..state = 'connected';
      await openWhatsApp(tester, fixture);
      await tester.ensureVisible(find.text('Disconnect'));
      await tester.tap(find.text('Disconnect'));
      await tester.pumpAndSettle();
      expect(fixture.removals, 0);
      await tester.tap(find.widgetWithText(FilledButton, 'Disconnect'));
      await tester.pumpAndSettle();
      expect(fixture.removals, 1);
      expect(fixture.enabled, isFalse);
      expect(find.byType(QrImageView), findsNothing);
      await tester.pumpWidget(const SizedBox());
      expect(fixture.cancelled, isEmpty);
    },
  );

  for (final outcome in ['connected', 'expired', 'cancelled']) {
    testWidgets(
      'OAuth foreground refresh handles $outcome without duplicate dispatch',
      (tester) async {
        final events = EventConnection();
        var activeOutcome = 'waiting';
        var cancels = 0;
        final client = RoutingClient((request) async {
          expect(request.headers['Authorization'], 'Bearer $token');
          if (request.url.path == '/api/apps/setup-status') {
            final body = jsonDecode(
              utf8.decode(await request.finalize().toBytes()),
            ) as Map;
            final hash = (body['hashes'] as List).single;
            return _jsonResponse(200, {
              'completed': activeOutcome == 'connected' ? [hash] : <Object?>[],
              'apps': activeOutcome == 'waiting'
                  ? [
                      {'hash': hash, 'available': true},
                    ]
                  : <Object?>[],
            });
          }
          if (request.url.path == '/api/apps/setup-cancel') {
            cancels++;
            return _jsonResponse(200, {'ok': true});
          }
          return switch (request.url.path) {
            '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
            '/api/session' => _jsonResponse(200, _session()),
            '/api/state' => _jsonResponse(200, _state()),
            '/api/messages' => _jsonResponse(200, {'messages': <Object?>[]}),
            _ => _jsonResponse(404, {'error': 'not found'}),
          };
        });
        final httpRepository = HttpNodRepository(
          credentials: MemoryCredentials(),
          client: client,
          eventClientFactory: () => events.client,
        );
        addTearDown(httpRepository.dispose);
        await httpRepository.connect(config);
        final management = NodConnectionsManagementRepository(httpRepository);
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => NodConnectionSetupPage(
                        repository: management,
                        name: 'Synthetic account',
                        initialAttempt: NodConnectionAttempt(
                          url: Uri.parse(
                            'https://auth.example.test/consent?state=synthetic',
                          ),
                        ),
                      ),
                    ),
                  ),
                  child: const Text('Setup'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Setup'));
        await tester.pumpAndSettle();
        expect(find.text('Open sign-in'), findsOneWidget);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        activeOutcome = outcome;
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
        if (outcome == 'connected') {
          expect(find.text('Account connected.'), findsOneWidget);
          await tester.tap(find.text('Done'));
        } else {
          expect(find.text('Open sign-in'), findsNothing);
          await tester.tap(find.text('Cancel'));
        }
        await tester.pumpAndSettle();
        expect(find.text('Setup'), findsOneWidget);
        expect(cancels, outcome == 'connected' ? 0 : 1);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'failed private HTTP setup clears the credential and never displays server details',
    (tester) async {
      const id = '00000000-0000-4000-8000-000000000004';
      final events = EventConnection();
      var writes = 0;
      final client = RoutingClient((request) async {
        expect(request.headers['Authorization'], 'Bearer $token');
        if (request.url.path == '/api/apps/discovery/$id') {
          return _jsonResponse(200, {
            'name': 'Synthetic HTTP service',
            'paths': [
              {
                'kind': 'http',
                'endpoint': 'https://api.example.test',
                'auth': 'bearer',
                'testPath': '/status',
              },
            ],
          });
        }
        if (request.url.path == '/api/apps/discovery/$id/complete') {
          final body = jsonDecode(
            utf8.decode(await request.finalize().toBytes()),
          ) as Map;
          expect(body['token'], 'synthetic-private-value');
          writes++;
          return _jsonResponse(409, {
            'error': 'synthetic-private-value must not appear in UI',
          });
        }
        return switch (request.url.path) {
          '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
          '/api/session' => _jsonResponse(200, _session()),
          '/api/state' => _jsonResponse(200, _state()),
          '/api/messages' => _jsonResponse(200, {'messages': <Object?>[]}),
          _ => _jsonResponse(404, {'error': 'not found'}),
        };
      });
      final httpRepository = HttpNodRepository(
        credentials: MemoryCredentials(),
        client: client,
        eventClientFactory: () => events.client,
      );
      addTearDown(httpRepository.dispose);
      await httpRepository.connect(config);
      await tester.pumpWidget(
        MaterialApp(
          home: NodConnectionSetupPage(
            repository: NodConnectionsManagementRepository(httpRepository),
            name: 'Synthetic HTTP service',
            discoveryId: id,
          ),
        ),
      );
      await tester.pumpAndSettle();
      final field = find.byWidgetPredicate(
        (widget) => widget is TextField && widget.obscureText,
      );
      await tester.enterText(field, 'synthetic-private-value');
      await tester.ensureVisible(find.text('Save connection'));
      await tester.tap(find.text('Save connection'));
      await tester.pumpAndSettle();
      expect(writes, 1);
      expect(tester.widget<TextField>(field).controller!.text, isEmpty);
      expect(find.textContaining('synthetic-private-value'), findsNothing);
      expect(find.text('Account connected.'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  test('connection management binds removal, reconnect and additional accounts to the paired owner', () async {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    final events = EventConnection();
    final calls = <Map<String, Object?>>[];
    final remaining = <String>{first, second};
    final client = RoutingClient((request) async {
      expect(request.headers['Authorization'], 'Bearer $token');
      expect(request.url.origin, config.origin.origin);
      if (request.url.path.startsWith('/api/apps')) {
        final body = request.method == 'GET'
            ? null
            : jsonDecode(utf8.decode(await request.finalize().toBytes()));
        calls.add({
          'method': request.method,
          'path': request.url.path,
          'body': body,
        });
        if (request.url.path.endsWith('/disconnect')) {
          final id = request.url.pathSegments[4];
          if (!remaining.remove(id)) {
            return _jsonResponse(404, {'error': 'Unavailable'});
          }
          return _jsonResponse(200, {'ok': true});
        }
        if (request.url.path.endsWith('/connect')) {
          return _jsonResponse(200, {
            'url': 'https://auth.example.test/consent?state=synthetic',
          });
        }
        return _jsonResponse(200, [
          for (final id in remaining)
            {
              'connectionId': id,
              'slug': 'synthetic',
              'name': 'Synthetic',
              'status': 'connected',
              'canReconnect': true,
              'accountName': id == first
                  ? 'First synthetic account'
                  : 'Second synthetic account',
              'accessPaths': [
                {'kind': 'http', 'endpoint': 'https://api.example.test'},
              ],
            },
        ]);
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        '/api/messages' => _jsonResponse(200, {'messages': <Object?>[]}),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final httpRepository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => events.client,
    );
    addTearDown(httpRepository.dispose);
    await httpRepository.connect(config);
    final management = NodConnectionsManagementRepository(httpRepository);
    final accounts = await management.load();
    await management.connect(accounts.first);
    expect(calls.last['body'], {'returnTo': 'window', 'connectionId': first});
    await management.connect(accounts.first, additional: true);
    expect(calls.last['body'], {
      'returnTo': 'window',
      'newAccount': true,
      'connectionId': first,
    });
    await management.disconnect(accounts.first);
    expect((await management.load()).single.id, second);
    await expectLater(
      management.disconnect(accounts.first),
      throwsA(isA<NodException>()),
    );
    expect((await management.load()).single.id, second);
    expect(
      () => management.launchAddress(
        Uri.parse('https://auth.example.test/?access_token=not-a-real-token'),
      ),
      throwsFormatException,
    );
    expect(
      () => management.launchAddress(
        Uri.parse('http://private.example.test/consent'),
      ),
      throwsFormatException,
    );
    expect(
      management
          .launchAddress(
            Uri.parse('http://localhost:5678/consent'),
            instance: 'http://localhost:5678',
          )
          .host,
      'localhost',
    );
    expect(
      () => management.launchAddress(
        Uri.parse('http://localhost:5679/consent'),
        instance: 'http://localhost:5678',
      ),
      throwsFormatException,
    );
  });

  test('native discovery keeps private settings in authenticated request bodies and fences OAuth cancellation by hash', () async {
    const id = '00000000-0000-4000-8000-000000000003';
    final events = EventConnection();
    final calls = <Map<String, Object?>>[];
    var completed = false;
    var cancelled = false;
    final client = RoutingClient((request) async {
      expect(request.headers['Authorization'], 'Bearer $token');
      expect(request.url.origin, config.origin.origin);
      expect(request.url.query, isEmpty);
      if (request.url.path.startsWith('/api/apps') ||
          request.url.path.startsWith('/api/channel-settings')) {
        final bytes = await request.finalize().toBytes();
        final body = bytes.isEmpty ? null : jsonDecode(utf8.decode(bytes));
        calls.add({
          'method': request.method,
          'path': request.url.path,
          'body': body,
        });
        if (request.url.path == '/api/apps/mcp') {
          return _jsonResponse(200, {'id': id});
        }
        if (request.url.path == '/api/apps/n8n/connect') {
          return _jsonResponse(200, {
            'url': 'https://nod.example.test/apps?connect=$id',
          });
        }
        if (request.url.path == '/api/apps/discovery/$id') {
          return _jsonResponse(200, {
            'name': 'Synthetic API',
            'paths': [
              {
                'kind': 'http',
                'endpoint': 'https://api.example.test',
                'auth': 'bearer',
                'testPath': '/status',
              },
            ],
          });
        }
        if (request.url.path.endsWith('/authorize')) {
          return _jsonResponse(200, {
            'url': 'https://auth.example.test/consent?state=synthetic',
            'attempt': 'a' * 43,
          });
        }
        if (request.url.path == '/api/apps/setup-status') {
          final hash = (body['hashes'] as List).single;
          return _jsonResponse(200, {
            'completed': completed ? [hash] : <Object?>[],
            'apps': completed || cancelled
                ? <Object?>[]
                : [
                    {'hash': hash, 'available': true},
                  ],
          });
        }
        if (request.url.path == '/api/apps/setup-cancel') cancelled = true;
        return _jsonResponse(200, {'ok': true});
      }
      return switch (request.url.path) {
        '/api/client/capabilities' => _jsonResponse(200, _capabilities()),
        '/api/session' => _jsonResponse(200, _session()),
        '/api/state' => _jsonResponse(200, _state()),
        '/api/messages' => _jsonResponse(200, {'messages': <Object?>[]}),
        _ => _jsonResponse(404, {'error': 'not found'}),
      };
    });
    final httpRepository = HttpNodRepository(
      credentials: MemoryCredentials(),
      client: client,
      eventClientFactory: () => events.client,
    );
    addTearDown(httpRepository.dispose);
    await httpRepository.connect(config);
    final management = NodConnectionsManagementRepository(httpRepository);
    expect(
      await management.createMcp(
        name: 'Synthetic MCP',
        endpoint: 'https://mcp.example.test',
        auth: 'bearer',
        clientIdRequired: false,
      ),
      id,
    );
    final discovery = await management.discovery(id);
    expect(discovery.paths.single['testPath'], '/status');
    await management.complete(
      id,
      'Synthetic account',
      'synthetic-private-value',
    );
    expect(calls.last['body'], {
      'accountName': 'Synthetic account',
      'token': 'synthetic-private-value',
    });
    final proposal = await management.connect(
      NodManagedConnection.fromJson({
        'slug': 'n8n',
        'name': 'n8n',
        'status': 'disconnected',
      }),
    );
    expect(proposal.discoveryId, id);
    expect(proposal.url, isNull);
    final oauthDiscovery = NodConnectionDiscovery.fromJson(
      '00000000-0000-4000-8000-000000000005',
      {
        'name': 'Synthetic OAuth service',
        'attempt': 'b' * 43,
        'paths': [
          {
            'kind': 'mcp',
            'endpoint': 'https://mcp.example.test',
            'auth': 'oauth',
          },
        ],
      },
    );
    final attempt = await management.authorize(
      oauthDiscovery,
      clientId: 'synthetic-client',
    );
    expect(calls.last['body'], {
      'returnTo': 'window',
      'restart': true,
      'restartAttempt': 'b' * 43,
      'clientId': 'synthetic-client',
    });
    expect(
      await management.progress(attempt.url!),
      NodConnectionProgress.waiting,
    );
    completed = true;
    expect(
      await management.progress(attempt.url!),
      NodConnectionProgress.connected,
    );
    completed = false;
    await management.cancel(attempt.url!);
    expect((calls.last['body'] as Map).keys, ['hash']);
    expect(
      (calls.last['body'] as Map)['hash'],
      matches(RegExp(r'^[a-f0-9]{64}$')),
    );
    expect(
      await management.progress(attempt.url!),
      NodConnectionProgress.unavailable,
    );
    await management.saveChannel('telegram', {
      'botToken': 'synthetic-bot-token',
    });
    expect(calls.last['method'], 'PUT');
    expect(calls.last['body'], {'botToken': 'synthetic-bot-token'});
    await management.telegram('user', userId: '123456789');
    expect(calls.last['body'], {'allowedUserId': '123456789'});
    await management.removeChannel('whatsapp');
    expect(calls.last['method'], 'DELETE');
    expect(() => management.removeChannel('../other'), throwsFormatException);
  });
}

Map<String, Object?> _capabilities() => {
  'contractVersion': 1,
  'authentication': {'mode': 'bearer'},
};

Map<String, Object?> _session() => {
  'user': {'id': 'owner-1'},
};

Map<String, Object?> _state() => {
  'threadId': 'thread-1',
  'messages': <Object?>[],
  'turns': <Object?>[],
};

http.StreamedResponse _jsonResponse(int status, Object body) =>
    http.StreamedResponse(
      Stream.value(utf8.encode(jsonEncode(body))),
      status,
      headers: {'content-type': 'application/json'},
    );

final class RoutingClient extends http.BaseClient {
  RoutingClient(this.handler);
  final Future<http.StreamedResponse> Function(http.BaseRequest) handler;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      handler(request);
}

final class EventConnection {
  final controller = StreamController<List<int>>();
  late final client = RoutingClient(
    (request) async => http.StreamedResponse(
      controller.stream,
      200,
      headers: {'content-type': 'text/event-stream'},
    ),
  );
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

Future<void> openWhatsApp(
  WidgetTester tester,
  LinkedWhatsAppFixture fixture,
) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => NodChannelSetupPage(
                  repository: NodConnectionsManagementRepository(fixture),
                  provider: 'whatsapp',
                ),
              ),
            ),
            child: const Text('Open WhatsApp setup'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open WhatsApp setup'));
  await tester.pumpAndSettle();
}

class LinkedWhatsAppFixture implements NodApiTransport {
  LinkedWhatsAppFixture({this.enabled = false, this.managed = false});
  bool enabled;
  final bool managed;
  String state = 'awaiting_scan';
  String mode = 'bot';
  int revision = 1;
  int reads = 0;
  int removals = 0;
  bool failRead = false;
  bool failCancel = false;
  Duration lifetime = const Duration(minutes: 1);
  Completer<Object?>? pendingRead;
  final creates = <Map<String, Object?>>[];
  final restarted = <String>[];
  final cancelled = <String>[];
  String get id =>
      '00000000-0000-4000-8000-${revision.toString().padLeft(12, '0')}';

  Map<String, Object?> status() => {
    'pairingId': id,
    'state': state,
    if (state == 'awaiting_scan') ...{
      'qr': 'fixture-private-pairing-$revision',
      'expiresAt': DateTime.now().add(lifetime).toUtc().toIso8601String(),
    },
    if (state == 'connected') 'accountName': 'Fixture owner',
  };

  @override
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    if (path == '/api/channel-settings' && method == 'GET') {
      return {
        'channels': [
          {
            'provider': 'whatsapp',
            'enabled': enabled,
            'managed': managed,
            'mode': 'linked',
            'linkMode': mode,
            'connectionState': state,
          },
        ],
      };
    }
    if (path == '/api/channel-settings/whatsapp' && method == 'PUT') {
      if (managed ||
          body?['policyConfirmed'] != true ||
          !{'bot', 'self-chat'}.contains(body?['mode'])) {
        throw StateError('Setup refused');
      }
      if (body!['mode'] == 'bot' &&
          !RegExp(r'^\d{7,15}$')
              .hasMatch(body['allowedNumber'] as String? ?? '')) {
        throw StateError('Binding refused');
      }
      if (body['mode'] == 'self-chat' && body.containsKey('allowedNumber')) {
        throw StateError('Unexpected binding');
      }
      creates.add(body);
      mode = body['mode'] as String;
      enabled = true;
      return {'ok': true};
    }
    if (path == '/api/channel-settings/whatsapp' && method == 'DELETE') {
      if (managed) throw StateError('Managed channel');
      removals++;
      enabled = false;
      return {'ok': true};
    }
    if (path != '/api/channel-settings/whatsapp/pairing' || !enabled) {
      throw StateError('Pairing unavailable');
    }
    if (method == 'GET') {
      reads++;
      if (failRead) throw StateError('Synthetic read failure');
      final pending = pendingRead;
      pendingRead = null;
      return pending == null ? status() : await pending.future;
    }
    if (body?.length != 1 || body?['pairingId'] != id) {
      throw StateError('Pairing changed');
    }
    if (method == 'POST') {
      restarted.add(id);
      revision++;
      state = 'awaiting_scan';
      return status();
    }
    if (method == 'DELETE') {
      if (managed || failCancel) throw StateError('Cancellation refused');
      if (state != 'connected') {
        cancelled.add(id);
        enabled = false;
      }
      return {'ok': true};
    }
    throw StateError('Unsupported fixture request');
  }
}
