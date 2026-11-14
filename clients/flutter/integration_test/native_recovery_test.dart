import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:nod_client/api/api.dart';
import 'package:nod_client/app/nod_client_app.dart';
import 'package:nod_client/core/core.dart';

import 'support/navigation.dart';
import 'support/parity_workflows.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'native app recovers and continues isolated integrated workflows',
    (tester) async {
      const syntheticOnly = bool.fromEnvironment('NOD_SYNTHETIC_ONLY');
      const url = String.fromEnvironment('NOD_SYNTHETIC_URL');
      const token = String.fromEnvironment('NOD_SYNTHETIC_TOKEN');
      const controlToken = String.fromEnvironment(
        'NOD_SYNTHETIC_CONTROL_TOKEN',
      );
      final origin = Uri.tryParse(url);
      if (!syntheticOnly ||
          origin == null ||
          origin.scheme != 'http' ||
          origin.host != '127.0.0.1' ||
          !origin.hasPort ||
          origin.port < 1 ||
          origin.userInfo.isNotEmpty ||
          (origin.path.isNotEmpty && origin.path != '/') ||
          origin.hasQuery ||
          origin.hasFragment ||
          token != 'synthetic-native-token' ||
          controlToken != 'synthetic-native-control') {
        throw StateError(
          'Use explicit loopback synthetic fixture configuration only.',
        );
      }
      final control = http.Client();
      final credentials = _MemoryCredentials();
      final repository = HttpNodRepository(
        credentials: credentials,
        reconnectDelays: const [Duration(milliseconds: 100)],
      );
      try {
        final info = await control
            .get(
              origin.resolve('/fixture/info'),
              headers: {'x-fixture-control': controlToken},
            )
            .timeout(const Duration(seconds: 10));
        expect(info.statusCode, 200);
        expect(jsonDecode(info.body), {
          'fixture': 'nod-synthetic-validation-v1',
          'syntheticOnly': true,
        });

        Future<void> command(
          String path, [
          Map<String, String> body = const {},
        ]) async {
          final response = await control
              .post(
                origin.resolve('/fixture/$path'),
                headers: {
                  'x-fixture-control': controlToken,
                  'Content-Type': 'application/json',
                },
                body: jsonEncode(body),
              )
              .timeout(const Duration(seconds: 10));
          expect(
            response.statusCode,
            200,
            reason: 'Synthetic fixture control failed: $path',
          );
        }

        await tester.pumpWidget(
          NodClientApp(
            repository: repository,
            restoreConnection: () async => false,
            disposeRepository: false,
            themeMode: ThemeMode.light,
          ),
        );
        await _pumpUntil(tester, find.byKey(const Key('connection-origin')));
        await tester.enterText(find.byKey(const Key('connection-origin')), url);
        await tester.enterText(
          find.byKey(const Key('connection-token')),
          token,
        );
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pump(const Duration(milliseconds: 300));
        await tester.ensureVisible(find.byKey(const Key('connection-submit')));
        await tester.tap(find.byKey(const Key('connection-submit')));
        await _pumpUntil(tester, find.text('Synthetic history ready'));
        expect(credentials.value?.token, token);

        await tester.enterText(
          find.byKey(const Key('chat-composer')),
          'Synthetic native app message',
        );
        await tester.pump();
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pump(const Duration(milliseconds: 300));
        final send = find.byKey(const Key('chat-send'));
        expect(tester.widget<IconButton>(send).onPressed, isNotNull);
        final accepted = _nextTurn(repository, NodTurnState.running);
        await tester.tap(send);
        await accepted;
        await _pumpUntil(tester, find.byKey(const Key('chat-stop')));
        final acceptedHistory = await repository.loadHistory();
        expect(
          acceptedHistory.messages.where(
            (message) => message.text == 'Synthetic native app message',
          ),
          hasLength(1),
        );
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('chat-composer')))
              .controller!
              .text,
          isEmpty,
        );
        await command('stream');
        await _pumpUntil(tester, find.byKey(const Key('chat-wave-progress')));
        await _pumpUntil(tester, find.text('Synthetic streamed reply'));
        final waiting = _nextTurn(repository, NodTurnState.waiting);
        await command('wait');
        await waiting;
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        await _pumpUntil(tester, find.byKey(const Key('chat-stop')));
        expect(find.byKey(const Key('chat-wave-progress')), findsNothing);
        final cancelled = _nextTurn(repository, NodTurnState.cancelled);
        await tester.tap(find.byKey(const Key('chat-stop')));
        await cancelled;
        await _pumpUntil(tester, find.byKey(const Key('chat-send')));
        expect(find.byKey(const Key('chat-stop')), findsNothing);
        expect(find.byKey(const Key('chat-wave-progress')), findsNothing);

        await command('interrupt', {
          'id': '00000000-0000-4000-8000-000000000041',
          'text': 'Synthetic native recovery reply',
        });
        await _pumpUntil(tester, find.text('Synthetic native recovery reply'));
        expect(find.text('Synthetic native app message'), findsOneWidget);
        final history = await repository.loadHistory();
        expect(
          history.messages.where(
            (message) => message.text == 'Synthetic native app message',
          ),
          hasLength(1),
        );
        expect(
          history.messages.where(
            (message) => message.id == '00000000-0000-4000-8000-000000000041',
          ),
          hasLength(1),
        );

        await navigateToSection(tester, 'scheduled');
        await _pumpUntil(tester, find.text('Your schedules will appear here.'));
        await navigateToSection(tester, 'usage');
        await _pumpUntil(tester, find.text('Daily API spending'));
        await navigateToSection(tester, 'chat');
        await _pumpUntil(tester, find.text('Synthetic native recovery reply'));
        expect(find.byKey(const Key('chat-composer')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await runParityWorkflows(tester, repository, origin, controlToken);
        if (const bool.fromEnvironment('NOD_SYNTHETIC_LINK_CHECK')) {
          await command('parity/link-ready');
          await _pumpUntil(
            tester,
            find.text('Synthetic saved task'),
            timeout: const Duration(minutes: 1),
          );
          expect(find.byKey(const Key('back-to-chat')), findsOneWidget);
          expect(tester.takeException(), isNull);
          debugPrint(
            'Synthetic foreground OS link opened authenticated tasks.',
          );
        }
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await repository.dispose();
        control.close();
      }
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );
}

Future<NodEvent> _nextTurn(HttpNodRepository repository, NodTurnState turn) =>
    repository.events
        .where((event) => event is NodRefreshEvent && event.state.turn == turn)
        .first
        .timeout(const Duration(seconds: 15));

Future<void> _pumpUntil(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 15),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (finder.evaluate().isEmpty && DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(finder, findsOneWidget);
}

final class _MemoryCredentials implements NodCredentialStorage {
  NodConnectionConfig? value;

  @override
  Future<void> delete() async => value = null;

  @override
  Future<NodConnectionConfig?> read() async => value;

  @override
  Future<void> write(NodConnectionConfig config) async => value = config;
}
