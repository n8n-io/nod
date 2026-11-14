import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/app/nod_app.dart';

void main() {
  setUp(() {
    TestWidgetsFlutterBinding.ensureInitialized();
  });

  testWidgets('matches the mobile light shell', (tester) async {
    await _capture(
      tester,
      size: const Size(390, 844),
      themeMode: ThemeMode.light,
      golden: 'goldens/nod_shell_mobile_light.png',
    );
  });

  testWidgets('matches the mobile dark shell', (tester) async {
    await _capture(
      tester,
      size: const Size(390, 844),
      themeMode: ThemeMode.dark,
      golden: 'goldens/nod_shell_mobile_dark.png',
    );
  });

  testWidgets('matches the desktop light shell', (tester) async {
    await _capture(
      tester,
      size: const Size(1440, 900),
      themeMode: ThemeMode.light,
      golden: 'goldens/nod_shell_desktop_light.png',
    );
  });

  testWidgets('matches the desktop dark shell', (tester) async {
    await _capture(
      tester,
      size: const Size(1440, 900),
      themeMode: ThemeMode.dark,
      golden: 'goldens/nod_shell_desktop_dark.png',
    );
  });
}

Future<void> _capture(
  WidgetTester tester, {
  required Size size,
  required ThemeMode themeMode,
  required String golden,
}) async {
  await tester.binding.setSurfaceSize(size);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.accessibilityFeaturesTestValue =
      const FakeAccessibilityFeatures(disableAnimations: true);
  addTearDown(() {
    tester.binding.setSurfaceSize(null);
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearAccessibilityFeaturesTestValue();
  });

  await tester.pumpWidget(NodApp(themeMode: themeMode));
  await tester.pumpAndSettle();

  await expectLater(find.byType(NodApp), matchesGoldenFile(golden));
}
