import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/app/nod_client_app.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/schedules.dart';
import 'package:nod_client/design_system/design_system.dart';
import 'package:nod_client/features/chat/fakes/fake_nod_repository.dart';
import 'package:nod_client/features/scheduled/scheduled_page.dart';

import '../../fixtures/schedule_fixture.dart';

class ScheduleRepository implements NodSchedulesRepository {
  List<NodSchedule> schedules = [NodSchedule.fromJson(fixture)];
  final writes = <Map<String, Object?>>[];
  int reads = 0;
  int deletes = 0;
  bool fail = false;
  bool failWrite = false;
  Completer<NodSchedule>? gate;
  final cursors = <String?>[];
  @override
  Future<List<NodSchedule>> loadSchedules() async {
    reads++;
    if (fail) throw StateError('synthetic failure');
    return [...schedules];
  }

  @override
  Future<NodSchedule> updateSchedule(
    NodSchedule schedule,
    Map<String, Object?> changes,
  ) async {
    writes.add(changes);
    if (failWrite) throw StateError('synthetic uncertain write');
    final saved = gate != null
        ? await gate!.future
        : NodSchedule.fromJson({
            ...fixture,
            ...changes,
            'revision': schedule.revision + 1,
          });
    schedules = [saved];
    return saved;
  }

  @override
  Future<void> deleteSchedule(String id) async {
    deletes++;
    schedules = [];
  }

  @override
  Future<NodScheduleHistory> loadScheduleHistory(
    String id, {
    String? cursor,
  }) async {
    cursors.add(cursor);
    return NodScheduleHistory.fromJson({
      'runs': [
        {
          'id': cursor ?? 'run-1',
          'status': 'completed',
          'scheduledFor': '2026-11-08T14:00:00Z',
          'messageText': 'Synthetic calendar summary',
          'error': null,
          'costUsd': 0.04,
        },
      ],
      'nextCursor': cursor == null ? 'older/page+=' : null,
    });
  }
}

class ScheduleNavigationRepository extends ScheduleRepository
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

Future<void> showPage(
  WidgetTester tester,
  ScheduleRepository repository, {
  double scale = 1,
  Size size = const Size(390, 844),
  Brightness brightness = Brightness.light,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      theme: brightness == Brightness.light ? NodTheme.light : NodTheme.dark,
      home: MediaQuery(
        data: MediaQueryData(size: size, textScaler: TextScaler.linear(scale)),
        child: Scaffold(
          body: NodScheduledPage(repository: repository, onOpenChat: () {}),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() async {
    var directory = File(Platform.resolvedExecutable).parent;
    File? font;
    for (var index = 0; index < 8; index++) {
      final candidate = File(
        '${directory.path}/artifacts/material_fonts/Roboto-Regular.ttf',
      );
      if (candidate.existsSync()) {
        font = candidate;
        break;
      }
      directory = directory.parent;
    }
    if (font == null) {
      throw StateError('Flutter cached material fonts unavailable');
    }
    final loader = FontLoader('Roboto')
      ..addFont(Future.value(ByteData.sublistView(font.readAsBytesSync())));
    await loader.load();
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
  });
  testWidgets(
    'Scheduled navigation opens real page and returns to preserved chat',
    (tester) async {
      final repository = ScheduleNavigationRepository();
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
      await tester.tap(find.text('Scheduled'));
      await tester.pumpAndSettle();
      expect(find.byType(NodScheduledPage), findsOneWidget);
      await tester.tap(find.text('Plan something in chat'));
      await tester.pumpAndSettle();
      expect(find.byType(NodScheduledPage), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('pause waits for confirmation and suppresses duplicate writes', (
    tester,
  ) async {
    final repository = ScheduleRepository()..gate = Completer<NodSchedule>();
    await showPage(tester, repository);
    await tester.tap(find.text('Weekday briefing'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pause'));
    await tester.pump();
    expect(find.text('Resume'), findsNothing);
    await tester.tap(find.text('Pause'));
    expect(repository.writes, [
      {'enabled': false},
    ]);
    repository.gate!.complete(
      NodSchedule.fromJson({...fixture, 'enabled': false, 'revision': 4}),
    );
    await tester.pumpAndSettle();
    expect(find.text('Resume'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('deletion requires explicit confirmation', (tester) async {
    final repository = ScheduleRepository();
    await showPage(tester, repository);
    await tester.tap(find.text('Weekday briefing'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Keep schedule'));
    await tester.pumpAndSettle();
    expect(repository.deletes, 0);
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete schedule'));
    await tester.pumpAndSettle();
    expect(repository.deletes, 1);
    expect(repository.schedules, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('history loads on request and passes opaque pagination cursor', (
    tester,
  ) async {
    final repository = ScheduleRepository();
    await showPage(tester, repository);
    expect(repository.cursors, isEmpty);
    await tester.tap(find.text('Weekday briefing'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Show past runs'));
    await tester.tap(find.text('Show past runs'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Load older runs'));
    await tester.tap(find.text('Load older runs'));
    await tester.pumpAndSettle();
    expect(repository.cursors, [null, 'older/page+=']);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('automatic refresh pauses in background and resumes', (
    tester,
  ) async {
    final repository = ScheduleRepository();
    await showPage(tester, repository);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 31));
    expect(repository.reads, 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(repository.reads, 2);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('uncertain mutation is fenced until a successful refresh', (
    tester,
  ) async {
    final repository = ScheduleRepository()..failWrite = true;
    await showPage(tester, repository);
    await tester.tap(find.text('Weekday briefing'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pause'));
    expect(repository.writes.length, 1);
    repository.failWrite = false;
    await tester.pump(const Duration(seconds: 30));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    expect(repository.writes.length, 2);
    expect(repository.schedules.single.enabled, false);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'editor keeps draft during timer refresh and saves changed fields only',
    (tester) async {
      final repository = ScheduleRepository();
      await showPage(tester, repository);
      await tester.tap(find.text('Weekday briefing'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Edit schedule'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Title'),
        'Morning briefing',
      );
      await tester.pump(const Duration(seconds: 31));
      expect(repository.reads, 1);
      await tester.tap(find.text('Save changes'));
      await tester.pumpAndSettle();
      expect(repository.writes.single, {'title': 'Morning briefing'});
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('failed first load recovers into empty state', (tester) async {
    final repository = ScheduleRepository()..fail = true;
    await showPage(tester, repository);
    expect(repository.reads, 1);
    repository
      ..fail = false
      ..schedules = [];
    await tester.pump(const Duration(seconds: 30));
    await tester.pumpAndSettle();
    expect(repository.reads, 2);
    expect(find.text('Make room for later'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'automatic updates need no refresh control and do not flash a progress bar',
    (tester) async {
      final repository = ScheduleRepository();
      await showPage(tester, repository);
      expect(find.byIcon(Icons.refresh), findsNothing);
      expect(find.byType(RefreshIndicator), findsNothing);
      repository.schedules = [
        NodSchedule.fromJson({...fixture, 'title': 'Updated briefing'}),
      ];
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(repository.reads, 2);
      expect(find.text('Updated briefing'), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('server events debounce automatic reads', (tester) async {
    final repository = ScheduleNavigationRepository();
    addTearDown(repository.backend.dispose);
    await showPage(tester, repository);
    for (var index = 0; index < 5; index++) {
      repository.backend.emitEvent(
        const NodActivityEvent(NodTurnState.running),
      );
    }
    expect(repository.reads, 1);
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(repository.reads, 2);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('long schedule content works on narrow phone and wide desktop', (
    tester,
  ) async {
    final repository = ScheduleRepository()
      ..schedules = [
        NodSchedule.fromJson({
          ...fixture,
          'title': 'An unusually long recurring schedule title that should wrap without hiding any controls',
          'prompt': 'Check the project notes and prepare a detailed overview of everything that needs attention this week.',
        }),
      ];
    await showPage(tester, repository, size: const Size(320, 780), scale: 2);
    await tester.tap(find.text(repository.schedules.single.title));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await showPage(tester, repository, size: const Size(1200, 900));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  for (final brightness in Brightness.values) {
    testWidgets('scheduled renders ${brightness.name} at double text size', (
      tester,
    ) async {
      await showPage(
        tester,
        ScheduleRepository(),
        scale: 2,
        brightness: brightness,
      );
      await tester.tap(find.text('Weekday briefing'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
    testWidgets('scheduled preview ${brightness.name}', (tester) async {
      final repository = ScheduleRepository()
        ..schedules = [
          NodSchedule.fromJson(fixture),
          NodSchedule.fromJson({
            ...fixture,
            'id': 'weekly',
            'title': 'The Friday wrap-up',
            'prompt':
                'Bring together the week’s progress and what’s coming next.',
            'cron': '0 16 * * 5',
            'nextRun': '2026-12-04T21:00:00Z',
          }),
          NodSchedule.fromJson({
            ...fixture,
            'id': 'paused',
            'title': 'A moment to catch up',
            'prompt': 'Check in on the reading list I saved for later.',
            'enabled': false,
            'nextRun': null,
          }),
        ];
      await showPage(tester, repository, brightness: brightness);
      await expectLater(
        find.byType(Scaffold),
        matchesGoldenFile('goldens/scheduled_${brightness.name}.png'),
      );
      await tester.tap(find.text('Weekday briefing'));
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(Scaffold),
        matchesGoldenFile('goldens/scheduled_expanded_${brightness.name}.png'),
      );
      await tester.pumpWidget(const SizedBox());
    });
  }
}
