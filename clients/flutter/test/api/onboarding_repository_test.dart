import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:nod_client/api/http_nod_repository.dart';
import 'package:nod_client/api/onboarding_repository.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/mobile_links.dart';
import 'package:nod_client/core/onboarding.dart';
import 'package:nod_client/features/onboarding/notification_settings_page.dart';
import 'package:nod_client/features/onboarding/onboarding_page.dart';

import 'http_nod_repository_test.dart' as fixture;

void main() {
  late HttpNodRepository transport;
  late NodOnboardingRepository repository;
  final requests = <({String method, String path, Object? body})>[];
  var usage = false;
  var completed = false;
  var modelReady = true;
  var preparationStatus = 200;
  var completionStatus = 200;
  var paused = false;
  var owner = 'synthetic-owner';
  Completer<void>? completionGate;
  Map<String, Object?> session() => {
    'user': {'id': owner},
    'settings': {
      'theme': 'system',
      'onboardingCompleted': completed,
      'usageData': usage,
      'traces': false,
    },
    'capabilities': {'traces': true, 'updatesEmail': true},
  };
  Map<String, Object?> models() => {
    'selection': modelReady
        ? {
            'connectionId': 'synthetic-connection',
            'modelId': 'synthetic-model',
            'effort': 'off',
          }
        : null,
    'connections': [
      {
        'id': 'synthetic-connection',
        'status': 'connected',
        'models': [
          {
            'id': 'synthetic-model',
            'efforts': ['off'],
          },
        ],
      },
    ],
  };
  setUp(() async {
    usage = completed = paused = false;
    owner = 'synthetic-owner';
    modelReady = true;
    preparationStatus = completionStatus = 200;
    completionGate = null;
    requests.clear();
    transport = HttpNodRepository(
      credentials: fixture.MemoryCredentials(),
      eventClientFactory: () => fixture.EventConnection().client,
      client: fixture.RoutingClient((request) async {
        expect(request.url.origin, 'https://nod.example.test');
        expect(
          request.headers['Authorization'],
          'Bearer synthetic-onboarding-token',
        );
        final bytes = await request.finalize().toBytes();
        final body = bytes.isEmpty ? null : jsonDecode(utf8.decode(bytes));
        requests.add((
          method: request.method,
          path: request.url.path,
          body: body,
        ));
        Object? response = {'ok': true};
        var status = 200;
        switch (request.url.path) {
          case '/api/client/capabilities':
            response = {
              'contractVersion': 1,
              'authentication': {'mode': 'bearer'},
            };
          case '/api/state':
            response = {
              'threadId': 'synthetic-thread',
              'revision': '1',
              'messages': <Object?>[],
              'turns': <Object?>[],
              'configuration': {'conversationResetEnabled': true},
            };
          case '/api/session':
            response = session();
          case '/api/models':
            response = models();
          case '/api/apps':
            response = [];
          case '/api/account/prepare':
            status = preparationStatus;
          case '/api/account':
            if ((body as Map)['onboardingCompleted'] == true) {
              await completionGate?.future;
              status = completionStatus;
              if (status == 200) completed = true;
            }
            if (body.containsKey('usageData')) {
              usage = body['usageData'] == true;
            }
            response = session();
          case '/api/preferences':
            if (request.method == 'PATCH') {
              paused = (body as Map)['proactivePaused'] == true;
            }
            response = {
              'proactivePaused': paused,
              'quietHoursEnabled': true,
              'quietStart': '22:00',
              'quietEnd': '08:00',
              'timeZone': 'UTC',
              'notificationRule': '',
            };
        }
        return http.StreamedResponse(
          Stream.value(utf8.encode(jsonEncode(response))),
          status,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    await transport.connect(
      NodConnectionConfig(
        origin: Uri.parse('https://nod.example.test'),
        token: 'synthetic-onboarding-token',
      ),
    );
    repository = NodOnboardingRepository(transport);
  });
  tearDown(() async => transport.dispose());

  test('updates require current server sharing consent and a separate explicit yes', () async {
    await expectLater(
      repository.subscribe('reader@example.test', consent: true),
      throwsA(isA<NodForbiddenException>()),
    );
    usage = true;
    await expectLater(
      repository.subscribe('reader@example.test', consent: false),
      throwsA(isA<NodForbiddenException>()),
    );
    expect(
      requests.where((r) => r.path == '/api/onboarding/updates-email'),
      isEmpty,
    );
    await repository.subscribe(' reader@example.test ', consent: true);
    expect(requests.last.body, {
      'email': 'reader@example.test',
      'consent': true,
    });
  });

  test(
    'preparation and completion failures do not count as completed',
    () async {
      preparationStatus = 503;
      await expectLater(
        repository.prepare(),
        throwsA(isA<NodUnavailableException>()),
      );
      completionStatus = 409;
      await expectLater(
        repository.complete(),
        throwsA(isA<NodConflictException>()),
      );
      expect(completed, isFalse);
    },
  );

  Future<void> press(WidgetTester tester, String label) async {
    final target = find.text(label).last;
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
    await tester.tap(target);
    await tester.pumpAndSettle();
  }

  Future<void> toJoin(WidgetTester tester, VoidCallback done) async {
    await tester.pumpWidget(
      MaterialApp(
        home: NodMobileOnboarding(transport: transport, onComplete: done),
      ),
    );
    await tester.pumpAndSettle();
    await press(tester, 'Get started');
    await press(tester, 'Skip for now');
    await press(tester, 'Skip for now');
    await press(tester, 'Not now');
  }

  testWidgets(
    'optional steps finish without web preflight and completion is single-flight',
    (tester) async {
      var done = 0;
      await toJoin(tester, () => done++);
      completionGate = Completer<void>();
      await tester.ensureVisible(find.text('Start chatting'));
      await tester.tap(find.text('Start chatting'));
      await tester.pump(const Duration(milliseconds: 200));
      expect(done, 0);
      expect(
        requests.where(
          (r) =>
              r.path == '/api/account' &&
              (r.body as Map)['onboardingCompleted'] == true,
        ),
        hasLength(1),
      );
      completionGate!.complete();
      await tester.pumpAndSettle();
      expect(done, 1);
      expect(completed, isTrue);
      expect(
        requests.where(
          (r) =>
              r.path == '/api/onboarding/updates-email' ||
              r.path == '/api/onboarding/profile',
        ),
        isEmpty,
      );
      expect(
        requests.where(
          (r) => r.path == '/api/account' && (r.body as Map)['traces'] == false,
        ),
        hasLength(1),
      );
    },
  );

  testWidgets(
    'profile saves multi-choice answers and clears inapplicable fields',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: NodMobileOnboarding(transport: transport, onComplete: () {}),
        ),
      );
      await tester.pumpAndSettle();
      await press(tester, 'Get started');
      await press(tester, 'Skip for now');
      await press(tester, 'Mostly work');
      await press(tester, 'I run my own business');
      await press(tester, 'For my clients');
      await press(tester, 'Just me');
      await press(tester, 'Mostly personal life');
      await press(tester, 'Student');
      await press(tester, 'Engineering');
      await press(tester, 'Manage my calendar');
      await press(tester, 'Save and continue');
      expect(
        requests.where((r) => r.path == '/api/onboarding/profile').single.body,
        {
          'scope': 'personal',
          'roles': ['owner', 'student', 'engineering'],
          'whoFor': 'clients',
          'jobs': ['calendar'],
        },
      );
    },
  );

  testWidgets('missing model cannot advance or mark setup complete', (
    tester,
  ) async {
    modelReady = false;
    await tester.pumpWidget(
      MaterialApp(
        home: NodMobileOnboarding(transport: transport, onComplete: () {}),
      ),
    );
    await tester.pumpAndSettle();
    await press(tester, 'Get started');
    await press(tester, 'Skip for now');
    await press(tester, 'Skip for now');
    await press(tester, 'Check and continue');
    expect(completed, isFalse);
    expect(
      requests.where(
        (r) =>
            r.path == '/api/account' &&
            (r.body as Map)['onboardingCompleted'] == true,
      ),
      isEmpty,
    );
    expect(find.text('Check and continue'), findsOneWidget);
  });

  testWidgets('failed preparation blocks completion until explicit retry', (
    tester,
  ) async {
    preparationStatus = 503;
    var done = 0;
    await toJoin(tester, () => done++);
    await press(tester, 'Start chatting');
    expect(done, 0);
    expect(
      requests.where(
        (r) =>
            r.path == '/api/account' &&
            (r.body as Map)['onboardingCompleted'] == true,
      ),
      isEmpty,
    );
    preparationStatus = 200;
    await press(tester, 'Start chatting');
    expect(done, 1);
  });

  testWidgets('server failure leaves setup open and explicit retry completes', (
    tester,
  ) async {
    var done = 0;
    await toJoin(tester, () => done++);
    completionStatus = 409;
    await press(tester, 'Start chatting');
    expect(done, 0);
    completionStatus = 200;
    await press(tester, 'Start chatting');
    expect(done, 1);
  });

  testWidgets(
    'owner change discards pending onboarding answers before saving',
    (tester) async {
      await toJoin(tester, () {});
      owner = 'another-synthetic-owner';
      await press(tester, 'Start chatting');
      expect(
        requests.where(
          (r) =>
              r.path == '/api/account' &&
              (r.body as Map)['onboardingCompleted'] == true,
        ),
        isEmpty,
      );
      expect(find.text('Get started'), findsOneWidget);
    },
  );

  testWidgets(
    'pause writes only the server pause preference and foreground refreshes',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(home: NodNotificationSettingsPage(transport: transport)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byType(SwitchListTile).first);
      await tester.pumpAndSettle();
      expect(requests.where((r) => r.method == 'PATCH').last.body, {
        'proactivePaused': true,
      });
      final reads = requests.where((r) => r.path == '/api/preferences').length;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(
        requests.where((r) => r.path == '/api/preferences').length,
        greaterThan(reads),
      );
    },
  );

  test(
    'model readiness verifies selected connection, model and supported effort',
    () {
      expect(nodOnboardingModelReady(models()), isTrue);
      final data = models();
      (data['selection'] as Map)['effort'] = 'unsupported';
      expect(nodOnboardingModelReady(data), isFalse);
      modelReady = false;
      expect(nodOnboardingModelReady(models()), isFalse);
    },
  );

  test('existing desktop open routes resolve only with a current authenticated pairing', () {
    final origin = Uri.parse('https://nod.example.test');
    const routes = {
      '/': NodMobileDestination.chat,
      '/tasks': NodMobileDestination.tasks,
      '/apps': NodMobileDestination.apps,
      '/channels': NodMobileDestination.channels,
      '/usage': NodMobileDestination.usage,
      '/vault': NodMobileDestination.vault,
      '/settings': NodMobileDestination.settings,
      '/settings/notifications': NodMobileDestination.notifications,
      '/settings/models': NodMobileDestination.models,
      '/settings/voice': NodMobileDestination.voice,
      '/settings/memory': NodMobileDestination.memory,
      '/settings/privacy': NodMobileDestination.privacy,
      '/prepared/10000000-0000-4000-8000-000000000001':
          NodMobileDestination.prepared,
    };
    for (final entry in routes.entries) {
      for (final prefix in ['nod://open', 'https://nod.example.test']) {
        expect(
          NodMobileRoute.parse(
            '$prefix${entry.key}',
            pairedOrigin: origin,
            authenticated: true,
          )?.destination,
          entry.value,
        );
        expect(
          NodMobileRoute.parse(
            '$prefix${entry.key}',
            pairedOrigin: origin,
            authenticated: false,
          ),
          isNull,
        );
      }
    }
    for (final value in [
      'nod://open',
      'nod://other/tasks',
      'nod://open:4310/tasks',
      'nod://name:secret@open/tasks',
      'NOD://open/tasks',
      'nod://OPEN/tasks',
      'nod://open/tasks/',
      'nod://open/tasks?token=synthetic',
      'nod://open/tasks#access=synthetic',
      'nod://open/%74asks',
      'nod://open/settings/../tasks',
      'nod://open/browser',
      'nod://open/payments/10000000-0000-4000-8000-000000000001',
      'nod://open/credentials/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'nod://open/vault/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'nod://open/api/session',
      ' nod://open/tasks',
      'nod://open/\ntasks',
      'nod://open/prepared/not-an-id',
    ]) {
      expect(
        NodMobileRoute.parse(value, pairedOrigin: origin, authenticated: true),
        isNull,
        reason: value,
      );
    }
    expect(
      NodMobileRoute.parse(
        'nod://open/tasks',
        pairedOrigin: Uri.parse('http://untrusted.example.test'),
        authenticated: true,
      ),
      isNull,
    );
  });

  test('platform bridge preserves safe initial and live links, filters raw traversal and cancels', () async {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    const messages = MethodChannel('com.llfbandit.app_links/messages');
    const events = MethodChannel('com.llfbandit.app_links/events');
    const codec = StandardMethodCodec();
    String? initial = 'nod://open/tasks';
    final calls = <String>[];
    messenger.setMockMethodCallHandler(messages, (call) async {
      expect(call.method, 'getInitialLink');
      return initial;
    });
    messenger.setMockMethodCallHandler(events, (call) async {
      calls.add(call.method);
      return null;
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(messages, null);
      messenger.setMockMethodCallHandler(events, null);
    });
    final source = NodPlatformMobileLinkSource();
    expect((await source.initialUri())?.toString(), initial);
    for (final unsafe in [
      'nod://open/settings/../tasks',
      'nod://open/%74asks',
      'nod://open/tasks?token=synthetic',
      'nod://open/tasks#access=synthetic',
      'https://name:secret@nod.example.test/tasks',
      'nod://open/\ntasks',
      'NOD://open/tasks',
    ]) {
      initial = unsafe;
      expect(await source.initialUri(), isNull, reason: unsafe);
    }
    initial = null;
    expect(await source.initialUri(), isNull);
    final received = <Uri>[];
    final errors = <Object>[];
    final subscription = source.uris.listen(received.add, onError: errors.add);
    await Future<void>.delayed(Duration.zero);
    expect(calls, ['listen']);
    for (final value in [
      'nod://open/settings/../tasks',
      'nod://open/%74asks',
      'nod://open/tasks?token=synthetic',
      'https://nod.example.test/settings/models',
      'nod://open/apps',
    ]) {
      await messenger.handlePlatformMessage(
        events.name,
        codec.encodeSuccessEnvelope(value),
        null,
      );
    }
    await messenger.handlePlatformMessage(
      events.name,
      codec.encodeErrorEnvelope(code: 'synthetic-link-error'),
      null,
    );
    await Future<void>.delayed(Duration.zero);
    expect(received.map((uri) => uri.toString()), [
      'https://nod.example.test/settings/models',
      'nod://open/apps',
    ]);
    expect(errors.single, isA<PlatformException>());
    await subscription.cancel();
    await Future<void>.delayed(Duration.zero);
    expect(calls, ['listen', 'cancel']);
  });

  test('routing refuses unauthenticated, cross-origin, credentials and ambiguous paths', () {
    NodMobileRoute? parse(String value, {bool authenticated = true}) =>
        NodMobileRoute.parse(
          value,
          pairedOrigin: Uri.parse('https://nod.example.test'),
          authenticated: authenticated,
        );
    const id = '10000000-0000-4000-8000-000000000001';
    const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(parse('/prepared/$id')?.id, id);
    expect(
      parse('https://nod.example.test/payments/$id')?.destination,
      NodMobileDestination.payment,
    );
    expect(
      parse('/vault/$token')?.destination,
      NodMobileDestination.credentials,
    );
    expect(parse('/tasks')?.destination, NodMobileDestination.tasks);
    expect(parse('/browser')?.destination, NodMobileDestination.browser);
    expect(parse('/tasks', authenticated: false), isNull);
    for (final value in [
      'https://other.example.test/tasks',
      '//other.example.test/tasks',
      'https://name:secret@nod.example.test/tasks',
      '/tasks?token=synthetic',
      '/tasks#access=synthetic',
      '/api/account',
      '/tasks/../browser',
      '/prepared/%2e%2e',
      '/prepared/$id/extra',
      '/credentials/$id',
      '/onboarding?replay=1',
      'nod://tasks',
      r'/tasks\browser',
    ]) {
      expect(parse(value), isNull, reason: value);
    }
  });
}
