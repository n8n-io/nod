import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/app/nod_app.dart';

void main() {
  testWidgets('uses a chat-first compact shell and menu on a phone', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const NodApp(themeMode: ThemeMode.light));

    expect(find.byKey(const Key('compact-shell')), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    expect(find.byKey(const Key('open-navigation')), findsOneWidget);
    expect(find.byKey(const Key('desktop-sidebar')), findsNothing);

    await tester.tap(find.byTooltip('Open menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('mobile-navigation-apps')));
    await tester.pumpAndSettle();

    expect(find.text('Connected apps'), findsOneWidget);
    expect(find.byTooltip('Back to chat'), findsOneWidget);
    expect(find.byKey(const Key('mobile-navigation-chat')), findsNothing);
    await tester.tap(find.byTooltip('Back to chat'));
    await tester.pumpAndSettle();
    expect(find.text('What can I help with?'), findsOneWidget);
  });

  testWidgets('uses the expanded shell and supports keyboard navigation', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const NodApp(themeMode: ThemeMode.light));

    expect(find.byKey(const Key('expanded-shell')), findsOneWidget);
    expect(find.byKey(const Key('desktop-sidebar')), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();

    final chat = find.byKey(const Key('desktop-navigation-chat'));
    expect(chat, findsOneWidget);
    expect(Focus.of(tester.element(chat)).hasFocus, isTrue);

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(find.text('Scheduled work'), findsOneWidget);
  });

  testWidgets('remains usable at a high text scale', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(() {
      tester.binding.setSurfaceSize(null);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });

    await tester.pumpWidget(const NodApp(themeMode: ThemeMode.light));
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('What can I help with?'), findsOneWidget);
    expect(find.byTooltip('Open menu'), findsOneWidget);
    await tester.tap(find.byTooltip('Open menu'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('mobile-navigation-usage')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
