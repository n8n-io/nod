import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/design_system/design_system.dart';
import 'package:nod_client/features/chat/agent_message_body.dart';

Future<void> showReply(
  WidgetTester tester,
  String text, {
  bool streaming = true,
  bool reducedMotion = false,
  bool active = true,
  bool ticking = true,
}) => tester.pumpWidget(
  MaterialApp(
    theme: NodTheme.light,
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: reducedMotion),
      child: TickerMode(
        enabled: ticking,
        child: Scaffold(
          body: SingleChildScrollView(
            child: AgentMessageBody(
              text: text,
              streaming: streaming,
              active: active,
            ),
          ),
        ),
      ),
    ),
  ),
);

String visible(WidgetTester tester) =>
    tester.widget<MarkdownBody>(find.byType(MarkdownBody)).data;

void main() {
  testWidgets(
    'reveals three or four graphemes per pulse and stops when caught up',
    (tester) async {
      const text = 'Here is the complete streaming reply.';
      await showReply(tester, text);
      expect(visible(tester), 'Here');
      await tester.pump(const Duration(milliseconds: 16));
      await tester.pump(const Duration(milliseconds: 32));
      expect(visible(tester), 'Here is ');
      await tester.pump(const Duration(milliseconds: 32));
      expect(visible(tester), 'Here is the');
      await tester.pumpAndSettle();
      expect(visible(tester), text);
      expect(tester.binding.hasScheduledFrame, isFalse);
    },
  );

  testWidgets('new deltas retain the revealed prefix without restarting', (
    tester,
  ) async {
    await showReply(tester, 'Ready');
    await tester.pumpAndSettle();
    await showReply(tester, 'Ready with a longer answer.');
    expect(visible(tester), 'Ready');
    await tester.pumpAndSettle();
    expect(visible(tester), 'Ready with a longer answer.');
  });

  testWidgets('keeps emoji, combining marks and flags whole', (tester) async {
    const prefix = 'A👩🏽‍💻e\u0301🇨🇦';
    await showReply(tester, '${prefix}XYZ');
    expect(visible(tester), prefix);
    await tester.pumpAndSettle();
    expect(visible(tester), '${prefix}XYZ');
  });

  testWidgets('final reply and corrections replace buffered text immediately', (
    tester,
  ) async {
    await showReply(tester, 'A long unfinished answer that is still arriving.');
    await showReply(
      tester,
      'A corrected authoritative answer.',
      streaming: false,
    );
    expect(visible(tester), 'A corrected authoritative answer.');
    await showReply(tester, 'Replaced, not appended.');
    expect(visible(tester), 'Replaced, not appended.');
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  for (final mode in ['history', 'reduced', 'inactive', 'offscreen']) {
    testWidgets('$mode reveals immediately without a ticker', (tester) async {
      const text = 'The complete answer should be immediately readable.';
      await showReply(
        tester,
        text,
        streaming: mode != 'history',
        reducedMotion: mode == 'reduced',
        active: mode != 'inactive',
        ticking: mode != 'offscreen',
      );
      expect(visible(tester), text);
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);
    });
  }

  testWidgets(
    'changing reduced motion or leaving chat flushes a pending reveal',
    (tester) async {
      const text =
          'An answer with buffered content still waiting for its next pulse.';
      await showReply(tester, text);
      expect(visible(tester), isNot(text));
      await showReply(tester, text, reducedMotion: true);
      expect(visible(tester), text);
      await showReply(tester, '$text More streamed content.');
      await showReply(tester, '$text More streamed content.', active: false);
      expect(visible(tester), '$text More streamed content.');
      await tester.pumpAndSettle();
    },
  );

  testWidgets('large bursts catch up faster than replaying every character', (
    tester,
  ) async {
    final text = 'A longer reply. ' * 100;
    await showReply(tester, text);
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump(const Duration(milliseconds: 32));
    expect(visible(tester).length, greaterThan(8));
    for (var i = 0; i < 90; i++) {
      await tester.pump(const Duration(milliseconds: 32));
    }
    expect(visible(tester), text);
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets(
    'partial Markdown stays usable and disposal cancels pending frames',
    (tester) async {
      await showReply(
        tester,
        '## Update\n\n**Working** with `code`.\n\n- First\n- Second\n',
      );
      for (var i = 0; i < 16; i++) {
        await tester.pump(const Duration(milliseconds: 32));
        expect(tester.takeException(), isNull);
      }
      await showReply(
        tester,
        '## Update\n\n**Working** with `code`.\n\n- First\n- Second\n${'Long paragraph. ' * 100}',
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );
}
