import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/design_system/design_system.dart';
import 'package:nod_client/motion/motion.dart';

void main() {
  testWidgets(
    'ambient work stops scheduling frames when inactive or finished',
    (tester) async {
      Future<void> show({bool active = true, bool visible = true}) =>
          tester.pumpWidget(
            MaterialApp(
              theme: NodTheme.light,
              home: SizedBox.expand(
                child: NodAmbientWaves(
                  visible: visible,
                  working: true,
                  active: active,
                ),
              ),
            ),
          );
      await show();
      final initialTurns = tester
          .widget<RotationTransition>(find.byType(RotationTransition))
          .turns
          .value;
      await tester.pump(const Duration(milliseconds: 200));
      expect(
        tester
            .widget<RotationTransition>(find.byType(RotationTransition))
            .turns
            .value,
        greaterThan(initialTurns),
      );
      expect(tester.binding.hasScheduledFrame, isTrue);
      await show(visible: false);
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);
      await show();
      await tester.pump(const Duration(seconds: 1));
      await show(active: false);
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);
    },
  );

  testWidgets('ambient work is static with reduced motion and high contrast', (
    tester,
  ) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    await tester.pumpWidget(
      MaterialApp(
        theme: NodTheme.dark,
        home: const SizedBox.expand(
          child: NodAmbientWaves(visible: true, working: true),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.binding.hasScheduledFrame, isFalse);
    final initialTurns = tester
        .widget<RotationTransition>(find.byType(RotationTransition))
        .turns
        .value;
    await tester.pump(const Duration(milliseconds: 200));
    expect(
      tester
          .widget<RotationTransition>(find.byType(RotationTransition))
          .turns
          .value,
      initialTurns,
    );
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(highContrast: true);
    await tester.pumpAndSettle();
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('exposes every presence state through semantics', (tester) async {
    final semantics = tester.ensureSemantics();

    for (final state in NodMotionState.values) {
      await tester.pumpWidget(
        MaterialApp(
          theme: NodTheme.light,
          home: Scaffold(body: NodPresence(state: state)),
        ),
      );

      final node = tester.getSemantics(find.byKey(const Key('nod-presence')));
      expect(node.label, state.semanticLabel);
    }

    semantics.dispose();
  });

  testWidgets('reduced motion keeps connecting state static and meaningful', (
    tester,
  ) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);

    await tester.pumpWidget(
      MaterialApp(
        theme: NodTheme.light,
        home: const Scaffold(
          body: Center(child: NodPresence(state: NodMotionState.connecting)),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('nod-presence')), findsOneWidget);
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('lifecycle pauses and resumes motion tickers', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: NodTheme.light,
        home: const NodMotionLifecycle(
          child: NodPresence(state: NodMotionState.working),
        ),
      ),
    );

    expect(
      tester
          .widget<TickerMode>(find.byKey(const Key('nod-motion-ticker-mode')))
          .enabled,
      isTrue,
    );

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();

    expect(
      tester
          .widget<TickerMode>(find.byKey(const Key('nod-motion-ticker-mode')))
          .enabled,
      isFalse,
    );

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();

    expect(
      tester
          .widget<TickerMode>(find.byKey(const Key('nod-motion-ticker-mode')))
          .enabled,
      isTrue,
    );
  });
}
