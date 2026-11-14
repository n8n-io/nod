import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/api/prepared_repository.dart';
import 'package:nod_client/core/api_transport.dart';
import 'package:nod_client/core/nod_errors.dart';
import 'package:nod_client/features/prepared/prepared_page.dart';

const issueId = '11111111-1111-4111-8111-111111111111';

class PreparedContract implements NodApiTransport {
  bool sourceRemoved = false;
  String version = 'v1';
  int reads = 0;
  @override
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    if (method == 'GET' && path == '/api/state') {
      return {
        'messages': [
          {'role': 'user', 'text': '[Untrusted user link](/prepared/$issueId)'},
          {
            'role': 'assistant',
            'text': 'Finding. [Read result](/prepared/$issueId)',
          },
          {
            'role': 'assistant',
            'text': 'Latest finding. [Read result](/prepared/$issueId)',
          },
          {'role': 'assistant', 'text': '[Not a result](/prepared/../tasks)'},
        ],
      };
    }
    if (method == 'GET' && path == '/api/prepared/$issueId') {
      reads++;
      if (sourceRemoved) throw const NodRequestException();
      return {
        'id': issueId,
        'title': 'Synthetic finding',
        'draft': 'A private synthetic draft',
        'unknowns': ['Check the date'],
        'state': 'offered',
        'updatedAt': '2026-11-11T12:00:00Z',
        'sources': [
          {
            'sourceId': 'synthetic-account',
            'id': 'record-1',
            'version': version,
            'label': 'Synthetic source',
            'url': 'https://example.test/record-1',
            'checkedAt': '2026-11-11T12:00:00Z',
          },
        ],
      };
    }
    throw const NodRequestException();
  }
}

void main() {
  test(
    'finding links are bounded to assistant messages and deduplicated',
    () async {
      final repository = NodPreparedRepository(PreparedContract());
      final findings = await repository.recentFindings();
      expect(findings, hasLength(1));
      expect(findings.single.text, startsWith('Latest finding.'));
    },
  );

  testWidgets(
    'finding opens real-contract detail and removed bindings hide the draft',
    (tester) async {
      final transport = PreparedContract();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: NodPreparedPage(transport: transport)),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Latest finding.'));
      await tester.pumpAndSettle();
      expect(find.text('A private synthetic draft'), findsOneWidget);
      transport.sourceRemoved = true;
      await tester.tap(find.text('Refresh').last);
      await tester.pumpAndSettle();
      expect(find.text('A private synthetic draft'), findsNothing);
      expect(find.text('Synthetic source'), findsNothing);
      expect(find.textContaining('unavailable.'), findsOneWidget);
    },
  );

  testWidgets(
    'source opening revalidates the exact version before external launch',
    (tester) async {
      final transport = PreparedContract();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NodPreparedPage(transport: transport, issueId: issueId),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(transport.reads, 1);
      transport.version = 'v2';
      await tester.tap(find.text('Synthetic source'));
      await tester.pumpAndSettle();
      expect(transport.reads, 2);
      expect(find.text('A private synthetic draft'), findsNothing);
      expect(find.textContaining('source could not be opened'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'removal during suspension is checked again before showing the draft',
    (tester) async {
      final transport = PreparedContract();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NodPreparedPage(transport: transport, issueId: issueId),
          ),
        ),
      );
      await tester.pumpAndSettle();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      transport.sourceRemoved = true;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.text('A private synthetic draft'), findsNothing);
      expect(transport.reads, 2);
    },
  );
}
