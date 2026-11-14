import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> navigateToSection(WidgetTester tester, String destination) async {
  final desktop = find.byKey(Key('desktop-navigation-$destination'));
  if (desktop.evaluate().isNotEmpty) {
    await tapReadyControl(tester, desktop);
    await _readyControl(tester, desktop);
    return;
  }
  final back = find.byKey(const Key('back-to-chat'));
  final menu = find.byKey(const Key('open-navigation'));
  if (back.evaluate().isNotEmpty) {
    await tapReadyControl(tester, back, drawerClosed: true);
    await _readyControl(tester, menu, drawerClosed: true);
    if (destination == 'chat') return;
  }
  await tapReadyControl(tester, menu, drawerClosed: true);
  await tapReadyControl(
    tester,
    find.byKey(Key('mobile-navigation-$destination')),
  );
  await _readyControl(
    tester,
    destination == 'chat' ? menu : back,
    drawerClosed: true,
  );
}

Future<void> tapReadyControl(
  WidgetTester tester,
  Finder control, {
  bool drawerClosed = false,
}) async {
  await _readyControl(tester, control, drawerClosed: drawerClosed);
  await tester.tap(control.hitTestable());
}

Future<void> _readyControl(
  WidgetTester tester,
  Finder control, {
  bool drawerClosed = false,
}) async {
  final deadline = DateTime.now().add(const Duration(seconds: 15));
  Rect? previous;
  var stableFrames = 0;
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 50));
    final matches = control.hitTestable().evaluate().toList();
    if (matches.length == 1) {
      final element = matches.single;
      final enabled = switch (element.widget) {
        IconButton(:final onPressed) => onPressed != null,
        ListTile(:final enabled, :final onTap) => enabled && onTap != null,
        InkWell(:final onTap) => onTap != null,
        _ => false,
      };
      final drawerReady = !drawerClosed || !Scaffold.of(element).isDrawerOpen;
      if (enabled && drawerReady) {
        final bounds = tester.getRect(control.hitTestable());
        stableFrames = bounds == previous ? stableFrames + 1 : 0;
        previous = bounds;
        if (stableFrames >= 2) return;
        continue;
      }
    }
    previous = null;
    stableFrames = 0;
  }
  fail(
    'Navigation control did not become enabled, hit-testable and stable: $control (drawerClosed: $drawerClosed)',
  );
}
