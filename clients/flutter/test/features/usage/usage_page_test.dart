import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/app/nod_client_app.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/usage.dart';
import 'package:nod_client/design_system/design_system.dart';
import 'package:nod_client/features/chat/fakes/fake_nod_repository.dart';
import 'package:nod_client/features/usage/usage_page.dart';

import '../../fixtures/usage_fixture.dart';

class UsageRepository implements NodUsageRepository {
  bool fail = false;
  bool saveFails = false;
  Completer<NodUsageReport>? gate;
  final saves = <double?>[];
  NodUsageReport report = NodUsageReport.fromJson(usageFixture);
  int reads = 0;
  @override
  Future<NodUsageReport> loadUsage() async {
    reads++;
    if (fail) throw StateError('Synthetic failure');
    return gate?.future ?? report;
  }

  @override
  Future<NodUsageEntries> loadUsageEntries(NodUsageCursor cursor) async =>
      NodUsageEntries(entries: [report.page.entries.first], next: null);
  @override
  Future<NodUsageLimit?> saveMonthlyLimit(double? value) async {
    saves.add(value);
    if (saveFails) throw StateError('Synthetic failure');
    return value == null
        ? null
        : NodUsageLimit(monthlyUsd: value, reached: false);
  }
}

class UsageNavigationRepository extends UsageRepository
    implements NodRepository {
  final backend = FakeNodRepository();
  @override
  Stream<NodConnectionState> get connectionStates => backend.connectionStates;
  @override
  Stream<NodEvent> get events => backend.events;
  @override
  Future<NodState> loadState() => backend.loadState();
  @override
  Future<NodHistory> loadHistory({String? cursor}) =>
      backend.loadHistory(cursor: cursor);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  testWidgets('Usage menu opens real usage screen and returns to chat', (
    tester,
  ) async {
    final repository = UsageNavigationRepository();
    addTearDown(repository.backend.dispose);
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      NodClientApp(
        repository: repository,
        restoreConnection: () async => true,
        disposeRepository: false,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Open menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('mobile-navigation-usage')));
    await tester.pumpAndSettle();
    expect(find.text('\$12.50'), findsOneWidget);
    await tester.tap(find.byTooltip('Back to chat'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('chat-composer')), findsOneWidget);
  });

  testWidgets(
    'late response after leaving usage does not update a disposed page',
    (tester) async {
      final repository = UsageRepository()..gate = Completer<NodUsageReport>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: NodUsagePage(repository: repository)),
        ),
      );
      await tester.pump();
      expect(find.byType(LinearProgressIndicator), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      repository.gate!.complete(repository.report);
      await tester.pump();
      expect(tester.takeException(), null);
    },
  );

  Future<void> mount(
    WidgetTester tester,
    UsageRepository repository, {
    Brightness brightness = Brightness.light,
    double scale = 1,
  }) async {
    await tester.binding.setSurfaceSize(Size(scale == 1 ? 390 : 320, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: brightness == Brightness.light ? NodTheme.light : NodTheme.dark,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(body: NodUsagePage(repository: repository)),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('loading, failure and retry use no writes', (tester) async {
    final repository = UsageRepository()..fail = true;
    await mount(tester, repository);
    expect(find.textContaining('Could not load usage'), findsOneWidget);
    repository.fail = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('\$12.50'), findsOneWidget);
    expect(repository.saves, isEmpty);
  });

  testWidgets(
    'invalid limit rejected, successful limit save and removal require explicit actions',
    (tester) async {
      final repository = UsageRepository();
      await mount(tester, repository);
      await tester.tap(find.text('Manage monthly limit'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('usage-monthly-limit')), '0');
      await tester.ensureVisible(find.text('Save limit'));
      await tester.tap(find.text('Save limit'));
      await tester.pumpAndSettle();
      expect(repository.saves, isEmpty);
      expect(find.text('Enter a limit of at least \$1.'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('usage-monthly-limit')),
        '50',
      );
      await tester.ensureVisible(find.text('Save limit'));
      await tester.tap(find.text('Save limit'));
      await tester.pumpAndSettle();
      expect(repository.saves, [50]);
      expect(find.text('Monthly limit: \$50.00'), findsOneWidget);
      await tester.tap(find.text('Remove limit'));
      await tester.pumpAndSettle();
      expect(repository.saves, [50]);
      await tester.tap(find.text('Keep limit'));
      await tester.pumpAndSettle();
      expect(repository.saves, [50]);
      await tester.tap(find.text('Remove limit'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Remove limit'));
      await tester.pumpAndSettle();
      expect(repository.saves, [50, null]);
      expect(find.text('No monthly spending limit'), findsOneWidget);
    },
  );

  testWidgets('failed limit save preserves server-reported limit', (
    tester,
  ) async {
    final repository = UsageRepository()..saveFails = true;
    await mount(tester, repository);
    await tester.tap(find.text('Manage monthly limit'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('usage-monthly-limit')), '50');
    await tester.ensureVisible(find.text('Save limit'));
    await tester.tap(find.text('Save limit'));
    await tester.pumpAndSettle();
    expect(find.text('Monthly limit: \$25.00'), findsOneWidget);
    expect(find.textContaining('Could not confirm the change'), findsOneWidget);
    expect(repository.saves, [50]);
  });

  testWidgets(
    'activity paging deduplicates and plan usage is not rendered as free API usage',
    (tester) async {
      await mount(tester, UsageRepository());
      await tester.ensureVisible(find.text('Load more activity'));
      await tester.pumpAndSettle();
      expect(find.text('Plan'), findsOneWidget);
      await tester.ensureVisible(find.text('Synthetic plan request'));
      await tester.tap(find.text('Synthetic plan request'));
      await tester.pumpAndSettle();
      expect(find.text('Included in ChatGPT plan'), findsOneWidget);
      await tester.ensureVisible(find.text('Load more activity'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Load more activity'));
      await tester.pumpAndSettle();
      expect(find.text('Synthetic request'), findsOneWidget);
      expect(find.text('Load more activity'), findsNothing);
    },
  );

  testWidgets(
    'usage updates on a timer, pauses in background and refreshes on resume',
    (tester) async {
      final repository = UsageRepository();
      await mount(tester, repository);
      expect(find.byTooltip('Refresh usage'), findsNothing);
      expect(repository.reads, 1);
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(repository.reads, 2);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump(const Duration(seconds: 60));
      expect(repository.reads, 2);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(repository.reads, 3);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 60));
      expect(repository.reads, 3);
    },
  );

  testWidgets('automatic refresh does not interrupt an unsaved monthly limit', (
    tester,
  ) async {
    final repository = UsageRepository();
    await mount(tester, repository);
    await tester.tap(find.text('Manage monthly limit'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('usage-monthly-limit')), '75');
    await tester.pump(const Duration(seconds: 30));
    await tester.pumpAndSettle();
    expect(repository.reads, 1);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('usage-monthly-limit')))
          .controller!
          .text,
      '75',
    );
    expect(repository.saves, isEmpty);
  });

  testWidgets('server events are debounced into one automatic usage read', (
    tester,
  ) async {
    final repository = UsageNavigationRepository();
    addTearDown(repository.backend.dispose);
    await mount(tester, repository);
    for (var index = 0; index < 5; index++) {
      repository.backend.emitEvent(
        const NodActivityEvent(NodTurnState.running),
      );
    }
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(repository.reads, 2);
  });

  for (final brightness in Brightness.values) {
    testWidgets('usage overview ${brightness.name}', (tester) async {
      await mount(tester, UsageRepository(), brightness: brightness);
      expect(tester.takeException(), null);
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/usage_${brightness.name}.png'),
      );
    });
  }

  testWidgets(
    'limit reached and empty activity are legible at double text scale',
    (tester) async {
      final repository = UsageRepository()
        ..report = NodUsageReport.fromJson({
          ...usageFixture,
          'entries': [],
          'next': null,
          'limit': {'monthlyUsd': 10, 'reached': true},
        });
      await mount(tester, repository, scale: 2);
      expect(find.textContaining('Monthly limit reached'), findsOneWidget);
      await tester.ensureVisible(find.textContaining('No activity yet'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), null);
    },
  );

  test(
    'tiny and unpriced costs never silently round positive spending to zero',
    () {
      expect(usageMoney(0.001), '<\$0.01');
      expect(usageMoney(0), '\$0.00');
    },
  );
}
