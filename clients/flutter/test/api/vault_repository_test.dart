import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:nod_client/api/http_nod_repository.dart';
import 'package:nod_client/api/vault_repository.dart';
import 'package:nod_client/core/api_transport.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/vault.dart';
import 'package:nod_client/features/vault/vault_form.dart';
import 'package:nod_client/features/vault/vault_page.dart';

import 'http_nod_repository_test.dart' as fixture;

const _id = '11111111-1111-4111-8111-111111111111';
Map<String, Object?> _login({String revision = '2026-01-01T00:00:00Z'}) => {
  'id': _id,
  'kind': 'login',
  'label': 'Synthetic reports',
  'origin': 'https://reports.example.test',
  'username': 'synthetic@example.test',
  'usernameHint': 'sy…',
  'updatedAt': revision,
  'hasPassword': true,
  'hasAuthenticator': true,
};

Map<String, Object?> _session({
  String state = 'needs_sign_in',
  String url = 'https://reports.example.test/weekly',
}) => {
  'id': _id,
  'kind': 'session',
  'label': 'Synthetic session',
  'origin': 'https://reports.example.test',
  'url': url,
  'state': state,
};

void main() {
  late HttpNodRepository transport;
  late NodVaultRepository repository;
  late _ScopedTransport scoped;
  late Future<http.StreamedResponse> Function(
    http.BaseRequest request,
    Object? body,
  )
  route;
  final requests = <({String method, Uri uri, Object? body})>[];
  final clipboardWrites = <String>[];
  Completer<void>? clipboardCompletion;
  setUp(() async {
    clipboardWrites.clear();
    clipboardCompletion = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboardWrites.add((call.arguments as Map)['text']! as String);
            await clipboardCompletion?.future;
          }
          if (call.method == 'Clipboard.getData') {
            fail('Vault must not read the clipboard.');
          }
          return null;
        });
    requests.clear();
    route = (request, body) async => _json(404, {'error': 'Not found'});
    transport = HttpNodRepository(
      credentials: fixture.MemoryCredentials(),
      eventClientFactory: () => fixture.EventConnection().client,
      client: fixture.RoutingClient((request) async {
        expect(request.url.origin, 'https://nod.example.test');
        expect(
          request.headers['Authorization'],
          'Bearer synthetic-vault-owner',
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
          });
        }
        if (request.url.path == '/api/state') {
          return _json(200, {
            'threadId': 'synthetic-thread',
            'revision': '1',
            'messages': <Object?>[],
            'turns': <Object?>[],
          });
        }
        final bytes = await request.finalize().toBytes();
        final body = bytes.isEmpty ? null : jsonDecode(utf8.decode(bytes));
        requests.add((method: request.method, uri: request.url, body: body));
        return route(request, body);
      }),
    );
    await transport.connect(
      NodConnectionConfig(
        origin: Uri.parse('https://nod.example.test'),
        token: 'synthetic-vault-owner',
      ),
    );
    scoped = _ScopedTransport(transport);
    repository = NodVaultRepository(scoped);
  });
  tearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
    await transport.dispose();
  });

  test(
    'metadata and details use authenticated owner routes without reveal',
    () async {
      route = (request, body) async {
        if (request.url.path == '/api/vault') return _json(200, [_login()]);
        expect(request.method, 'POST');
        expect(request.url.path, '/api/vault/$_id/details');
        expect(body, isEmpty);
        return _json(200, _login());
      };
      final items = await repository.list();
      final details = await repository.details(items.single);
      expect(details.identity, 'synthetic@example.test');
      expect(details.data.containsKey('password'), false);
      expect(requests.length, 2);
    },
  );

  test(
    'detail target mismatch refuses edit and clears entered secrets',
    () async {
      route = (request, body) async =>
          _json(200, {..._login(), 'origin': 'https://other.example.test'});
      final values = <String, Object?>{
        'kind': 'login',
        'label': 'Updated',
        'username': '',
        'password': 'synthetic-only',
      };
      await expectLater(
        repository.save(values, item: NodVaultItem(_login())),
        throwsStateError,
      );
      expect(values, isEmpty);
      expect(requests.map((r) => r.method), ['POST']);
    },
  );

  test('observed stale revision blocks patch and secret reveal', () async {
    route = (request, body) async =>
        _json(200, _login(revision: '2026-02-01T00:00:00Z'));
    final item = NodVaultItem(_login());
    await expectLater(
      repository.save({'label': 'New'}, item: item),
      throwsStateError,
    );
    await expectLater(repository.reveal(item), throwsStateError);
    expect(requests.every((r) => r.uri.path.endsWith('/details')), true);
  });

  test(
    'edit sends only replacements and preserves exact item binding',
    () async {
      route = (request, body) async {
        if (request.method == 'PATCH') {
          expect(body, {
            'kind': 'login',
            'label': 'Renamed',
            'username': 'synthetic@example.test',
          });
          return _json(200, {..._login(), 'label': 'Renamed'});
        }
        return _json(200, _login());
      };
      final values = <String, Object?>{
        'kind': 'login',
        'label': 'Renamed',
        'username': 'synthetic@example.test',
      };
      expect(
        (await repository.save(values, item: NodVaultItem(_login()))).label,
        'Renamed',
      );
      expect(values, isEmpty);
      expect(requests.last.method, 'PATCH');
    },
  );

  test('foreign or deleted owner item refuses before mutation', () async {
    route = (request, body) async => _json(404, {'error': 'Not found'});
    final values = <String, Object?>{'password': 'synthetic-only'};
    await expectLater(
      repository.save(values, item: NodVaultItem(_login())),
      throwsA(isA<NodException>()),
    );
    expect(values, isEmpty);
    expect(requests.any((r) => r.method == 'PATCH'), false);
  });

  test('pending mutation is not dispatched twice', () async {
    final pending = Completer<http.StreamedResponse>();
    route = (request, body) => pending.future;
    final first = repository.save({'kind': 'login'});
    final duplicate = <String, Object?>{'password': 'synthetic-only'};
    await expectLater(repository.save(duplicate), throwsStateError);
    expect(duplicate, isEmpty);
    pending.complete(_json(200, _login()));
    await first;
    expect(requests.length, 1);
  });

  test(
    'delete works for unreadable metadata without retrieving secrets',
    () async {
      final item = NodVaultItem({..._login(), 'unreadable': true});
      route = (request, body) async => request.method == 'GET'
          ? _json(200, [item.data])
          : _json(200, {'ok': true});
      await repository.remove(item);
      expect(requests.map((r) => '${r.method} ${r.uri.path}'), [
        'GET /api/vault',
        'DELETE /api/vault/$_id',
      ]);
    },
  );

  test(
    'session sign-out refuses changed state then deletes exact current session',
    () async {
      final data = {
        'id': _id,
        'kind': 'session',
        'label': 'Reports',
        'origin': 'https://reports.example.test',
        'state': 'saved',
        'url': 'https://reports.example.test',
      };
      var state = 'needs_sign_in';
      route = (request, body) async => request.method == 'GET'
          ? _json(200, [
              {...data, 'state': state},
            ])
          : _json(200, {'ok': true});
      await expectLater(
        repository.remove(NodVaultItem(data)),
        throwsStateError,
      );
      expect(requests.any((r) => r.method == 'DELETE'), false);
      state = 'saved';
      await repository.remove(NodVaultItem(data));
      expect(requests.last.uri.path, '/api/vault/sessions/$_id');
    },
  );

  test(
    'activity binds card and cursor through encoded query parameters',
    () async {
      route = (request, body) async {
        expect(request.url.queryParameters, {
          'item': _id,
          'at': '2026-01-01T00:00:00+00:00',
          'id': 'cursor',
        });
        return _json(200, {
          'week': {'signIns': 0, 'payments': 1, 'held': 0},
          'entries': <Object?>[],
        });
      };
      await repository.activity(
        item: NodVaultItem({
          'kind': 'card',
          'id': _id,
          'label': 'Synthetic card',
        }),
        next: {'at': '2026-01-01T00:00:00+00:00', 'id': 'cursor'},
      );
    },
  );

  test('CSV handles quoted records, aliases, archived entries and normalizes origin', () async {
    final input = parseVaultCsv(
      'name,login_uri,login_username,login_password,archived,login_totp\r\n"Synthetic, reports",https://reports.example.test/path?q=discard,synthetic@example.test,"synthetic\nvalue",false,\r\nArchived,https://archive.example.test,u,p,true,\r\nBad,not a valid url,u,p,false,',
    );
    expect(input.logins.length, 2);
    expect(input.logins.first['origin'], 'https://reports.example.test');
    expect(input.logins.first['label'], 'Synthetic, reports');
    route = (request, body) async {
      expect(request.url.path, '/api/vault/import');
      expect((body! as Map)['logins'], hasLength(2));
      return _json(200, {
        'imported': 1,
        'existing': 0,
        'skipped': 1,
        'authenticatorKeys': 0,
      });
    };
    await repository.import(input);
    expect(input.logins, isEmpty);
  });

  test(
    'failed import clears private input without retry or exposing server error',
    () async {
      final input = parseVaultCsv(
        'url,password\nhttps://example.test,synthetic-only',
      );
      final login = input.logins.single;
      route = (request, body) async => _json(403, {'error': 'Refused'});
      await expectLater(repository.import(input), throwsA(isA<NodException>()));
      expect(login, isEmpty);
      expect(input.logins, isEmpty);
      expect(requests.length, 1);
      expect(
        () => parseVaultCsv('url,password\n"unterminated'),
        throwsFormatException,
      );
    },
  );

  test('connection replacement during preflight cannot send old-owner values to a new owner', () async {
    final pending = Completer<http.StreamedResponse>();
    route = (request, body) => pending.future;
    final values = <String, Object?>{'password': 'synthetic-only'};
    final save = repository.save(values, item: NodVaultItem(_login()));
    await Future<void>.delayed(Duration.zero);
    scoped.connectionGeneration++;
    pending.complete(_json(200, _login()));
    await expectLater(save, throwsStateError);
    expect(values, isEmpty);
    expect(requests.length, 1);
    await expectLater(repository.list(), throwsStateError);
    expect(requests.length, 1);
  });

  test(
    'cards use existing add and replacement contracts without a security code',
    () async {
      final card = <String, Object?>{
        'id': _id,
        'kind': 'card',
        'label': 'Synthetic card',
        'cardholder': 'Synthetic owner',
        'brand': 'visa',
        'last4': '0000',
        'expiryMonth': 12,
        'expiryYear': 2030,
        'updatedAt': '1',
      };
      route = (request, body) async {
        if (request.method == 'PATCH') {
          expect((body! as Map).containsKey('cardNumber'), false);
        }
        if (body is Map) expect(body.containsKey('securityCode'), false);
        return _json(200, card);
      };
      final values = <String, Object?>{
        'kind': 'card',
        'label': 'Synthetic card',
        'cardholder': 'Synthetic owner',
        'cardNumber': 'synthetic-only',
        'expiryMonth': 12,
        'expiryYear': 2030,
      };
      final created = await repository.save(values);
      expect(values, isEmpty);
      await repository.save({
        'kind': 'card',
        'label': 'Synthetic card',
        'cardholder': 'Synthetic owner',
        'expiryMonth': 12,
        'expiryYear': 2030,
      }, item: created);
      expect(requests.last.method, 'PATCH');
    },
  );

  test('CSV prioritizes HTTPS credentials over upgraded HTTP duplicates', () {
    final input = parseVaultCsv(
      'url,username,password\nhttp://reports.example.test,u,synthetic-older\nhttps://reports.example.test,u,synthetic-newer',
    );
    expect(input.logins.first['password'], 'synthetic-newer');
    expect(
      input.logins.every(
        (row) => row['origin'] == 'https://reports.example.test',
      ),
      true,
    );
    input.clear();
  });

  testWidgets(
    'private form clears secrets on background and never submits them to chat',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: NodVaultForm(repository: repository, kind: 'login'),
        ),
      );
      final password = find.widgetWithText(TextFormField, 'Password');
      await tester.enterText(password, 'synthetic-only');
      final field = tester.widget<TextFormField>(password);
      final input = tester.widget<TextField>(
        find.descendant(of: password, matching: find.byType(TextField)),
      );
      expect(input.obscureText, true);
      expect(input.enableSuggestions, false);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      expect(field.controller!.text, isEmpty);
      expect(requests, isEmpty);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'saving a private login sends only the Vault payload and clears its fields',
    (tester) async {
      route = (request, body) async {
        expect(request.method, 'POST');
        expect(request.url.path, '/api/vault');
        expect(body, {
          'kind': 'login',
          'label': 'Synthetic reports',
          'origin': 'https://reports.example.test',
          'username': 'synthetic@example.test',
          'password': 'synthetic-only',
        });
        return _json(200, _login());
      };
      await tester.pumpWidget(
        MaterialApp(
          home: NodVaultForm(repository: repository, kind: 'login'),
        ),
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Name'),
        'Synthetic reports',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Website domain or HTTPS URL'),
        'https://reports.example.test',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Username or email'),
        'synthetic@example.test',
      );
      final password = find.widgetWithText(TextFormField, 'Password');
      await tester.enterText(password, 'synthetic-only');
      final controller = tester.widget<TextFormField>(password).controller!;
      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(controller.text, isEmpty);
      expect(requests.length, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );

  test(
    'sign-in preflight rejects changed session URL, state, or missing session',
    () async {
      final item = NodVaultItem(_session());
      for (final sessions in [
        <Object?>[_session(url: 'https://reports.example.test/changed')],
        <Object?>[_session(state: 'saved')],
        <Object?>[],
      ]) {
        route = (request, body) async => _json(200, sessions);
        await expectLater(
          repository.signInAgainRequest(item),
          throwsStateError,
        );
      }
      expect(
        requests.every(
          (request) =>
              request.method == 'GET' &&
              request.uri.path == '/api/vault/sessions',
        ),
        true,
      );
    },
  );

  testWidgets(
    'page passes refreshed session metadata to one normal owner request',
    (tester) async {
      final calls = <String>[];
      final sending = Completer<void>();
      route = (request, body) async {
        if (request.url.path == '/api/vault') return _json(200, <Object?>[]);
        if (request.url.path == '/api/vault/sessions') {
          return _json(200, [_session()]);
        }
        return _json(200, {
          'week': {'signIns': 0, 'payments': 0, 'held': 0},
          'entries': <Object?>[],
        });
      };
      await tester.pumpWidget(
        MaterialApp(
          home: NodVaultPage(
            transport: scoped,
            onAsk: (text) {
              calls.add(text);
              return sending.future;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(calls, isEmpty);
      await tester.tap(find.text('Synthetic session'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign in again'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign in again'));
      await tester.pumpAndSettle();
      expect(calls, [
        'Use browser connection $_id to open https://reports.example.test/weekly. Check whether it works. If the session expired, help me sign in through the secure form and save the session.',
      ]);
      sending.completeError(StateError('Synthetic send failure'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign in again'));
      await tester.pumpAndSettle();
      expect(calls.length, 1);
      expect(requests.every((request) => request.method == 'GET'), true);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final boundary in ['background', 'replacement', 'close']) {
    testWidgets(
      'late sign-in preflight after $boundary cannot invoke callback',
      (tester) async {
        final pending = Completer<http.StreamedResponse>();
        final calls = <String>[];
        route = (request, body) async {
          if (request.url.path == '/api/vault/sessions') return pending.future;
          return _json(200, {
            'week': <String, Object?>{},
            'entries': <Object?>[],
          });
        };
        await tester.pumpWidget(
          MaterialApp(
            home: NodVaultDetails(
              repository: repository,
              item: NodVaultItem(_session(state: 'pending')),
              onAsk: (text) async {
                calls.add(text);
              },
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Sign in again'));
        await tester.pumpAndSettle();
        if (boundary == 'background') {
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.inactive,
          );
        }
        if (boundary == 'replacement') scoped.connectionGeneration++;
        if (boundary == 'close') await tester.pumpWidget(const SizedBox());
        pending.complete(_json(200, [_session(state: 'pending')]));
        await tester.pumpAndSettle();
        expect(calls, isEmpty);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
        expect(calls, isEmpty);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  for (final card in [false, true]) {
    testWidgets(
      'explicit ${card ? 'card' : 'login'} Copy uses the audited empty-body reveal contract and private clipboard only',
      (tester) async {
        final metadata = card
            ? <String, Object?>{
                'id': _id,
                'kind': 'card',
                'label': 'Synthetic card',
                'cardholder': 'Synthetic owner',
                'brand': 'visa',
                'last4': '0000',
                'expiryMonth': 12,
                'expiryYear': 2030,
                'updatedAt': '1',
              }
            : _login();
        route = (request, body) async {
          if (request.url.path == '/api/vault/activity') {
            return _json(200, {
              'week': <String, Object?>{},
              'entries': <Object?>[],
            });
          }
          expect(request.method, 'POST');
          expect(body, isEmpty);
          if (request.url.path.endsWith('/details')) {
            return _json(200, metadata);
          }
          expect(
            request.url.path,
            '/api/vault/$_id/${card ? 'card-number' : 'password'}',
          );
          return _json(200, {
            card ? 'cardNumber' : 'password': 'synthetic-copy-only',
          });
        };
        await tester.pumpWidget(
          MaterialApp(
            home: NodVaultDetails(
              repository: repository,
              item: NodVaultItem(metadata),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(clipboardWrites, isEmpty);
        await tester.tap(
          find.byTooltip(card ? 'Copy card number' : 'Copy password'),
        );
        await tester.pumpAndSettle();
        expect(clipboardWrites, ['synthetic-copy-only']);
        expect(find.text('synthetic-copy-only'), findsNothing);
        expect(
          requests.where(
            (request) =>
                request.uri.path.endsWith(card ? '/card-number' : '/password'),
          ),
          hasLength(1),
        );
        await tester.tap(
          find.byTooltip(card ? 'Copy cardholder' : 'Copy username'),
        );
        await tester.pumpAndSettle();
        expect(
          clipboardWrites.last,
          card ? 'Synthetic owner' : 'synthetic@example.test',
        );
        expect(requests.last.uri.path, '/api/vault/$_id/details');
        expect(
          requests.any(
            (request) =>
                request.uri.path.contains('chat') ||
                request.uri.path.contains('message'),
          ),
          false,
        );
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'stale Copy preflight neither reads the secret nor touches the clipboard',
    (tester) async {
      var reads = 0;
      route = (request, body) async {
        if (request.url.path == '/api/vault/activity') {
          return _json(200, {
            'week': <String, Object?>{},
            'entries': <Object?>[],
          });
        }
        expect(request.url.path, '/api/vault/$_id/details');
        return _json(
          200,
          _login(revision: ++reads == 1 ? '2026-01-01T00:00:00Z' : 'changed'),
        );
      };
      await tester.pumpWidget(
        MaterialApp(
          home: NodVaultDetails(
            repository: repository,
            item: NodVaultItem(_login()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Copy password'));
      await tester.pumpAndSettle();
      expect(clipboardWrites, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final boundary in [
    'background',
    'replacement',
    'disconnect',
    'close',
    'covered',
  ]) {
    testWidgets(
      'late Copy response after $boundary cannot write the clipboard',
      (tester) async {
        final pending = Completer<http.StreamedResponse>();
        final navigator = GlobalKey<NavigatorState>();
        route = (request, body) async {
          if (request.url.path.endsWith('/password')) return pending.future;
          if (request.url.path == '/api/vault/activity') {
            return _json(200, {
              'week': <String, Object?>{},
              'entries': <Object?>[],
            });
          }
          return _json(200, _login());
        };
        await tester.pumpWidget(
          MaterialApp(
            navigatorKey: navigator,
            home: NodVaultDetails(
              repository: repository,
              item: NodVaultItem(_login()),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Copy password'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Copy password'));
        await tester.pumpAndSettle();
        expect(
          requests.where((request) => request.uri.path.endsWith('/password')),
          hasLength(1),
        );
        if (boundary == 'background') {
          tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.inactive,
          );
        }
        if (boundary == 'replacement') scoped.connectionGeneration++;
        if (boundary == 'disconnect') {
          await tester.runAsync(transport.disconnect);
        }
        if (boundary == 'close') await tester.pumpWidget(const SizedBox());
        if (boundary == 'covered') {
          unawaited(
            navigator.currentState!.push<void>(
              MaterialPageRoute(
                builder: (_) => const Scaffold(body: Text('Other view')),
              ),
            ),
          );
          await tester.pumpAndSettle();
        }
        pending.complete(_json(200, {'password': 'synthetic-discarded'}));
        await tester.pumpAndSettle();
        expect(clipboardWrites, isEmpty);
        expect(find.text('synthetic-discarded'), findsNothing);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
        expect(clipboardWrites, isEmpty);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'late platform clipboard acknowledgement is not reported after background',
    (tester) async {
      clipboardCompletion = Completer<void>();
      route = (request, body) async {
        if (request.url.path.endsWith('/password')) {
          return _json(200, {'password': 'synthetic-platform-only'});
        }
        if (request.url.path == '/api/vault/activity') {
          return _json(200, {
            'week': <String, Object?>{},
            'entries': <Object?>[],
          });
        }
        return _json(200, _login());
      };
      await tester.pumpWidget(
        MaterialApp(
          home: NodVaultDetails(
            repository: repository,
            item: NodVaultItem(_login()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Copy password'));
      await tester.pumpAndSettle();
      expect(clipboardWrites, ['synthetic-platform-only']);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      clipboardCompletion!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Password copied.'), findsNothing);
      expect(clipboardWrites, hasLength(1));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.text('Password copied.'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('late reveal after background is discarded', (tester) async {
    final pending = Completer<http.StreamedResponse>();
    route = (request, body) async {
      if (request.url.path.endsWith('/password')) return pending.future;
      if (request.url.path == '/api/vault/activity') {
        return _json(200, {
          'week': <String, Object?>{},
          'entries': <Object?>[],
        });
      }
      return _json(200, _login());
    };
    await tester.pumpWidget(
      MaterialApp(
        home: NodVaultDetails(
          repository: repository,
          item: NodVaultItem(_login()),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show saved value privately'));
    await tester.pumpAndSettle();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    pending.complete(_json(200, {'password': 'synthetic-hidden'}));
    await tester.pumpAndSettle();
    expect(find.text('synthetic-hidden'), findsNothing);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(find.text('synthetic-hidden'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}

final class _ScopedTransport implements NodApiTransport, NodConnectionScope {
  _ScopedTransport(this.transport);
  final NodApiTransport transport;
  @override
  int connectionGeneration = 0;

  @override
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) => transport.requestJson(method, path, body: body);
}

http.StreamedResponse _json(int status, Object? body) => http.StreamedResponse(
  Stream.value(utf8.encode(jsonEncode(body))),
  status,
  headers: {'content-type': 'application/json'},
);
