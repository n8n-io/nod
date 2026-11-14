import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/api/private_requests_repository.dart';
import 'package:nod_client/core/api_transport.dart';
import 'package:nod_client/core/private_requests.dart';
import 'package:nod_client/features/private_requests/private_browser.dart';

void main() {
  for (final end in [false, true]) {
    testWidgets(
      'view ${end ? 'ending' : 'failure'} drops queued input without replay',
      (tester) async {
        final fixture = BrowserFixture();
        if (!end) addTearDown(fixture.frames.close);
        await tester.pumpWidget(
          MaterialApp(
            home: NodPrivateBrowser(
              repository: NodPrivateRequestsRepository(fixture),
              turnId: fixture.turn,
            ),
          ),
        );
        await showFrame(tester, fixture);
        final point = tester.getCenter(find.byType(RawImage));
        await tester.tapAt(point);
        await tester.pump();
        await tester.tapAt(point);
        await tester.pump();
        expect(fixture.calls.length, 1);
        if (end) {
          unawaited(fixture.frames.close());
        } else {
          fixture.frames.addError(StateError('Synthetic view failure'));
        }
        await tester.pumpAndSettle();
        fixture.input.complete({'ok': true});
        await tester.pumpAndSettle();
        expect(fixture.calls.length, 1);
        expect(find.byType(RawImage), findsNothing);
        if (!end) {
          await tester.ensureVisible(find.text('Reconnect view'));
          await tester.tap(find.text('Reconnect view'));
          await tester.pumpAndSettle();
          await showFrame(tester, fixture);
          expect(find.byType(RawImage), findsOneWidget);
          expect(fixture.calls.length, 1);
        }
        await tester.pumpWidget(const SizedBox());
        await tester.pumpAndSettle();
      },
    );
  }
  testWidgets(
    'backgrounding drops queued browser input without dispatch or resume',
    (tester) async {
      final fixture = BrowserFixture();
      addTearDown(fixture.frames.close);
      await tester.pumpWidget(
        MaterialApp(
          home: NodPrivateBrowser(
            repository: NodPrivateRequestsRepository(fixture),
            turnId: fixture.turn,
          ),
        ),
      );
      await showFrame(tester, fixture);
      final point = tester.getCenter(find.byType(RawImage));
      await tester.tapAt(point);
      await tester.pump();
      await tester.tapAt(point);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await tester.pump();
      fixture.input.complete({'ok': true});
      await tester.pumpAndSettle();
      expect(fixture.calls.length, 1);
      expect(find.byType(RawImage), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    },
  );
  testWidgets(
    'browser input is ordered before Done and bound to handoff turn',
    (tester) async {
      final fixture = BrowserFixture();
      addTearDown(fixture.frames.close);
      await tester.pumpWidget(
        MaterialApp(
          home: NodPrivateBrowser(
            repository: NodPrivateRequestsRepository(fixture),
            turnId: fixture.turn,
          ),
        ),
      );
      await showFrame(tester, fixture);
      final image = find.byType(RawImage);
      expect(image, findsOneWidget);
      await tester.tapAt(tester.getCenter(image));
      await tester.pump();
      expect(fixture.calls.map((call) => call.$1), ['/api/browser-handoff']);
      final inputs = fixture.calls.single.$2['inputs']! as List;
      expect(inputs.map((input) => (input as Map)['event']), ['down', 'up']);
      expect((inputs.first as Map)['x'], closeTo(0.5, 0.01));
      await tester.ensureVisible(find.text('Return to Nod'));
      await tester.tap(find.text('Return to Nod'));
      await tester.pump();
      expect(fixture.calls.length, 1);
      fixture.input.complete({'ok': true});
      await tester.pumpAndSettle();
      expect(fixture.calls.last.$1, '/api/browser-handoff/done');
      expect(
        fixture.calls.every((call) => call.$2['turnId'] == fixture.turn),
        isTrue,
      );
      expect(fixture.calls.any((call) => call.$1 == '/api/messages'), isFalse);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('failed handoff input is not replayed or followed by Done', (
    tester,
  ) async {
    final fixture = BrowserFixture();
    addTearDown(fixture.frames.close);
    await tester.pumpWidget(
      MaterialApp(
        home: NodPrivateBrowser(
          repository: NodPrivateRequestsRepository(fixture),
          turnId: fixture.turn,
        ),
      ),
    );
    await showFrame(tester, fixture);
    await tester.tapAt(tester.getCenter(find.byType(RawImage)));
    await tester.pump();
    fixture.input.completeError(StateError('Synthetic stale handoff'));
    await tester.pumpAndSettle();
    expect(fixture.calls.length, 1);
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Return to Nod'),
          )
          .onPressed,
      isNull,
    );
    await tester.pump(const Duration(seconds: 5));
    expect(fixture.calls.length, 1);
    await tester.pumpWidget(const SizedBox());
  });
}

Future<void> showFrame(WidgetTester tester, BrowserFixture fixture) async {
  await tester.pump();
  await tester.runAsync(() async {
    final recorder = ui.PictureRecorder();
    ui.Canvas(recorder).drawColor(const ui.Color(0xffffffff), ui.BlendMode.src);
    final picture = recorder.endRecording();
    final image = await picture.toImage(100, 100);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    fixture.frames.add(bytes!.buffer.asUint8List());
    image.dispose();
    picture.dispose();
  });
  for (
    var index = 0;
    index < 10 && find.byType(RawImage).evaluate().isEmpty;
    index++
  ) {
    await tester.pump(const Duration(milliseconds: 20));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
  }
  await tester.pump();
}

class BrowserFixture implements NodApiTransport, NodPrivateBrowserTransport {
  final turn = '40000000-0000-4000-8000-000000000004';
  final frames = StreamController<List<int>>.broadcast();
  final input = Completer<Object?>();
  final calls = <(String, Map<String, Object?>)>[];

  @override
  Stream<List<int>> browserHandoffFrames(String turnId) {
    if (turnId != turn) throw StateError('Wrong handoff');
    return frames.stream;
  }

  @override
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    if (method != 'POST') throw StateError('Unexpected read');
    calls.add((path, Map.of(body!)));
    if (path == '/api/browser-handoff') return input.future;
    return {'ok': true};
  }
}
