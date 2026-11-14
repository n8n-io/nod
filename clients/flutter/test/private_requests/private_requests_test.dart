import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/api/private_requests_repository.dart';
import 'package:nod_client/core/api_transport.dart';
import 'package:nod_client/core/private_requests.dart';
import 'package:nod_client/features/private_requests/private_requests_page.dart';

const credential = NodPrivateRequestRef(
  kind: NodPrivateRequestKind.credential,
  id: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
);
const nextCredential = NodPrivateRequestRef(
  kind: NodPrivateRequestKind.credential,
  id: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
);
const payment = NodPrivateRequestRef(
  kind: NodPrivateRequestKind.payment,
  id: '10000000-0000-4000-8000-000000000001',
);

void main() {
  test('discovers only relative owned private links and waiting handoffs', () async {
    final fixture = PrivateFixture()
      ..state = {
        'messages': [
          {
            'role': 'assistant',
            'text':
                '[Sign in](/vault/${credential.id}) [Pay](</payments/${payment.id}>) [Foreign](<https://other.example/vault/${credential.id}>) [Extra](/vault/${credential.id}?key=x)',
          },
          {'role': 'user', 'text': '[Ignore](/vault/${nextCredential.id})'},
        ],
        'turns': [
          {
            'id': payment.id,
            'status': 'waiting',
            'handoffMessageId': 'question',
          },
          {
            'id': '20000000-0000-4000-8000-000000000002',
            'status': 'cancelled',
            'handoffMessageId': 'old',
          },
        ],
      };
    final refs = await NodPrivateRequestsRepository(fixture).list();
    expect(refs.map((ref) => ref.id), [payment.id, payment.id, credential.id]);
    expect(refs.map((ref) => ref.kind), [
      NodPrivateRequestKind.browser,
      NodPrivateRequestKind.payment,
      NodPrivateRequestKind.credential,
    ]);
  });

  test(
    'rechecks replaced requests before dispatch and clears submitted values',
    () async {
      final fixture = PrivateFixture();
      final repository = NodPrivateRequestsRepository(fixture);
      final details = await repository.read(credential);
      fixture.status = 'expired';
      final values = <String, Object?>{'code': generatedValue()};
      await expectLater(repository.submit(details, values), throwsStateError);
      expect(fixture.posts, isEmpty);
      expect(values, isEmpty);
    },
  );

  test('double submit and lost acknowledgement never dispatch twice', () async {
    final fixture = PrivateFixture()..failAfterClaim = true;
    final repository = NodPrivateRequestsRepository(fixture);
    final details = await repository.read(payment);
    final first = repository.submit(details, {'code': generatedValue()});
    final second = repository.submit(details, {'code': generatedValue()});
    await expectLater(second, throwsStateError);
    await expectLater(first, throwsStateError);
    await expectLater(
      repository.submit(details, {'code': generatedValue()}),
      throwsStateError,
    );
    expect(fixture.posts.length, 1);
    expect((await repository.read(payment)).status, 'uncertain');
    expect(repository.wasSubmitted(payment), isTrue);
  });

  test(
    'same-flow successor is fetched from server, not guessed from turns',
    () async {
      final fixture = PrivateFixture()..nextId = nextCredential.id;
      final repository = NodPrivateRequestsRepository(fixture);
      final details = await repository.read(credential);
      expect(await repository.next(details), isNull);
      await repository.submit(details, {'code': generatedValue()});
      final filled = await repository.read(credential);
      expect(filled.status, 'filled');
      expect((await repository.next(filled))?.id, nextCredential.id);
      expect(fixture.resumedTurns, ['30000000-0000-4000-8000-000000000003']);
      expect(
        fixture.paths.where((path) => path.contains('/messages')),
        isEmpty,
      );
    },
  );

  testWidgets(
    'closing private entry clears unsent input without resuming task',
    (tester) async {
      final fixture = PrivateFixture();
      final repository = NodPrivateRequestsRepository(fixture);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () {
                  Navigator.of(context).push<void>(
                    MaterialPageRoute(
                      builder: (_) => NodPrivateEntry(
                        repository: repository,
                        request: credential,
                      ),
                    ),
                  );
                },
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), generatedValue());
      await tester.tap(find.text('Back to conversation'));
      await tester.pumpAndSettle();
      expect(fixture.posts, isEmpty);
      expect(fixture.resumedTurns, isEmpty);
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextFormField>(find.byType(TextFormField))
            .controller!
            .text,
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'backgrounding clears values and refreshes stopped request on return',
    (tester) async {
      final fixture = PrivateFixture();
      await tester.pumpWidget(
        MaterialApp(
          home: NodPrivateEntry(
            repository: NodPrivateRequestsRepository(fixture),
            request: credential,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), generatedValue());
      final controller = tester
          .widget<TextFormField>(find.byType(TextFormField))
          .controller!;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await tester.pump();
      expect(controller.text, isEmpty);
      fixture.status = 'expired';
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.byType(TextFormField), findsNothing);
      expect(fixture.posts, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('sign-in method and saved login use their bound private routes', (
    tester,
  ) async {
    for (final kind in ['method', 'password']) {
      final fixture = PrivateFixture()..kind = kind;
      await tester.pumpWidget(
        MaterialApp(
          key: ValueKey(kind),
          home: NodPrivateEntry(
            repository: NodPrivateRequestsRepository(fixture),
            request: credential,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.text(
          kind == 'method'
              ? 'Example method'
              : 'Example login · owner@example.test',
        ),
      );
      await tester.pumpAndSettle();
      expect(fixture.posts, [
        '${credential.path}/${kind == 'method' ? 'method' : 'saved'}',
      ]);
      expect(fixture.postedKeys, [kind == 'method' ? 'methodId' : 'entryId']);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets(
    'new password form sends only private credentials and clears fields',
    (tester) async {
      final fixture = PrivateFixture()..kind = 'password';
      await tester.pumpWidget(
        MaterialApp(
          home: NodPrivateEntry(
            repository: NodPrivateRequestsRepository(fixture),
            request: credential,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Use another login'));
      await tester.pumpAndSettle();
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'owner@example.test');
      await tester.enterText(fields.at(1), generatedValue());
      final controllers = fields
          .evaluate()
          .map((element) => (element.widget as TextFormField).controller!)
          .toList();
      await tester.ensureVisible(find.text('Save and continue'));
      await tester.tap(find.text('Save and continue'));
      await tester.pumpAndSettle();
      expect(fixture.posts, [credential.path]);
      expect(fixture.postedKeys, ['username', 'password']);
      expect(
        controllers.every((controller) => controller.text.isEmpty),
        isTrue,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('stale form cannot be submitted after status refresh', (
    tester,
  ) async {
    final fixture = PrivateFixture();
    await tester.pumpWidget(
      MaterialApp(
        home: NodPrivateEntry(
          repository: NodPrivateRequestsRepository(fixture),
          request: credential,
        ),
      ),
    );
    await tester.pumpAndSettle();
    fixture.status = 'expired';
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.byType(TextFormField), findsNothing);
    expect(fixture.posts, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('successful payment clears code and never claims order paid', (
    tester,
  ) async {
    final fixture = PrivateFixture();
    await tester.pumpWidget(
      MaterialApp(
        home: NodPrivateEntry(
          repository: NodPrivateRequestsRepository(fixture),
          request: payment,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField), generatedValue());
    await tester.ensureVisible(find.text('Pay USD 12.00'));
    await tester.tap(find.text('Pay USD 12.00'));
    await tester.pumpAndSettle();
    expect(fixture.posts.length, 1);
    expect(fixture.posts.single, payment.path);
    expect(find.byType(TextFormField), findsNothing);
    expect(fixture.resumedTurns, ['30000000-0000-4000-8000-000000000003']);
    await tester.pumpWidget(const SizedBox());
  });
}

String generatedValue() => List.generate(3, (index) => '${index + 1}').join();

class PrivateFixture implements NodApiTransport {
  String status = 'pending';
  String kind = 'otp';
  final postedKeys = <String>[];
  String? nextId;
  bool failAfterClaim = false;
  Map<String, Object?> state = {'messages': <Object?>[], 'turns': <Object?>[]};
  final posts = <String>[];
  final paths = <String>[];
  final resumedTurns = <String>[];

  @override
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    paths.add(path);
    if (path == '/api/state') return state;
    if (method == 'GET') {
      if (path.endsWith('/flow')) return {'nextId': nextId};
      if (path.endsWith('/status')) return {'status': status};
      if (path == payment.path) {
        return {
          'origin': 'https://shop.example',
          'amount': 'USD 12.00',
          'card': 'Test card',
          'destinations': ['https://pay.example'],
        };
      }
      return {
        'id': path.split('/').last,
        'turnId': '30000000-0000-4000-8000-000000000003',
        'origin': 'https://login.example',
        'kind': kind,
        'methods': [
          {'id': 'method-1', 'label': 'Example method'},
        ],
        'savedEntries': kind == 'password'
            ? [
                {
                  'id': 'saved-1',
                  'label': 'Example login',
                  'username': 'owner@example.test',
                },
              ]
            : <Object?>[],
        'status': status,
      };
    }
    if (status != 'pending') throw StateError('Closed synthetic request');
    posts.add(path);
    postedKeys.addAll(body!.keys);
    status = failAfterClaim
        ? 'uncertain'
        : path == payment.path
        ? 'submitted'
        : 'filled';
    if (failAfterClaim) throw StateError('Synthetic acknowledgement loss');
    resumedTurns.add('30000000-0000-4000-8000-000000000003');
    return {'ok': true};
  }
}
