import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/design_system/design_system.dart';

import '../../integration_test/support/navigation.dart';

void main() {
  Future<void> mount(
    WidgetTester tester, {
    Brightness brightness = Brightness.light,
    double scale = 1,
  }) async {
    await tester.binding.setSurfaceSize(Size(scale == 1 ? 390 : 320, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: brightness == Brightness.light ? NodTheme.light : NodTheme.dark,
        home: StatefulBuilder(builder: _host()),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'menu closes on Escape and system back returns a section to chat',
    (tester) async {
      await mount(tester);
      await tester.tap(find.byTooltip('Open menu'));
      await tester.pumpAndSettle();
      final selected = tester.widget<ListTile>(
        find.byKey(const Key('mobile-navigation-chat')),
      );
      expect(selected.selected, true);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('mobile-navigation-chat')), findsNothing);
      await tester.tap(find.byTooltip('Open menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('mobile-navigation-scheduled')));
      await tester.pumpAndSettle();
      expect(find.text('Synthetic section 1'), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('Synthetic section 0'), findsOneWidget);
      expect(find.byTooltip('Open menu'), findsOneWidget);
    },
  );

  testWidgets(
    'native navigation helper waits for enabled controls and drawer closure between sections',
    (tester) async {
      final previous = WidgetController.hitTestWarningShouldBeFatal;
      final previousDilation = timeDilation;
      WidgetController.hitTestWarningShouldBeFatal = true;
      timeDilation = 3;
      addTearDown(() {
        WidgetController.hitTestWarningShouldBeFatal = previous;
        timeDilation = previousDilation;
      });
      await mount(tester);
      for (final destination in ['scheduled', 'usage', 'chat']) {
        await navigateToSection(tester, destination);
        final index = switch (destination) {
          'scheduled' => 1,
          'usage' => 3,
          _ => 0,
        };
        expect(find.text('Synthetic section $index'), findsOneWidget);
        final leading = find.byKey(
          Key(destination == 'chat' ? 'open-navigation' : 'back-to-chat'),
        );
        expect(leading.hitTestable(), findsOneWidget);
        expect(tester.widget<IconButton>(leading).onPressed, isNotNull);
        expect(
          tester
              .state<ScaffoldState>(find.byKey(const Key('compact-shell')))
              .isDrawerOpen,
          isFalse,
        );
      }
      timeDilation = previousDilation;
      expect(tester.takeException(), isNull);
    },
  );

  for (final brightness in Brightness.values) {
    for (final drawer in [false, true]) {
      testWidgets('mobile navigation ${brightness.name} drawer $drawer', (
        tester,
      ) async {
        await mount(tester, brightness: brightness);
        if (drawer) {
          await tester.tap(find.byTooltip('Open menu'));
          await tester.pumpAndSettle();
        }
        expect(find.byType(NavigationBar), findsNothing);
        expect(tester.takeException(), null);
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(
            'goldens/chat_first_${brightness.name}_${drawer ? 'menu' : 'chat'}.png',
          ),
        );
      });
    }
  }

  testWidgets('menu remains usable at 320px and double text size', (
    tester,
  ) async {
    await mount(tester, scale: 2);
    await tester.tap(find.byTooltip('Open menu'));
    await tester.pumpAndSettle();
    for (final section in ['chat', 'scheduled', 'apps', 'usage']) {
      expect(find.byKey(Key('mobile-navigation-$section')), findsOneWidget);
    }
    expect(tester.takeException(), null);
    await tester.tap(find.byKey(const Key('mobile-navigation-usage')));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Back to chat'), findsOneWidget);
    expect(find.text('Synthetic section 3'), findsOneWidget);
  });
}

StatefulWidgetBuilder _host() {
  var selected = 0;
  return (context, setState) => NodAdaptiveShell(
    selectedIndex: selected,
    onDestinationSelected: (index) => setState(() => selected = index),
    onLogOut: () {},
    body: Center(child: Text('Synthetic section $selected')),
  );
}
