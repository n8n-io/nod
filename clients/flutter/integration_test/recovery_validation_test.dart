import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/api/api.dart';
import 'package:nod_client/app/nod_client_app.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/mobile_links.dart';

import '../tool/validation_harness.dart';
import 'support/parity_fixture.dart';
import 'support/parity_workflows.dart';

void main() {
  testWidgets(
    'integrated workflows use isolated HTTP state and exact replies',
    (tester) async {
      const recorderChannel = MethodChannel('com.llfbandit.record/messages');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(recorderChannel, (call) async {
        if (call.method != 'create' && call.method != 'dispose') {
          throw StateError('Unexpected recorder operation.');
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(recorderChannel, null),
      );
      await tester.binding.setSurfaceSize(const Size(430, 932));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final fixture = await ParityFixture.start();
      final repository = HttpNodRepository(credentials: _MemoryCredentials());
      try {
        await repository.connect(
          NodConnectionConfig(
            origin: fixture.origin,
            token: ParityFixture.token,
          ),
        );
        await tester.pumpWidget(
          NodClientApp(
            repository: repository,
            restoreConnection: () async => true,
            linkSource: const _HostLinks(),
            disposeRepository: false,
          ),
        );
        await parityReady(tester, find.text('Synthetic history ready'));
        await runParityWorkflows(
          tester,
          repository,
          fixture.origin,
          ParityFixture.controlToken,
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await repository.dispose();
        await fixture.close();
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test('validates recovery and multi-client coexistence contracts', () async {
    final outputDirectory = await Directory.systemTemp.createTemp(
      'nod-flutter-validation-test-',
    );
    addTearDown(() => outputDirectory.delete(recursive: true));
    final outputPath = '${outputDirectory.path}/result.json';
    final report = await runValidation(outputPath: outputPath);
    final artifact = jsonDecode(
      await File(outputPath).readAsString(),
    ) as Map<String, Object?>;
    final failures = report.checks
        .where((check) => check.status != 'passed')
        .map((check) => '${check.name}: ${check.detail}')
        .join('\n');

    expect(report.passed, isTrue, reason: failures);
    expect(artifact['passed'], isTrue);
    expect(
      report.checks.map((check) => check.name),
      containsAll(<String>[
        'disposable_fixture_start',
        'two_bearer_clients_connect',
        'concurrent_distinct_sends_retained',
        'repeated_client_message_id_deduplicated',
        'sse_interruption_recovers_state_and_history',
        'host_origin_and_cross_site_rejected',
        'token_rotation_rejects_old_clients_and_recovers_new_client',
      ]),
    );
    expect(report.processStopped, isTrue);
    expect(report.disposableDataRemoved, isTrue);
  }, timeout: const Timeout(Duration(minutes: 2)));

  testWidgets(
    'drives NodClientApp through the real repository and SSE recovery path',
    (tester) async {
      const recorderChannel = MethodChannel('com.llfbandit.record/messages');
      final recorderCalls = <String>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(recorderChannel, (call) async {
        recorderCalls.add(call.method);
        if (call.method != 'create' && call.method != 'dispose') {
          throw StateError(
            'Unexpected recorder operation in host recovery test: ${call.method}',
          );
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(recorderChannel, null),
      );
      await tester.binding.setSurfaceSize(const Size(430, 932));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final fixture = await DisposableValidationFixture.start();
      final credentials = _MemoryCredentials();
      final repository = HttpNodRepository(
        credentials: credentials,
        reconnectDelays: const <Duration>[Duration(milliseconds: 5)],
      );
      try {
        await tester.pumpWidget(
          NodClientApp(
            repository: repository,
            restoreConnection: () async => false,
            linkSource: const _HostLinks(),
            disposeRepository: false,
            themeMode: ThemeMode.light,
          ),
        );
        await _pumpUntil(tester, find.byKey(const Key('connection-origin')));
        await tester.enterText(
          find.byKey(const Key('connection-origin')),
          fixture.origin.toString(),
        );
        await tester.enterText(
          find.byKey(const Key('connection-token')),
          fixture.token,
        );
        await tester.tap(find.byKey(const Key('connection-submit')));
        await _pumpUntil(tester, find.text('Synthetic history ready'));

        expect(credentials.value?.token, fixture.token);
        await tester.enterText(
          find.byKey(const Key('chat-composer')),
          'Synthetic app message',
        );
        await tester.pump();
        await tester.tap(find.byKey(const Key('chat-send')));
        await _pumpUntil(tester, find.byKey(const Key('chat-stop')));
        await tester.pump(const Duration(milliseconds: 500));
        await _pumpUntil(tester, find.text('Synthetic app message'));
        await fixture.streamReply();
        await _pumpUntil(tester, find.byKey(const Key('chat-wave-progress')));
        await _pumpUntil(tester, find.text('Synthetic streamed reply'));

        final waiting = repository.events
            .where(
              (event) =>
                  event is NodRefreshEvent &&
                  event.state.turn == NodTurnState.waiting,
            )
            .first;
        await fixture.waitForOwner();
        await waiting.timeout(const Duration(seconds: 10));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        await _pumpUntil(tester, find.byKey(const Key('chat-stop')));
        expect(find.byKey(const Key('chat-wave-progress')), findsNothing);
        final cancelled = repository.events
            .where(
              (event) =>
                  event is NodRefreshEvent &&
                  event.state.turn == NodTurnState.cancelled,
            )
            .first;
        await tester.tap(find.byKey(const Key('chat-stop')));
        await cancelled.timeout(const Duration(seconds: 10));
        await _pumpUntil(tester, find.byKey(const Key('chat-send')));
        expect(find.byKey(const Key('chat-stop')), findsNothing);
        expect(find.byKey(const Key('chat-wave-progress')), findsNothing);

        await fixture.interruptAndCommit(
          id: '00000000-0000-4000-8000-000000000040',
          text: 'Synthetic app recovery reply',
        );
        await _pumpUntil(tester, find.text('Synthetic app recovery reply'));
        expect(find.text('Synthetic app message'), findsOneWidget);
        expect(find.byKey(const Key('chat-composer')), findsOneWidget);
        expect(recorderCalls, ['create']);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await repository.dispose();
        await fixture.close();
      }
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}

Future<void> _pumpUntil(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 10),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (finder.evaluate().isEmpty && DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 20));
  }
  expect(finder, findsOneWidget);
}

final class _HostLinks implements NodMobileLinkSource {
  const _HostLinks();
  @override
  Future<Uri?> initialUri() async => null;
  @override
  Stream<Uri> get uris => const Stream.empty();
}

final class _MemoryCredentials implements NodCredentialStorage {
  NodConnectionConfig? value;

  @override
  Future<void> delete() async {
    value = null;
  }

  @override
  Future<NodConnectionConfig?> read() async => value;

  @override
  Future<void> write(NodConnectionConfig config) async {
    value = config;
  }
}
