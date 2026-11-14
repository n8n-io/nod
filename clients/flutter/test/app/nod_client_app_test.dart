import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/app/nod_client_app.dart';
import 'package:nod_client/core/api_transport.dart';
import 'package:nod_client/core/app_connections.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/mobile_links.dart';
import 'package:nod_client/features/apps/apps_page.dart';
import 'package:nod_client/features/chat/chat_testing.dart';
import 'package:nod_client/features/onboarding/onboarding_page.dart';
import 'package:nod_client/features/prepared/prepared_page.dart';
import 'package:nod_client/features/private_requests/private_requests_page.dart';

void main() {
  for (final failed in [false, true]) {
    testWidgets(
      'Vault session request reaches normal chat once, failure=$failed',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(390, 844));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final repository = _TransportFixture();
        addTearDown(repository.chat.dispose);
        if (failed) repository.chat.queueSendError(const NodOfflineException());
        await tester.pumpWidget(
          NodClientApp(
            repository: repository,
            restoreConnection: () async => true,
            disposeRepository: false,
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('open-navigation')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('mobile-navigation-vault')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Synthetic session'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Sign in again'));
        await tester.tap(find.text('Sign in again'));
        await tester.pumpAndSettle();
        expect(repository.chat.sentTexts, hasLength(1));
        expect(
          repository.chat.sentTexts.single.text,
          'Use browser connection 00000000-0000-4000-8000-000000000104 to open https://reports.example.test/weekly. Check whether it works. If the session expired, help me sign in through the secure form and save the session.',
        );
        expect(find.byKey(const Key('chat-composer')), findsOneWidget);
        expect(find.byType(SnackBar), failed ? findsOneWidget : findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }

  testWidgets(
    'restored links are authenticated, exact, deduplicated and dropped after logout',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final repository = _TransportFixture();
      addTearDown(repository.chat.dispose);
      const id = 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004';
      final links = _LinkFixture(Uri.parse('nod://open/prepared/$id'));
      addTearDown(links.controller.close);
      final restore = Completer<bool>();
      await tester.pumpWidget(
        NodClientApp(
          repository: repository,
          linkSource: links,
          restoreConnection: () => restore.future,
          disposeRepository: false,
        ),
      );
      links.controller.add(Uri.parse('nod://open/vault'));
      await tester.pump();
      expect(repository.paths, isEmpty);
      restore.complete(true);
      await tester.pumpAndSettle();
      expect(find.byType(NodPreparedPage), findsOneWidget);
      expect(
        repository.paths.where((path) => path == '/api/prepared/$id').length,
        1,
      );
      links.controller.add(Uri.parse('nod://open/prepared/$id'));
      links.controller.add(Uri.parse('https://foreign.example/prepared/$id'));
      await tester.pumpAndSettle();
      expect(
        repository.paths.where((path) => path == '/api/prepared/$id').length,
        1,
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Open menu'));
      await tester.pumpAndSettle();
      final logout = find.byKey(const Key('log-out'));
      await tester.ensureVisible(logout);
      await tester.tap(logout);
      await tester.pumpAndSettle();
      links.controller.add(Uri.parse('nod://open/prepared/$id'));
      await tester.pumpAndSettle();
      expect(find.byType(NodPreparedPage), findsNothing);
      expect(find.byKey(const Key('connection-origin')), findsOneWidget);
      expect(
        repository.paths.where((path) => path == '/api/prepared/$id').length,
        1,
      );
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('new pairing does not consume an unpaired startup link', (
    tester,
  ) async {
    final repository = _TransportFixture();
    addTearDown(repository.chat.dispose);
    final links = _LinkFixture(Uri.parse('nod://open/tasks'));
    addTearDown(links.controller.close);
    await tester.pumpWidget(
      NodClientApp(
        repository: repository,
        linkSource: links,
        restoreConnection: () async => false,
        disposeRepository: false,
      ),
    );
    await tester.pumpAndSettle();
    links.controller.add(Uri.parse('nod://open/vault'));
    await tester.enterText(
      find.byKey(const Key('connection-origin')),
      'https://nod.example.test',
    );
    await tester.enterText(
      find.byKey(const Key('connection-token')),
      'synthetic-pairing-token',
    );
    await tester.tap(find.byKey(const Key('connection-submit')));
    await tester.pumpAndSettle();
    links.controller.add(Uri.parse('nod://open/tasks'));
    await tester.pumpAndSettle();
    expect(links.initialCalls, 1);
    expect(repository.paths, isNot(contains('/api/tasks')));
    expect(find.byKey(const Key('chat-composer')), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('unconfigured paired servers enter onboarding before chat', (
    tester,
  ) async {
    final repository = _TransportFixture(completed: false);
    addTearDown(repository.chat.dispose);
    await tester.pumpWidget(
      NodClientApp(
        repository: repository,
        restoreConnection: () async => true,
        disposeRepository: false,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(NodMobileOnboarding), findsOneWidget);
    expect(find.byKey(const Key('chat-composer')), findsNothing);
    expect(repository.paths, contains('/api/models'));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('native navigation reaches paired tasks and private routes', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final repository = _TransportFixture();
    addTearDown(repository.chat.dispose);
    await tester.pumpWidget(
      NodClientApp(
        repository: repository,
        restoreConnection: () async => true,
        disposeRepository: false,
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('chat-composer')),
      'Synthetic unsent draft',
    );
    await tester.tap(find.byKey(const Key('open-private-requests')));
    await tester.pumpAndSettle();
    expect(find.byType(NodPrivateRequestsPage), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('chat-composer')))
          .controller!
          .text,
      'Synthetic unsent draft',
    );
    expect(repository.chat.sentTexts, isEmpty);
    for (final section in ['tasks', 'prepared', 'private entry']) {
      await tester.tap(find.byTooltip('Open menu'));
      await tester.pumpAndSettle();
      final destination = find.byKey(Key('mobile-navigation-$section'));
      await tester.ensureVisible(destination);
      await tester.tap(destination);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.tap(find.byTooltip('Back to chat'));
      await tester.pumpAndSettle();
    }
    expect(repository.paths, contains('/api/tasks'));
    expect(
      repository.paths.where((path) => path == '/api/state').length,
      greaterThanOrEqualTo(2),
    );
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
  });

  testWidgets(
    'mobile Log out is the last menu item and disconnects only when selected',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final repository = FakeNodRepository();
      addTearDown(repository.dispose);
      await tester.pumpWidget(
        NodClientApp(
          repository: repository,
          restoreConnection: () async => true,
          disposeRepository: false,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.dns_outlined), findsNothing);
      expect(find.text('Log out'), findsNothing);
      await tester.tap(find.byTooltip('Open menu'));
      await tester.pumpAndSettle();
      expect(repository.disconnectCalls, 0);
      expect(find.text('Log out'), findsOneWidget);
      final items = tester.widgetList<ListTile>(find.byType(ListTile)).toList();
      expect((items.last.title! as Text).data, 'Log out');
      await tester.tap(find.text('Log out'));
      await tester.pumpAndSettle();
      expect(repository.disconnectCalls, 1);
      expect(find.byKey(const Key('connection-origin')), findsOneWidget);
      expect(find.byTooltip('Open menu'), findsNothing);
    },
  );

  testWidgets('mobile menu navigation preserves the in-memory chat draft', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final repository = FakeNodRepository(
      history: NodHistory(
        messages: [
          for (var index = 0; index < 30; index++)
            NodMessage(
              id: 'synthetic-$index',
              role: NodMessageRole.assistant,
              text: 'Synthetic message $index',
              createdAt: DateTime.utc(2026, 11, 9, 0, index),
            ),
        ],
      ),
    );
    addTearDown(repository.dispose);
    await tester.pumpWidget(
      NodClientApp(
        repository: repository,
        restoreConnection: () async => true,
        disposeRepository: false,
      ),
    );
    await tester.pumpAndSettle();
    final list = tester.widget<ListView>(
      find.byKey(const Key('chat-message-list')),
    );
    list.controller!.jumpTo(240);
    await tester.pumpAndSettle();
    final scrollOffset = list.controller!.offset;
    expect(scrollOffset, greaterThan(0));
    await tester.enterText(
      find.byKey(const Key('chat-composer')),
      'Synthetic unsent draft',
    );
    await tester.tap(find.byTooltip('Open menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('mobile-navigation-apps')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('chat-composer')), findsNothing);
    await tester.tap(find.byTooltip('Back to chat'));
    await tester.pumpAndSettle();
    final input = tester.widget<TextField>(
      find.byKey(const Key('chat-composer')),
    );
    expect(input.controller!.text, 'Synthetic unsent draft');
    final restored = tester.widget<ListView>(
      find.byKey(const Key('chat-message-list')),
    );
    expect(restored.controller, same(list.controller));
    expect(restored.controller!.offset, scrollOffset);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'closing during preparation cancels the late sign-in without opening it',
    (tester) async {
      final repository = _AppsFixture();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: NodAppsPage(repository: repository)),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Continue to sign-in'));
      await tester.pump();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      repository.preparing.complete(repository.attempt);
      await tester.pumpAndSettle();
      expect(repository.cancelled, [repository.attempt]);
      expect(find.byType(Dialog), findsNothing);
    },
  );

  testWidgets(
    'returning from sign-in confirms server completion before showing connected',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      tester.platformDispatcher.textScaleFactorTestValue = 1.6;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      const channel = MethodChannel('plugins.flutter.io/url_launcher');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        (_) async => true,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final repository = _AppsFixture()
        ..preparing.complete(_AppsFixture.signIn);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: NodAppsPage(repository: repository)),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Connect'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Continue to sign-in'));
      await tester.pump();
      await tester.pump();
      expect(repository.checked, isPositive);
      expect(find.text('Gmail connected'), findsNothing);
      repository.status = NodAppSignInStatus.connected;
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(find.text('Gmail connected'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      expect(repository.cancelled, isEmpty);
    },
  );

  testWidgets('connects with an HTTPS origin and hides the submitted token', (
    tester,
  ) async {
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);

    await tester.pumpWidget(
      NodClientApp(
        repository: repository,
        restoreConnection: () async => false,
        disposeRepository: false,
        themeMode: ThemeMode.light,
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('connection-origin')),
      'https://nod.example.test',
    );
    await tester.enterText(
      find.byKey(const Key('connection-token')),
      'synthetic-private-token',
    );
    await tester.tap(find.byKey(const Key('connection-submit')));
    await tester.pumpAndSettle();

    expect(repository.connectCalls, 1);
    expect(find.byKey(const Key('chat-composer')), findsOneWidget);
    expect(find.text('synthetic-private-token'), findsNothing);
  });

  testWidgets('rejects an insecure remote origin before connecting', (
    tester,
  ) async {
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);

    await tester.pumpWidget(
      NodClientApp(
        repository: repository,
        restoreConnection: () async => false,
        disposeRepository: false,
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('connection-origin')),
      'http://nod.example.test',
    );
    await tester.enterText(
      find.byKey(const Key('connection-token')),
      'synthetic-token',
    );
    await tester.tap(find.byKey(const Key('connection-submit')));
    await tester.pump();

    expect(repository.connectCalls, 0);
    expect(
      find.text('Use an HTTPS Nod address or a loopback development address.'),
      findsOneWidget,
    );
  });

  testWidgets('connection setup scales and announces restore errors', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final semantics = tester.ensureSemantics();
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);

    await tester.pumpWidget(
      NodClientApp(
        repository: repository,
        restoreConnection: () async => throw const NodOfflineException(),
        disposeRepository: false,
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Connect this app to Nod'), findsOneWidget);
    final error = tester.getSemantics(
      find.byKey(const Key('connection-error')),
    );
    expect(error.label, contains('Connection error'));
    semantics.dispose();
  });

  testWidgets(
    'restores a saved connection and logs out from the desktop sidebar',
    (tester) async {
      final repository = FakeNodRepository();
      addTearDown(repository.dispose);

      await tester.pumpWidget(
        NodClientApp(
          repository: repository,
          restoreConnection: () async => true,
          disposeRepository: false,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('chat-composer')), findsOneWidget);

      expect(find.byIcon(Icons.dns_outlined), findsNothing);
      await tester.tap(find.byKey(const Key('log-out')));
      await tester.pumpAndSettle();

      expect(repository.disconnectCalls, 1);
      expect(find.byKey(const Key('connection-origin')), findsOneWidget);
    },
  );
}

class _LinkFixture implements NodMobileLinkSource {
  _LinkFixture(this.initial);
  final Uri initial;
  final controller = StreamController<Uri>.broadcast();
  var initialCalls = 0;
  @override
  Future<Uri?> initialUri() async {
    ++initialCalls;
    return initial;
  }

  @override
  Stream<Uri> get uris => controller.stream;
}

class _TransportFixture
    implements
        NodRepository,
        NodApiTransport,
        NodPairedOrigin,
        NodConnectionScope {
  _TransportFixture({this.completed = true});
  final bool completed;
  @override
  int connectionGeneration = 0;
  @override
  Uri get pairedOrigin => Uri.parse('https://nod.example.test');
  final chat = FakeNodRepository();
  final paths = <String>[];

  @override
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    paths.add(path);
    if (method == 'GET' && (path == '/api/tasks' || path == '/api/vault')) {
      return <Object?>[];
    }
    if (method == 'GET' && path == '/api/vault/sessions') {
      return [
        {
          'id': '00000000-0000-4000-8000-000000000104',
          'kind': 'session',
          'label': 'Synthetic session',
          'origin': 'https://reports.example.test',
          'url': 'https://reports.example.test/weekly',
          'state': 'needs_sign_in',
        },
      ];
    }
    if (method == 'GET' && Uri.parse(path).path == '/api/vault/activity') {
      return {
        'entries': <Object?>[],
        'next': null,
        'week': {'signIns': 0, 'payments': 0, 'held': 0},
      };
    }
    if (method == 'GET' && path == '/api/session') {
      return {
        'user': {'id': 'synthetic-owner'},
        'settings': {
          'onboardingCompleted': completed,
          'theme': 'system',
          'usageData': false,
        },
        'capabilities': {'traces': false},
      };
    }
    if (method == 'GET' && path == '/api/models') {
      return {'connections': <Object?>[], 'selection': null};
    }
    if (method == 'GET' && path == '/api/state') {
      return {'messages': <Object?>[], 'turns': <Object?>[]};
    }
    throw const NodRequestException();
  }

  @override
  Stream<NodConnectionState> get connectionStates => chat.connectionStates;
  @override
  Stream<NodEvent> get events => chat.events;
  @override
  Future<void> connect(NodConnectionConfig config) async {
    connectionGeneration++;
    await chat.connect(config);
  }

  @override
  Future<void> disconnect() async {
    connectionGeneration++;
    await chat.disconnect();
  }

  @override
  Future<NodState> loadState() => chat.loadState();
  @override
  Future<NodHistory> loadHistory({String? cursor}) =>
      chat.loadHistory(cursor: cursor);
  @override
  Future<void> sendText(String text, {required String clientMessageId}) =>
      chat.sendText(text, clientMessageId: clientMessageId);
  @override
  Future<void> stop() => chat.stop();
}

class _AppsFixture implements NodAppsRepository {
  static final signIn = NodAppSignIn(
    url: Uri.parse('https://auth.example.test/sign-in'),
    hash: 'synthetic-hash',
  );
  final preparing = Completer<NodAppSignIn>();
  final cancelled = <NodAppSignIn>[];
  var status = NodAppSignInStatus.waiting;
  var checked = 0;
  NodAppSignIn get attempt => signIn;

  @override
  Future<List<NodAppConnection>> loadApps({bool catalog = false}) async =>
      catalog
      ? [
          const NodAppConnection(
            slug: 'gmail',
            name: 'Gmail',
            status: 'not_configured',
            broker: true,
          ),
        ]
      : [];

  @override
  Future<NodAppSignIn> startAppSignIn(NodAppConnection app) => preparing.future;

  @override
  Future<NodAppSignInStatus> appSignInStatus(NodAppSignIn signIn) async {
    checked++;
    return status;
  }

  @override
  Future<void> cancelAppSignIn(NodAppSignIn signIn) async {
    cancelled.add(signIn);
  }
}
