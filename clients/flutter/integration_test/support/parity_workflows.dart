import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:nod_client/api/api.dart';
import 'package:nod_client/core/core.dart';

import 'navigation.dart';

const _question = '00000000-0000-4000-8000-000000000101';
const _choice = '00000000-0000-4000-8000-000000000102';
const _taskQuestion = '00000000-0000-4000-8000-000000000103';

Future<void> runParityWorkflows(
  WidgetTester tester,
  HttpNodRepository repository,
  Uri origin,
  String controlToken,
) async {
  final client = http.Client();
  Future<Map<String, dynamic>> command(String action) async {
    final response = await client
        .post(
          origin.resolve('/fixture/parity/$action'),
          headers: {'x-fixture-control': controlToken},
        )
        .timeout(const Duration(seconds: 10));
    expect(response.statusCode, 200, reason: 'Synthetic control: $action');
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> inspect() => command('inspect');
  try {
    final seed = await command('seed');
    final initialSends = seed['chatSends'] as int;
    await parityReady(tester, find.byKey(const ValueKey('answer-$_choice')));
    await parityTap(tester, find.byKey(const ValueKey('answer-$_choice')));
    await parityReady(tester, find.text('Use synthetic draft'));
    final state = await repository.loadState();
    final sent = state.messages.singleWhere(
      (item) =>
          item.role == NodMessageRole.owner &&
          item.text == 'Use synthetic draft',
    );
    expect(sent.replyToMessageId, _question);
    await repository.sendReply(
      'Use synthetic draft',
      clientMessageId: sent.id,
      threadId: state.threadId!,
      replyToMessageId: _question,
      choiceIds: [_choice],
    );
    expect((await inspect())['dispatches'], 1);
    Future<void> stale(String id) => repository.sendReply(
      'Use synthetic draft',
      clientMessageId: id,
      threadId: state.threadId!,
      replyToMessageId: _question,
      choiceIds: [_choice],
    );
    await expectLater(
      stale('00000000-0000-4000-8000-000000000120'),
      throwsA(isA<NodConflictException>()),
    );
    await command('replace-question');
    await expectLater(
      stale('00000000-0000-4000-8000-000000000121'),
      throwsA(isA<NodConflictException>()),
    );
    expect((await inspect())['dispatches'], 1);
    expect((await inspect())['refusals'], 2);

    expect(state.messages.any((item) => item.id == _taskQuestion), isFalse);
    await navigateToSection(tester, 'tasks');
    await parityTap(tester, find.text('Synthetic saved task'));
    await parityReady(
      tester,
      find.text('Synthetic older task question: continue the draft?'),
    );
    await parityTap(tester, find.text('Show in chat'));
    await parityReady(
      tester,
      find.byKey(const ValueKey('chat-focus-$_taskQuestion')),
    );
    await parityReady(tester, find.byTooltip('Cancel reply'));
    expect((await inspect())['aroundReads'], greaterThanOrEqualTo(1));
    await parityWait(tester, () async {
      final composer = find.byKey(const Key('chat-composer'));
      final route = ModalRoute.of(tester.element(composer));
      return tester.widget<TextField>(composer).enabled == true &&
          route?.isCurrent == true &&
          route?.secondaryAnimation?.status == AnimationStatus.dismissed;
    });
    final composer = find.byKey(const Key('chat-composer'));
    await tester.tap(composer.hitTestable());
    await parityWait(tester, () async {
      final editable = tester.widget<EditableText>(
        find.descendant(of: composer, matching: find.byType(EditableText)),
      );
      return editable.focusNode.hasFocus;
    });
    await tester.enterText(composer, 'Continue synthetic task');
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('chat-composer')))
          .controller!
          .text,
      'Continue synthetic task',
    );
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump(const Duration(milliseconds: 300));
    await tapReadyControl(tester, find.byKey(const Key('chat-send')));
    await parityWait(
      tester,
      () async => (await inspect())['taskDispatches'] == 1,
    );
    expect(
      (await inspect())['taskDispatches'],
      1,
      reason: 'Older task reply must dispatch to its addressed session',
    );
    final continued = (await repository.loadHistory()).messages.singleWhere(
      (item) => item.text == 'Continue synthetic task',
    );
    expect(continued.replyToMessageId, _taskQuestion);
    expect(continued.turnId, '00000000-0000-4000-8000-000000000104');
    expect((await inspect())['taskDispatches'], 1);

    await navigateToSection(tester, 'prepared');
    await parityTap(tester, find.textContaining('Synthetic finding'));
    await parityReady(tester, find.text('Synthetic source-bound draft'));
    await parityReady(tester, find.text('Synthetic source record'));
    await command('remove-source');
    await parityTap(tester, find.text('Refresh'));
    await parityReady(
      tester,
      find.textContaining('This prepared work is unavailable.'),
    );
    expect(find.text('Synthetic source-bound draft'), findsNothing);
    expect(find.text('Synthetic source record'), findsNothing);
    await parityBack(tester);

    await navigateToSection(tester, 'private entry');
    await parityTap(tester, find.text('Private sign-in'));
    await parityReady(tester, find.text('https://synthetic.example.test'));
    await parityTap(tester, find.text('Synthetic sign-in method'));
    await parityReady(
      tester,
      find.text('Details submitted. Nod will continue the same task.'),
    );
    expect((await inspect())['privateSubmissions'], 1);
    await parityTap(tester, find.text('Back to conversation'));
    await command('expire-private');
    await parityTap(tester, find.text('Private sign-in'));
    await parityReady(
      tester,
      find.textContaining('This request is expired or replaced.'),
    );
    expect(find.text('Synthetic sign-in method'), findsNothing);
    expect((await inspect())['privateSubmissions'], 1);
    expect((await inspect())['chatSends'], initialSends + 2);
    await parityTap(tester, find.text('Back to conversation'));

    await navigateToSection(tester, 'settings');
    await parityTap(tester, find.text('Privacy & data'));
    await parityReady(tester, find.text('Share usage data'));
    expect((await inspect())['accountWrites'], 0);
    await parityTap(tester, find.text('Share usage data'));
    await parityReady(tester, find.text('Share usage data?'));
    expect((await inspect())['accountWrites'], 0);
    await parityTap(tester, find.text('Cancel'));
    expect((await inspect())['accountWrites'], 0);
    await parityTap(tester, find.text('Share usage data'));
    await parityTap(tester, find.text('Continue'));
    await parityWait(
      tester,
      () async => (await inspect())['usageData'] == true,
    );
    expect((await inspect())['accountWrites'], 1);
    expect((await inspect())['traces'], false);
    await parityBack(tester);
    await parityTap(tester, find.text('General'));
    await parityReady(tester, find.text('Appearance'));
    await parityTap(tester, find.text('light'));
    await parityTap(tester, find.text('dark').last);
    await parityWait(tester, () async => (await inspect())['theme'] == 'dark');
    await tester.pump(const Duration(milliseconds: 500));
    expect(
      Theme.of(tester.element(find.text('Appearance'))).brightness,
      Brightness.dark,
    );
    expect((await inspect())['accountWrites'], 2);
    await parityBack(tester);

    await navigateToSection(tester, 'vault');
    await parityReady(tester, find.text('No saved items'));
    await navigateToSection(tester, 'apps');
    await parityTap(tester, find.text('Manage accounts and channels'));
    await parityReady(tester, find.text('Connected apps'));
    await parityBack(tester);
    await navigateToSection(tester, 'chat');
    final result = await inspect();
    expect(result, containsPair('marker', 'synthetic-parity-v1'));
    expect(result['chatSends'], initialSends + 2);
    expect(result['dispatches'], 1);
    expect(result['taskDispatches'], 1);
    expect(result['refusals'], 2);
    expect(result['privateSubmissions'], 1);
    expect(result['accountWrites'], 2);
    expect(tester.takeException(), isNull);
  } finally {
    client.close();
  }
}

Future<void> parityWait(
  WidgetTester tester,
  Future<bool> Function() condition,
) async {
  final deadline = DateTime.now().add(const Duration(seconds: 15));
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 50));
    if (await condition()) return;
  }
  fail('Synthetic workflow state did not converge.');
}

Future<void> parityReady(WidgetTester tester, Finder finder) async {
  await parityWait(tester, () async => finder.evaluate().length == 1);
  expect(finder, findsOneWidget);
}

Future<void> parityTap(WidgetTester tester, Finder finder) async {
  await parityReady(tester, finder);
  await tester.ensureVisible(finder);
  await tester.pump(const Duration(milliseconds: 350));
  await tester.tap(finder.hitTestable());
  await tester.pump(const Duration(milliseconds: 350));
}

Future<void> parityBack(WidgetTester tester) async {
  await parityTap(tester, find.byTooltip('Back'));
}
