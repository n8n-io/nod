import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/api/tasks_repository.dart';
import 'package:nod_client/core/api_transport.dart';
import 'package:nod_client/core/nod_errors.dart';
import 'package:nod_client/features/tasks/tasks_page.dart';

const taskId = '11111111-1111-4111-8111-111111111111';
const questionId = '22222222-2222-4222-8222-222222222222';
const startId = '33333333-3333-4333-8333-333333333333';
const threadId = '44444444-4444-4444-8444-444444444444';

Map<String, Object?> taskFixture({String status = 'needs_you'}) => {
  'id': taskId,
  'title': 'Compare synthetic options',
  'status': status,
  'doneWhen': 'A checked comparison is ready',
  'now': 'Waiting for your choice',
  'result': status == 'done' ? 'Synthetic comparison complete' : '',
  'question': status == 'needs_you' ? 'Use the shorter option?' : null,
  'questionMessageId': status == 'needs_you' ? questionId : null,
  'messageId': startId,
  'waitingFor': <Object?>[],
  'nextCheck': null,
  'createdAt': '2026-11-11T12:00:00Z',
  'updatedAt': '2026-11-11T12:00:00Z',
  'closedAt': status == 'done' ? '2026-11-11T12:01:00Z' : null,
  'steps': ['Read sources', 'Compare'],
  'stepIndex': 1,
  'revision': 1,
  'appliedRevision': 1,
};

class TaskContract implements NodApiTransport {
  String status = 'needs_you';
  String activeThread = threadId;
  String title = 'Compare synthetic options';
  final messages = <Map<String, Object?>>[];
  int stops = 0;
  bool failStop = false;
  Completer<void>? sending;
  final schedules = <Map<String, Object?>>[];
  bool failCreate = false;

  @override
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    final task = {...taskFixture(status: status), 'title': title};
    if (method == 'GET' && path == '/api/tasks') return [task];
    if (method == 'GET' && path == '/api/tasks/$taskId') {
      return {'task': task, 'events': <Object?>[]};
    }
    if (method == 'GET' && path == '/api/tasks/$taskId/schedule-draft') {
      if (status != 'done') throw const NodRequestException();
      return {
        'title': title,
        'prompt': 'Compare the next set of synthetic options',
        'omittedSensitive': true,
        'hasAttachments': true,
      };
    }
    if (method == 'POST' && path == '/api/schedules') {
      schedules.add(body!);
      if (failCreate) throw const NodOfflineException();
      return {
        ...body,
        'id': 'saved-schedule',
        'enabled': true,
        'revision': 1,
        'nextRun': '2026-11-12T08:00:00Z',
        'monthlyUsd': 1.25,
      };
    }
    if (method == 'GET' && path == '/api/state') {
      return {'threadId': activeThread, 'messages': <Object?>[]};
    }
    if (method == 'PATCH' && path == '/api/tasks/$taskId') {
      title = body!['title'] as String;
      return {'ok': true};
    }
    if (method == 'POST' && path == '/api/tasks/$taskId/stop') {
      stops++;
      if (failStop) throw const NodOfflineException();
      status = 'cancelled';
      return {'ok': true};
    }
    if (method == 'POST' && path == '/api/messages') {
      if (body!['threadId'] != activeThread) {
        throw const NodConflictException(NodConflictKind.conversationReset);
      }
      if (![questionId, startId].contains(body['replyToMessageId'])) {
        throw const NodRequestException();
      }
      messages.add(body);
      await sending?.future;
      status = 'working';
      return {
        'threadId': activeThread,
        'messageId': 'accepted',
        'turnId': 'turn',
      };
    }
    throw const NodRequestException();
  }
}

void main() {
  test(
    'continuation addresses the saved question and never selects a session ID',
    () async {
      final transport = TaskContract();
      final repository = NodTasksRepository(transport);
      final question = await repository.prepareReply(taskId);
      await repository.reply(
        question,
        'Yes',
        clientMessageId: 'synthetic-message',
      );
      expect(transport.messages.single, {
        'text': 'Yes',
        'clientMessageId': 'synthetic-message',
        'threadId': threadId,
        'replyToMessageId': questionId,
      });
      transport.status = 'done';
      final finished = await repository.prepareReply(taskId);
      expect(finished.replyToMessageId, startId);
      transport.activeThread = '55555555-5555-4555-8555-555555555555';
      await expectLater(
        repository.reply(finished, 'Continue', clientMessageId: 'next'),
        throwsA(isA<NodConflictException>()),
      );
      expect(transport.messages, hasLength(1));
    },
  );

  testWidgets(
    'task lifecycle loads details, renames, stops, and continues once',
    (tester) async {
      final transport = TaskContract();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: NodTasksPage(transport: transport)),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Compare synthetic options'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Rename'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Synthetic revised title');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(transport.title, 'Synthetic revised title');
      await tester.tap(find.text('Stop this task'));
      await tester.pumpAndSettle();
      expect(transport.stops, 1);
      expect(find.text('Stopped'), findsOneWidget);
      await tester.tap(find.text('Continue task'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.enterText(
        find.byType(TextField),
        'Continue with the checked sources',
      );
      transport.sending = Completer<void>();
      await tester.tap(find.text('Send reply'));
      await tester.pump();
      await tester.tap(find.text('Send reply'));
      expect(transport.messages, hasLength(1));
      expect(transport.messages.single['replyToMessageId'], startId);
      transport.sending!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Working'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'completed task creates a reviewed schedule and shows its projection',
    (tester) async {
      final transport = TaskContract()..status = 'done';
      await tester.pumpWidget(
        MaterialApp(
          home: NodTaskPage(transport: transport, taskId: taskId),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Schedule task'));
      await tester.pumpAndSettle();
      expect(find.textContaining('sensitive details'), findsOneWidget);
      expect(find.textContaining('Attachments are not added'), findsOneWidget);
      await tester.tap(find.text('Repeat'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Weekdays').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Schedule time zone'),
        'Europe/Berlin',
      );
      await tester.ensureVisible(find.text('Create schedule'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Create schedule'));
      await tester.pumpAndSettle();
      expect(transport.schedules.single, {
        'title': 'Compare synthetic options',
        'prompt': 'Compare the next set of synthetic options',
        'kind': 'recurring',
        'cron': '0 9 * * 1-5',
        'timeZone': 'Europe/Berlin',
      });
      expect(find.textContaining('Projected cost'), findsOneWidget);
      expect(find.textContaining('Next run'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('unconfirmed schedule creation is not repeated', (tester) async {
    final transport = TaskContract()
      ..status = 'done'
      ..failCreate = true;
    await tester.pumpWidget(
      MaterialApp(
        home: NodTaskPage(transport: transport, taskId: taskId),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Schedule task'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Repeat'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Daily').last);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Schedule time zone'),
      'UTC',
    );
    await tester.ensureVisible(find.text('Create schedule'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create schedule'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Create schedule'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Create schedule'));
    await tester.pump();
    expect(transport.schedules, hasLength(1));
    expect(find.textContaining('Check Scheduled'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'uncertain stop is surfaced and is not dispatched again by refresh',
    (tester) async {
      final transport = TaskContract()..failStop = true;
      await tester.pumpWidget(
        MaterialApp(
          home: NodTaskPage(transport: transport, taskId: taskId),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Stop this task'));
      await tester.pumpAndSettle();
      expect(find.textContaining('not confirmed'), findsOneWidget);
      await tester.tap(find.text('Stop this task'));
      await tester.pump();
      expect(transport.stops, 1);
      await tester.tap(find.byTooltip('Refresh'));
      await tester.pumpAndSettle();
      expect(transport.stops, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
