import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nod_client/core/api_transport.dart';
import 'package:nod_client/core/attachments.dart';
import 'package:nod_client/core/core.dart';
import 'package:nod_client/core/private_requests.dart';
import 'package:nod_client/core/rich_results.dart' as results;
import 'package:nod_client/design_system/design_system.dart';
import 'package:nod_client/features/chat/agent_message_body.dart';
import 'package:nod_client/features/chat/chat.dart';
import 'package:nod_client/features/chat/chat_testing.dart';
import 'package:nod_client/features/connections/connection_setup_page.dart';
import 'package:nod_client/features/prepared/prepared_page.dart';
import 'package:nod_client/features/private_requests/private_browser.dart';
import 'package:nod_client/features/private_requests/private_requests_page.dart';
import 'package:nod_client/features/results/rich_result.dart';
import 'package:nod_client/motion/motion.dart';

void main() {
  testWidgets(
    'older prepared finding opens exact authenticated result and surfaces refusal',
    (tester) async {
      const id = 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004';
      final backend = FakeNodRepository(
        state: const NodState(
          threadId: 'current-thread',
          messages: [],
          turn: NodTurnState.idle,
          revision: '1',
        ),
      );
      addTearDown(backend.dispose);
      final repository = _PrivateLinkRepository(backend)
        ..contextMessages = [
          NodMessage(
            id: 'older-finding',
            role: NodMessageRole.assistant,
            text: '[Prepared finding](/prepared/$id)',
            createdAt: DateTime(2026),
          ),
        ];
      await tester.pumpWidget(
        MaterialApp(
          theme: NodTheme.light,
          home: Scaffold(
            body: NodChat(
              repository: repository,
              focusMessageId: 'older-finding',
              replyToFocusedMessage: false,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect((await repository.loadState()).messages, isEmpty);
      await tester.tap(find.text('Prepared finding', findRichText: true));
      await tester.pumpAndSettle();
      expect(
        tester.widget<NodPreparedPage>(find.byType(NodPreparedPage)).issueId,
        id,
      );
      expect(repository.reads, contains('/api/prepared/$id'));
      expect(backend.sentTexts, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  for (final kind in ['credentials', 'payments']) {
    testWidgets(
      'older focused $kind link opens exact private form absent from recent state',
      (tester) async {
        final id = kind == 'credentials'
            ? 'a' * 43
            : 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004';
        final backend = FakeNodRepository(
          state: const NodState(
            threadId: 'current-thread',
            messages: [],
            turn: NodTurnState.idle,
            revision: '1',
          ),
        );
        addTearDown(backend.dispose);
        final repository = _PrivateLinkRepository(backend)
          ..contextMessages = [
            NodMessage(
              id: 'older-private',
              turnId: 'older-task-turn',
              role: NodMessageRole.assistant,
              text: '[Open private form](</$kind/$id>)',
              createdAt: DateTime(2026),
            ),
          ];
        await tester.pumpWidget(
          MaterialApp(
            theme: NodTheme.light,
            home: Scaffold(
              body: NodChat(
                repository: repository,
                focusMessageId: 'older-private',
                replyToFocusedMessage: false,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect((await repository.loadState()).messages, isEmpty);
        await tester.tap(find.text('Open private form', findRichText: true));
        await tester.pumpAndSettle();
        final entry = tester.widget<NodPrivateEntry>(
          find.byType(NodPrivateEntry),
        );
        expect(entry.request.id, id);
        expect(
          repository.reads,
          contains(
            '/api/${kind == 'credentials' ? 'credential' : 'payment'}-requests/$id${kind == 'payments' ? '/status' : ''}',
          ),
        );
        expect(backend.sentTexts, isEmpty);
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }

  testWidgets(
    'older focused task browser uses exact context turn absent from recent state',
    (tester) async {
      const turnId = 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004';
      final backend = FakeNodRepository(
        state: const NodState(
          threadId: 'current-thread',
          messages: [],
          turn: NodTurnState.idle,
          revision: '1',
        ),
      );
      addTearDown(backend.dispose);
      final repository = _PrivateLinkRepository(backend)
        ..contextMessages = [
          NodMessage(
            id: 'older-handoff',
            turnId: turnId,
            role: NodMessageRole.assistant,
            text: 'Finish the synthetic step in my browser.',
            createdAt: DateTime(2026),
          ),
        ];
      await tester.pumpWidget(
        MaterialApp(
          theme: NodTheme.light,
          home: Scaffold(
            body: NodChat(
              repository: repository,
              focusMessageId: 'older-handoff',
              replyToFocusedMessage: false,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect((await repository.loadState()).messages, isEmpty);
      expect(
        find.text('Finish the synthetic step in my browser.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Open task browser'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<NodPrivateBrowser>(find.byType(NodPrivateBrowser)).turnId,
        turnId,
      );
      expect(repository.browserTurns, [turnId]);
      expect(backend.sentTexts, isEmpty);
      expect(
        repository.reads.where((path) => path.contains('browser-handoff')),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'discovered connection Markdown opens authenticated setup with exact proposal and display name',
    (tester) async {
      const proposal = 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004';
      final backend = FakeNodRepository(
        state: NodState(
          messages: [
            NodMessage(
              id: 'discovery',
              role: NodMessageRole.assistant,
              text: '[Example Service](/apps?connect=$proposal)',
              createdAt: DateTime(2026),
            ),
          ],
          turn: NodTurnState.idle,
          revision: '1',
        ),
      );
      addTearDown(backend.dispose);
      final repository = _PrivateLinkRepository(backend);
      await tester.pumpWidget(
        MaterialApp(
          theme: NodTheme.light,
          home: Scaffold(body: NodChat(repository: repository)),
        ),
      );
      await tester.pumpAndSettle();
      final markdown = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
      markdown.onTapLink!('Example Service', '/apps?connect=$proposal', '');
      await tester.pumpAndSettle();
      final setup = tester.widget<NodConnectionSetupPage>(
        find.byType(NodConnectionSetupPage),
      );
      expect(setup.discoveryId, proposal);
      expect(setup.name, 'Example Service');
      expect(repository.reads, contains('/api/apps/discovery/$proposal'));
      expect(backend.sentTexts, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'private Markdown link opens its exact bound native request without sending chat',
    (tester) async {
      final credentialId = 'a' * 43;
      final backend = FakeNodRepository(
        state: NodState(
          messages: [
            NodMessage(
              id: 'private',
              role: NodMessageRole.assistant,
              text: '[Private sign-in](/credentials/$credentialId)',
              createdAt: DateTime(2026),
            ),
          ],
          turn: NodTurnState.idle,
          revision: '1',
        ),
      );
      addTearDown(backend.dispose);
      final repository = _PrivateLinkRepository(backend);
      await tester.pumpWidget(
        MaterialApp(
          theme: NodTheme.light,
          home: Scaffold(body: NodChat(repository: repository)),
        ),
      );
      await tester.pumpAndSettle();
      final markdown = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
      markdown.onTapLink!('Private sign-in', '/credentials/$credentialId', '');
      await tester.pumpAndSettle();
      expect(find.byType(NodPrivateEntry), findsOneWidget);
      expect(
        repository.reads,
        contains('/api/credential-requests/$credentialId'),
      );
      expect(backend.sentTexts, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'persisted presentation-only results render chart values and booking certainty in chat',
    (tester) async {
      final values = jsonDecode(
        File('test/fixtures/client-api/rich-results.json').readAsStringSync(),
      ) as List;
      for (final index in [0, 1, 2, 4, 5]) {
        final visual = results.NodRichResult.parse(values[index])!;
        final repository = FakeNodRepository(
          state: NodState(
            messages: [
              NodMessage(
                id: 'result-$index',
                role: NodMessageRole.assistant,
                text: '',
                createdAt: DateTime(2026),
                presentation: visual,
              ),
            ],
            turn: NodTurnState.idle,
            revision: '1',
          ),
        );
        addTearDown(repository.dispose);
        await _pumpChat(tester, repository);
        expect(find.byType(NodRichResult), findsOneWidget);
        expect(find.text(visual.title), findsOneWidget);
        if (index == 0) {
          expect(find.text('value: -12'), findsOneWidget);
          expect(find.text('value: 28'), findsOneWidget);
        }
        if (index == 1) {
          expect(find.text('status: pending'), findsOneWidget);
          expect(find.text('value: USD 128'), findsOneWidget);
          expect(find.text('status: option'), findsOneWidget);
        }
        if (index == 2) {
          expect(find.text('status: unknown'), findsOneWidget);
          expect(find.text('operated by: Example Regional'), findsOneWidget);
          expect(find.text('time zone: UTC'), findsNWidgets(2));
        }
        if (index == 4) {
          expect(
            find.textContaining('Availability not verified'),
            findsOneWidget,
          );
          expect(find.text('scope: selection'), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      }
    },
  );

  testWidgets(
    'task message navigation anchors older messages and updates the addressed reply',
    (tester) async {
      final messages = List.generate(
        60,
        (index) => NodMessage(
          id: 'message-$index',
          role: NodMessageRole.assistant,
          text: 'Task question $index',
          createdAt: DateTime(2026, 1, 1, 0, index),
        ),
      );
      final repository = FakeNodRepository(
        state: NodState(
          threadId: 'thread',
          messages: messages,
          turn: NodTurnState.waiting,
          revision: '1',
        ),
      );
      addTearDown(repository.dispose);
      await _pumpChat(tester, repository, focusMessageId: 'message-0');
      final first = tester.getRect(find.byKey(const ValueKey('message-0')));
      final firstViewport = tester.getRect(
        find.byKey(const ValueKey('chat-focus-message-0')),
      );
      expect(first.top, greaterThanOrEqualTo(firstViewport.top));
      expect(first.bottom, lessThanOrEqualTo(firstViewport.bottom));
      expect(find.byTooltip('Cancel reply'), findsOneWidget);
      await _pumpChat(tester, repository, focusMessageId: 'message-40');
      final next = tester.getRect(find.byKey(const ValueKey('message-40')));
      final nextViewport = tester.getRect(
        find.byKey(const ValueKey('chat-focus-message-40')),
      );
      expect(next.top, greaterThanOrEqualTo(nextViewport.top));
      expect(next.bottom, lessThanOrEqualTo(nextViewport.bottom));
      expect(
        find.byKey(const ValueKey('chat-focus-message-40')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('chat-focus-unavailable')), findsNothing);
      expect(repository.sentTexts, isEmpty);
      await _pumpChat(tester, repository, focusMessageId: 'missing-message');
      expect(find.byKey(const Key('chat-focus-unavailable')), findsOneWidget);
      expect(find.byTooltip('Cancel reply'), findsNothing);
      expect(repository.sentTexts, isEmpty);
    },
  );

  test(
    'attachment send retry keeps its client ID and never retries automatically',
    () async {
      final repository = FakeNodRepository()
        ..queueSendError(const NodTimeoutException());
      final controller = ChatController(repository);
      addTearDown(() async {
        controller.dispose();
        await repository.dispose();
      });
      await controller.start();
      const artifact = NodArtifact(
        id: 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004',
        name: 'synthetic.txt',
        mimeType: 'text/plain',
        size: 16,
      );
      expect(await controller.sendText('', attachments: [artifact]), isFalse);
      expect(repository.sentTexts, hasLength(1));
      final id = repository.sentTexts.single.clientMessageId;
      expect(await controller.sendText('', attachments: [artifact]), isTrue);
      expect(repository.sentTexts, hasLength(2));
      expect(repository.sentTexts.last.clientMessageId, id);
      expect(controller.messages.single.attachments.single.id, artifact.id);
    },
  );

  test('attachment timeout reconciles an already accepted message without resubmitting', () async {
    final gate = Completer<void>();
    final repository = FakeNodRepository();
    repository.nextSendGate = gate;
    repository.queueSendError(const NodTimeoutException());
    final controller = ChatController(repository);
    addTearDown(() async {
      controller.dispose();
      await repository.dispose();
    });
    await controller.start();
    const artifact = NodArtifact(
      id: 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004',
      name: 'synthetic.txt',
      mimeType: 'text/plain',
      size: 16,
    );
    final sending = controller.sendText('', attachments: [artifact]);
    final id = repository.sentTexts.single.clientMessageId;
    repository.replaceState(
      NodState(
        messages: [
          NodMessage(
            id: id,
            role: NodMessageRole.owner,
            text: '',
            createdAt: DateTime.now(),
            attachments: [artifact],
          ),
        ],
        turn: NodTurnState.queued,
        revision: 'accepted',
      ),
    );
    gate.complete();
    expect(await sending, isTrue);
    expect(repository.sentTexts, hasLength(1));
    expect(controller.messages.single.id, id);
    expect(controller.messages.single.isPending, isFalse);
  });

  testWidgets(
    'file-only send waits for upload and removing an oversized file keeps the valid selection at large text size',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final repository = FakeNodRepository()..uploadGate = Completer<void>();
      addTearDown(repository.dispose);
      await _pumpChat(
        tester,
        repository,
        textScale: 1.6,
        pickAttachments: () async => [
          const NodUploadFile(
            name: 'synthetic.txt',
            size: 16,
            mimeType: 'text/plain',
          ),
          const NodUploadFile(
            name: 'too-large.bin',
            size: nodAttachmentLimit + 1,
            mimeType: 'application/octet-stream',
          ),
        ],
      );
      await tester.tap(find.byKey(const Key('chat-attach')));
      await tester.pump();
      expect(repository.uploadCalls, 1);
      expect(
        tester.widget<IconButton>(find.byKey(const Key('chat-send'))).onPressed,
        isNull,
      );
      await tester.ensureVisible(find.byTooltip('Remove too-large.bin'));
      await tester.pump();
      await tester.tap(find.byTooltip('Remove too-large.bin'));
      await tester.pump();
      repository.uploadGate!.complete();
      await tester.pump();
      await tester.pump();
      expect(
        tester.widget<IconButton>(find.byKey(const Key('chat-send'))).onPressed,
        isNotNull,
      );
      await tester.tap(find.byKey(const Key('chat-send')));
      await tester.pump();
      await tester.pump();
      expect(repository.attachmentSends.single.single.name, 'synthetic.txt');
      expect(repository.sentTexts.single.text, '');
      expect(find.byTooltip('Remove synthetic.txt'), findsNothing);
      expect(find.textContaining('synthetic.txt'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'removed upload cannot reappear after its network response arrives',
    (tester) async {
      final repository = FakeNodRepository()..uploadGate = Completer<void>();
      addTearDown(repository.dispose);
      await _pumpChat(
        tester,
        repository,
        pickAttachments: () async => [
          const NodUploadFile(
            name: 'cancelled.txt',
            size: 16,
            mimeType: 'text/plain',
          ),
        ],
      );
      await tester.tap(find.byKey(const Key('chat-attach')));
      await tester.pump();
      await tester.tap(find.byTooltip('Remove cancelled.txt'));
      await tester.pump();
      expect(repository.cancelledUploads, 1);
      repository.uploadGate!.complete();
      await tester.pump();
      expect(find.textContaining('cancelled.txt'), findsNothing);
      expect(repository.attachmentSends, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'opens and reopens long variable-height history at the latest reply',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final repository = FakeNodRepository(
        history: NodHistory(
          messages: List.generate(
            80,
            (index) => NodMessage(
              id: 'history-$index',
              role: NodMessageRole.assistant,
              text: index == 79
                  ? 'Latest reply'
                  : '## Reply $index\n\n${List.filled(index % 7 + 1, 'A paragraph with variable height and **formatted text**.').join('\n\n')}',
              createdAt: DateTime.utc(
                2026,
                11,
                8,
              ).add(Duration(seconds: index)),
            ),
          ),
        ),
      );
      addTearDown(repository.dispose);
      final bucket = PageStorageBucket();
      for (final scale in [1.0, 1.6]) {
        await _pumpChat(
          tester,
          repository,
          textScale: scale,
          storageBucket: bucket,
        );
        final latest = find.byKey(const ValueKey('message-text-history-79'));
        expect(latest.hitTestable(), findsOneWidget);
        final list = find.byKey(const Key('chat-message-list'));
        expect(
          tester.getBottomRight(latest).dy,
          lessThanOrEqualTo(tester.getBottomRight(list).dy),
        );
        await tester.drag(list, const Offset(0, 650));
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
  );

  testWidgets(
    'follows streamed replies at latest but does not jump while reading history',
    (tester) async {
      final repository = FakeNodRepository(
        history: NodHistory(
          messages: List.generate(
            30,
            (index) => NodMessage(
              id: 'history-$index',
              role: NodMessageRole.owner,
              text: List.filled(5, 'History $index').join('\n'),
              createdAt: DateTime.utc(
                2026,
                11,
                8,
              ).add(Duration(seconds: index)),
            ),
          ),
        ),
      );
      addTearDown(repository.dispose);
      await _pumpChat(tester, repository);
      final list = find.byKey(const Key('chat-message-list'));
      final controller = tester.widget<ListView>(list).controller!;
      repository.emitEvent(
        const NodMessageDeltaEvent(
          messageId: 'stream-latest',
          text: 'New reply',
        ),
      );
      await tester.pumpAndSettle();
      expect(controller.offset, controller.position.minScrollExtent);
      expect(find.text('New reply').hitTestable(), findsOneWidget);
      await tester.drag(list, const Offset(0, 650));
      await tester.pumpAndSettle();
      final before = controller.offset;
      expect(before, greaterThan(120));
      repository.emitEvent(
        const NodMessageDeltaEvent(
          messageId: 'stream-latest',
          text: '\n\nMore detail.',
        ),
      );
      await tester.pumpAndSettle();
      expect(controller.offset, closeTo(before, 1));
      expect(
        find.text('New reply\n\nMore detail.').hitTestable(),
        findsNothing,
      );
    },
  );

  testWidgets('agent links refuse executable and local URL schemes', (
    tester,
  ) async {
    final calls = <MethodCall>[];
    const channel = MethodChannel('plugins.flutter.io/url_launcher');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      calls.add(call);
      return true;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: NodTheme.light,
        home: const Scaffold(
          body: AgentMessageBody(text: '[Guide](https://example.com)'),
        ),
      ),
    );
    final markdown = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    for (final href in [
      'javascript:alert(1)',
      'file:///private/file',
      'data:text/html,test',
      '/api/private',
      'https://',
    ]) {
      markdown.onTapLink!('Link', href, '');
      await tester.pump();
    }
    expect(calls, isEmpty);
    markdown.onTapLink!('Guide', 'https://example.com', '');
    await tester.pumpAndSettle();
    expect(calls, hasLength(1));
    expect(calls.single.arguments['url'], 'https://example.com');
  });

  testWidgets(
    'agent Markdown handles streaming and narrow accessible layouts',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      for (final theme in [NodTheme.light, NodTheme.dark]) {
        for (final text in [
          '## Update\n\n**Working',
          '## Update\n\n**Ready** with `inline code`.\n\n'
              '- First item\n- Second item\n\n'
              '> A useful note.\n\n'
              '```dart\nfinal value = "a long code line that should scroll rather than overflow the phone screen";\n```\n\n'
              '| Name | Details |\n| --- | --- |\n'
              '| Example | A wide table entry that stays readable |\n\n'
              '![Private image](https://example.invalid/tracker.png)',
        ]) {
          await tester.pumpWidget(
            MaterialApp(
              theme: theme,
              home: MediaQuery(
                data: const MediaQueryData(textScaler: TextScaler.linear(1.6)),
                child: Scaffold(
                  body: SingleChildScrollView(
                    padding: const EdgeInsets.all(16),
                    child: AgentMessageBody(text: text),
                  ),
                ),
              ),
            ),
          );
          await tester.pump();
          expect(tester.takeException(), isNull);
          expect(find.byType(Image), findsNothing);
        }
      }
    },
  );

  for (final testCase in <(String, Object, ChatFailureKind)>[
    (
      'unauthorized errors',
      const NodUnauthorizedException(),
      ChatFailureKind.unauthorized,
    ),
    (
      'forbidden errors',
      const NodForbiddenException(),
      ChatFailureKind.unauthorized,
    ),
    (
      'conversation reset conflicts',
      const NodConflictException(NodConflictKind.conversationReset),
      ChatFailureKind.conversationReset,
    ),
    ('offline errors', const NodOfflineException(), ChatFailureKind.offline),
    ('timeout errors', const NodTimeoutException(), ChatFailureKind.offline),
  ]) {
    test('maps core ${testCase.$1}', () async {
      final repository = FakeNodRepository()..queueLoadError(testCase.$2);
      final controller = ChatController(repository);
      addTearDown(() async {
        controller.dispose();
        await repository.dispose();
      });

      await controller.start();

      expect(controller.failure?.kind, testCase.$3);
    });
  }

  test('generates unique RFC 4122 version 4 client message IDs', () async {
    final repository = FakeNodRepository(autoAcknowledgeSends: false);
    final controller = ChatController(repository);
    addTearDown(() async {
      controller.dispose();
      await repository.dispose();
    });
    await controller.start();

    expect(await controller.sendText('First message'), isTrue);
    expect(await controller.sendText('Second message'), isTrue);

    final ids = repository.sentTexts
        .map((sent) => sent.clientMessageId)
        .toList();
    final uuidV4 = RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    );
    expect(ids, hasLength(2));
    expect(ids.toSet(), hasLength(2));
    expect(ids, everyElement(matches(uuidV4)));
  });

  test(
    'reconciles optimistic messages when the server uses the client ID',
    () async {
      final repository = FakeNodRepository(autoAcknowledgeSends: false);
      final controller = ChatController(repository);
      addTearDown(() async {
        controller.dispose();
        await repository.dispose();
      });
      await controller.start();
      await controller.sendText('Hello');
      final clientMessageId = repository.sentTexts.single.clientMessageId;

      repository.emitEvent(
        NodRefreshEvent(
          NodState(
            messages: <NodMessage>[
              NodMessage(
                id: clientMessageId,
                role: NodMessageRole.owner,
                text: 'Hello',
                createdAt: DateTime.utc(2026, 11, 6),
              ),
            ],
            turn: NodTurnState.queued,
            revision: 'refresh',
          ),
        ),
      );

      expect(controller.messages, hasLength(1));
      expect(controller.messages.single.id, clientMessageId);
      expect(controller.messages.single.isPending, isFalse);
    },
  );

  testWidgets('renders initial history and long messages without overflow', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final repository = FakeNodRepository(
      history: NodHistory(
        messages: <NodMessage>[
          ChatFixtures.ownerMessage(text: ChatFixtures.longMessage),
          ChatFixtures.assistantMessage(),
        ],
      ),
    );
    addTearDown(repository.dispose);

    await _pumpChat(tester, repository);

    expect(find.text(ChatFixtures.longMessage), findsOneWidget);
    expect(
      find.text('The project is on track for the planned review.'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('shows an empty state with an available composer', (
    tester,
  ) async {
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);

    await _pumpChat(tester, repository);

    expect(find.byKey(const Key('chat-empty-title')), findsOneWidget);
    expect(find.byKey(const Key('chat-composer')), findsOneWidget);
    expect(find.byKey(const Key('chat-send')), findsOneWidget);
  });

  testWidgets(
    'paces working replies and flushes received content when work stops',
    (tester) async {
      final repository = FakeNodRepository();
      addTearDown(repository.dispose);
      await _pumpChat(tester, repository);
      repository.emitEvent(const NodActivityEvent(NodTurnState.running));
      repository.emitEvent(
        const NodMessageDeltaEvent(
          messageId: 'paced',
          text: 'This entire line arrived in one network chunk.',
        ),
      );
      await tester.pump();
      expect(
        tester.widget<MarkdownBody>(find.byType(MarkdownBody)).data,
        'This',
      );
      await tester.pump(const Duration(milliseconds: 16));
      await tester.pump(const Duration(milliseconds: 32));
      expect(
        tester.widget<MarkdownBody>(find.byType(MarkdownBody)).data.length,
        inInclusiveRange(7, 8),
      );
      repository.emitEvent(const NodActivityEvent(NodTurnState.idle));
      await tester.pump();
      expect(
        find.text('This entire line arrived in one network chunk.'),
        findsOneWidget,
      );
      await tester.pumpAndSettle();
    },
  );

  testWidgets('appends assistant deltas and reconciles the final message', (
    tester,
  ) async {
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository);

    repository.emitEvent(
      const NodMessageDeltaEvent(messageId: 'stream-1', text: 'Here is '),
    );
    await tester.pump();
    repository.emitEvent(
      const NodMessageDeltaEvent(messageId: 'stream-1', text: 'the update.'),
    );
    await tester.pump();

    expect(find.text('Here is the update.'), findsOneWidget);

    repository.emitEvent(
      NodMessageEvent(
        ChatFixtures.assistantMessage(
          id: 'stream-1',
          text: 'Here is the final update.',
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Here is the update.'), findsNothing);
    expect(find.text('Here is the final update.'), findsOneWidget);
  });

  testWidgets(
    'empty assistant history and stream placeholders stay hidden until content arrives',
    (tester) async {
      final repository = FakeNodRepository(
        history: NodHistory(
          messages: [
            ChatFixtures.ownerMessage(),
            ChatFixtures.assistantMessage(id: 'blank', text: ''),
            ChatFixtures.assistantMessage(id: 'whitespace', text: '  \n\t'),
            NodMessage(
              id: 'attachment-only',
              role: NodMessageRole.assistant,
              text: '',
              createdAt: ChatFixtures.baseTime,
              attachments: const [
                NodArtifact(
                  id: 'synthetic-artifact',
                  name: 'synthetic.txt',
                  mimeType: 'text/plain',
                  size: 16,
                ),
              ],
            ),
          ],
        ),
      );
      addTearDown(repository.dispose);
      await _pumpChat(tester, repository, disableAnimations: true);
      expect(find.byKey(const ValueKey('blank')), findsNothing);
      expect(find.byKey(const ValueKey('whitespace')), findsNothing);
      expect(find.byKey(const ValueKey('attachment-only')), findsOneWidget);
      repository.emitEvent(const NodActivityEvent(NodTurnState.running));
      repository.emitEvent(
        const NodMessageDeltaEvent(messageId: 'stream', text: ''),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('stream')), findsNothing);
      repository.emitEvent(
        const NodMessageDeltaEvent(messageId: 'stream', text: 'Visible reply'),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('stream')), findsOneWidget);
      expect(find.text('Visible reply'), findsOneWidget);
      repository.emitEvent(
        NodMessageEvent(
          ChatFixtures.assistantMessage(id: 'stream', text: 'Final reply'),
        ),
      );
      await tester.pump();
      expect(find.text('Final reply'), findsOneWidget);
      expect(find.byKey(const ValueKey('stream')), findsOneWidget);
    },
  );

  testWidgets('replays events that arrive while initial state is loading', (
    tester,
  ) async {
    final repository = FakeNodRepository();
    final loadGate = Completer<void>();
    repository.loadGate = loadGate;
    addTearDown(repository.dispose);

    await _pumpChat(tester, repository, settle: false);
    repository.emitEvent(
      const NodMessageDeltaEvent(
        messageId: 'during-load',
        text: 'Latest reply',
      ),
    );
    repository.emitConnection(
      const NodConnectionState(phase: NodConnectionPhase.connected),
    );
    repository.emitEvent(const NodActivityEvent(NodTurnState.running));
    loadGate.complete();
    await tester.pump();

    expect(find.text('Latest reply'), findsNothing);
    expect(find.byKey(const Key('chat-wave-progress')), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 16));
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 32));
    }
    expect(find.text('Latest reply'), findsOneWidget);
  });

  for (final dark in [false, true]) {
    for (final scale in [1.0, 1.8]) {
      testWidgets(
        'sent text flies from composer without waiting for delivery ($dark, $scale)',
        (tester) async {
          await tester.binding.setSurfaceSize(const Size(390, 844));
          addTearDown(() => tester.binding.setSurfaceSize(null));
          final gate = Completer<void>();
          final repository = FakeNodRepository()..nextSendGate = gate;
          addTearDown(repository.dispose);
          await _pumpChat(tester, repository, darkMode: dark, textScale: scale);
          await tester.enterText(
            find.byKey(const Key('chat-composer')),
            'Plan my morning.\nKeep it focused.',
          );
          await tester.pump();
          await tester.tap(find.byKey(const Key('chat-send')));
          await tester.pump();
          await tester.pump();
          final flight = find.byKey(const Key('chat-send-flight'));
          expect(flight, findsOneWidget);
          expect(repository.sentTexts, hasLength(1));
          final start = tester.getTopLeft(flight);
          await tester.pump(const Duration(milliseconds: 160));
          expect(tester.getTopLeft(flight).dy, lessThan(start.dy));
          expect(tester.takeException(), isNull);
          await tester.pump(const Duration(milliseconds: 240));
          expect(flight, findsNothing);
          expect(
            find.text('Plan my morning.\nKeep it focused.'),
            findsOneWidget,
          );
          expect(
            find.byKey(const Key('pending-message-label')),
            findsOneWidget,
          );
          gate.complete();
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  testWidgets(
    'backgrounding ends the flight without removing the sent message',
    (tester) async {
      final gate = Completer<void>();
      final repository = FakeNodRepository()..nextSendGate = gate;
      addTearDown(repository.dispose);
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
      await _pumpChat(tester, repository);
      await tester.enterText(
        find.byKey(const Key('chat-composer')),
        'Keep this sent message',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('chat-send')));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const Key('chat-send-flight')), findsOneWidget);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      expect(find.byKey(const Key('chat-send-flight')), findsNothing);
      expect(find.text('Keep this sent message'), findsOneWidget);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      gate.complete();
      await tester.pumpAndSettle();
      expect(repository.sentTexts, hasLength(1));
    },
  );

  testWidgets('reduced motion sends directly without a flying copy', (
    tester,
  ) async {
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository, disableAnimations: true);
    await tester.enterText(
      find.byKey(const Key('chat-composer')),
      'A direct message',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('chat-send')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('chat-send-flight')), findsNothing);
    expect(find.text('A direct message'), findsOneWidget);
    expect(repository.sentTexts, hasLength(1));
  });

  testWidgets('failed delivery cancels a flight and restores the draft', (
    tester,
  ) async {
    final gate = Completer<void>();
    final repository = FakeNodRepository()
      ..nextSendGate = gate
      ..queueSendError(const ChatRepositoryException(ChatFailureKind.offline));
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository);
    await tester.enterText(
      find.byKey(const Key('chat-composer')),
      'Restore this draft',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('chat-send')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('chat-send-flight')), findsOneWidget);
    gate.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('chat-send-flight')), findsNothing);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('chat-composer')))
          .controller!
          .text,
      'Restore this draft',
    );
    expect(find.byKey(const Key('pending-message-label')), findsNothing);
  });

  testWidgets('keeps an optimistic message then restores a failed send', (
    tester,
  ) async {
    final repository = FakeNodRepository();
    final gate = Completer<void>();
    repository.nextSendGate = gate;
    repository.queueSendError(
      const ChatRepositoryException(
        ChatFailureKind.offline,
        detail: 'Connection interrupted.',
      ),
    );
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository);

    await tester.enterText(
      find.byKey(const Key('chat-composer')),
      'Prepare the update',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('chat-send')));
    await tester.pump();

    expect(find.text('Prepare the update'), findsOneWidget);
    expect(find.byKey(const Key('pending-message-label')), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('chat-composer')))
          .controller
          ?.text,
      isEmpty,
    );

    gate.complete();
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('pending-message-label')), findsNothing);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('chat-composer')))
          .controller
          ?.text,
      'Prepare the update',
    );
    expect(find.byKey(const Key('chat-failure-offline')), findsOneWidget);

    await tester.pump();
    await tester.tap(find.byKey(const Key('chat-send')));
    await tester.pump();

    expect(repository.sentTexts, hasLength(2));
    expect(find.text('Prepare the update'), findsOneWidget);
    expect(find.byKey(const Key('pending-message-label')), findsNothing);
  });

  testWidgets('retries a failed initial load', (tester) async {
    final semantics = tester.ensureSemantics();
    final repository = FakeNodRepository(history: ChatFixtures.history)
      ..queueLoadError(const ChatRepositoryException(ChatFailureKind.offline));
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository);

    final retry = find.byKey(const Key('chat-retry'));
    expect(retry, findsOneWidget);
    expect(tester.getSemantics(retry).label, 'Retry');

    await tester.tap(retry);
    await tester.pumpAndSettle();

    expect(find.text('Summarize the project update.'), findsOneWidget);
    expect(repository.loadHistoryCalls, 2);
    expect(repository.loadStateCalls, 2);
    semantics.dispose();
  });

  for (final kind in <ChatFailureKind>[
    ChatFailureKind.offline,
    ChatFailureKind.unknown,
  ]) {
    testWidgets('${kind.name} failure stays usable at high text scale', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final semantics = tester.ensureSemantics();
      final repository = FakeNodRepository(history: ChatFixtures.history)
        ..queueLoadError(ChatRepositoryException(kind));
      addTearDown(repository.dispose);

      await _pumpChat(tester, repository, textScale: 2);

      final retry = find.byKey(const Key('chat-retry'));
      expect(retry, findsOneWidget);
      expect(tester.getSize(retry).height, greaterThanOrEqualTo(48));
      expect(tester.getSemantics(retry).label, 'Retry');
      expect(tester.takeException(), isNull);
      semantics.dispose();
    });
  }

  testWidgets(
    'renders ordinary answer choices and submits the selected value',
    (tester) async {
      final repository = FakeNodRepository();
      addTearDown(repository.dispose);
      await _pumpChat(tester, repository);

      repository.emitQuestion(ChatFixtures.ordinaryQuestion);
      await tester.pump();

      expect(find.text('Which format should I prepare?'), findsOneWidget);
      expect(find.text('Brief'), findsOneWidget);
      expect(find.text('Detailed'), findsOneWidget);
      expect(find.byKey(const Key('chat-stop')), findsOneWidget);
      expect(find.byKey(const Key('chat-send')), findsNothing);

      await tester.tap(
        find.byKey(
          const ValueKey('question-choice-Prepare a detailed version'),
        ),
      );
      await tester.pump();

      expect(repository.sentTexts.single.text, 'Prepare a detailed version');
      expect(find.text('Which format should I prepare?'), findsNothing);
    },
  );

  testWidgets(
    'server pending choices stay with their message and clear when stale or reset',
    (tester) async {
      final message = NodMessage(
        id: 'question-message',
        role: NodMessageRole.assistant,
        text: 'Which report?',
        createdAt: DateTime(2026),
        answerChoices: const NodAnswerChoices(
          multiple: false,
          options: [
            NodAnswerChoice(
              id: 'choice-1',
              label: 'Draft',
              description: 'Keep it private',
            ),
          ],
        ),
      );
      NodState state(String threadId, List<String> pending) => NodState(
        threadId: threadId,
        messages: [message],
        turn: NodTurnState.waiting,
        revision: threadId,
        pendingAnswerChoiceMessageIds: pending,
      );
      final repository = FakeNodRepository(
        state: state('original-thread', ['question-message']),
      );
      addTearDown(repository.dispose);
      await _pumpChat(tester, repository);
      repository.emitConnection(
        const NodConnectionState(phase: NodConnectionPhase.connected),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('answer-choice-1')), findsOneWidget);
      await tester.tap(find.text('Write an answer'));
      await tester.pump();
      expect(find.byTooltip('Cancel reply'), findsOneWidget);
      repository.emitEvent(NodRefreshEvent(state('original-thread', [])));
      await tester.pump();
      expect(find.byKey(const ValueKey('answer-choice-1')), findsNothing);
      repository.emitEvent(NodRefreshEvent(state('new-thread', [])));
      await tester.pump();
      expect(find.byTooltip('Cancel reply'), findsNothing);
      expect(find.text('Which report?'), findsOneWidget);
    },
  );

  testWidgets('renders approval questions without private entry', (
    tester,
  ) async {
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository);

    repository.emitQuestion(ChatFixtures.approvalQuestion);
    await tester.pump();

    expect(find.text('Nod needs your approval'), findsOneWidget);
    expect(find.text('Approve'), findsOneWidget);
    expect(find.text('Decline'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('question-choice-Yes, send it')),
    );
    await tester.pump();

    expect(repository.sentTexts.single.text, 'Yes, send it');
  });

  for (final turn in [
    NodTurnState.queued,
    NodTurnState.running,
    NodTurnState.waiting,
  ]) {
    testWidgets(
      'single composer control sends a follow-up during ${turn.name}',
      (tester) async {
        final repository = FakeNodRepository(
          state: ChatFixtures.state(turn: turn),
        );
        addTearDown(repository.dispose);
        await _pumpChat(tester, repository, settle: false);
        final stop = find.byKey(const Key('chat-stop'));
        final send = find.byKey(const Key('chat-send'));
        final composer = find.byKey(const Key('chat-composer'));
        expect(stop, findsOneWidget);
        expect(send, findsNothing);
        await tester.enterText(composer, 'Follow up');
        await tester.pump();
        expect(stop, findsNothing);
        expect(send, findsOneWidget);
        expect(tester.widget<IconButton>(send).onPressed, isNotNull);
        await tester.enterText(composer, '   ');
        await tester.pump();
        expect(stop, findsOneWidget);
        expect(send, findsNothing);
        await tester.enterText(composer, 'Follow up');
        await tester.pump();
        await tester.tap(send);
        await tester.pump();
        expect(repository.sentTexts.single.text, 'Follow up');
        expect(repository.stopCalls, 0);
        expect(stop, findsOneWidget);
        expect(send, findsNothing);
      },
    );
  }

  testWidgets('stops running work and renders the cancelled state', (
    tester,
  ) async {
    final repository = FakeNodRepository(
      state: ChatFixtures.state(turn: NodTurnState.running),
    );
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository, settle: false);

    expect(find.byKey(const Key('chat-stop')), findsOneWidget);

    await tester.tap(find.byKey(const Key('chat-stop')));
    await tester.pumpAndSettle();

    expect(repository.stopCalls, 1);
    expect(find.byKey(const Key('chat-stop')), findsNothing);
    expect(find.byKey(const Key('chat-send')), findsOneWidget);
    expect(find.byKey(const Key('chat-working-activity')), findsNothing);
    expect(find.text('Stopped'), findsNothing);
  });

  testWidgets(
    'only active turns show agent activity, not idle or waiting states',
    (tester) async {
      final repository = FakeNodRepository();
      addTearDown(repository.dispose);
      await _pumpChat(tester, repository);
      repository.emitConnection(
        const NodConnectionState(phase: NodConnectionPhase.connected),
      );
      for (final state in NodTurnState.values) {
        repository.emitEvent(NodActivityEvent(state));
        await tester.pump();
        final working =
            state == NodTurnState.queued || state == NodTurnState.running;
        expect(
          find.byKey(const Key('chat-wave-progress')),
          working ? findsOneWidget : findsNothing,
        );
        expect(find.byKey(const Key('chat-turn-status')), findsNothing);
      }
      expect(find.text('Waiting for you'), findsNothing);
      expect(find.text('Done'), findsNothing);
      expect(find.text('Stopped'), findsNothing);
    },
  );

  testWidgets(
    'wave progress animates above composer and disappears when waiting',
    (tester) async {
      final repository = FakeNodRepository();
      addTearDown(repository.dispose);
      await _pumpChat(tester, repository);
      repository.emitConnection(
        const NodConnectionState(phase: NodConnectionPhase.connected),
      );
      repository.emitEvent(const NodActivityEvent(NodTurnState.running));
      await tester.pump();
      expect(find.byType(NodPresence), findsNothing);
      expect(find.byKey(const Key('chat-working-activity')), findsNothing);
      expect(
        tester.getBottomLeft(find.byKey(const Key('chat-wave-progress'))).dy,
        lessThan(tester.getTopLeft(find.byKey(const Key('chat-composer'))).dy),
      );
      await tester.pump(const Duration(milliseconds: 150));
      expect(tester.binding.hasScheduledFrame, isTrue);
      repository.emitEvent(const NodActivityEvent(NodTurnState.waiting));
      await tester.pumpAndSettle();
      expect(find.byType(NodPresence), findsNothing);
      expect(find.byKey(const Key('chat-working-activity')), findsNothing);
    },
  );

  testWidgets(
    'connection issues remain visible without passive turn notifications',
    (tester) async {
      final repository = FakeNodRepository();
      addTearDown(repository.dispose);
      await _pumpChat(tester, repository);
      repository.emitConnection(
        const NodConnectionState(phase: NodConnectionPhase.reconnecting),
      );
      await tester.pump();
      expect(
        tester.widget<NodPresence>(find.byType(NodPresence)).state,
        NodMotionState.connecting,
      );
      repository.emitConnection(
        const NodConnectionState(phase: NodConnectionPhase.connected),
      );
      await tester.pumpAndSettle();
      expect(find.byType(NodPresence), findsNothing);
      repository.emitConnection(
        const NodConnectionState(phase: NodConnectionPhase.offline),
      );
      await tester.pump();
      expect(
        tester.widget<NodPresence>(find.byType(NodPresence)).state,
        NodMotionState.offline,
      );
    },
  );

  testWidgets('shows reconnecting, offline, unauthorized and reset states', (
    tester,
  ) async {
    final reconnectingRepository = FakeNodRepository();
    addTearDown(reconnectingRepository.dispose);
    await _pumpChat(tester, reconnectingRepository);

    reconnectingRepository.emitConnection(
      const NodConnectionState(phase: NodConnectionPhase.reconnecting),
    );
    await tester.pump();
    expect(find.text('Reconnecting'), findsOneWidget);

    reconnectingRepository.emitConnection(
      const NodConnectionState(phase: NodConnectionPhase.offline),
    );
    await tester.pump();
    expect(find.byKey(const Key('chat-failure-offline')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();

    final unauthorizedRepository = FakeNodRepository()
      ..queueLoadError(
        const ChatRepositoryException(ChatFailureKind.unauthorized),
      );
    addTearDown(unauthorizedRepository.dispose);
    await _pumpChat(tester, unauthorizedRepository);
    expect(find.byKey(const Key('chat-failure-unauthorized')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();

    final resetRepository = FakeNodRepository(history: ChatFixtures.history)
      ..queueLoadError(
        const ChatRepositoryException(ChatFailureKind.conversationReset),
      );
    addTearDown(resetRepository.dispose);
    await _pumpChat(tester, resetRepository);
    expect(
      find.byKey(const Key('chat-failure-conversationReset')),
      findsOneWidget,
    );
    expect(find.text('Summarize the project update.'), findsNothing);
  });

  testWidgets('desktop Enter sends while the composer keeps multiline input', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository, autofocus: true);

    await tester.enterText(
      find.byKey(const Key('chat-composer')),
      'First line',
    );
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();

    expect(repository.sentTexts, isEmpty);

    await tester.enterText(
      find.byKey(const Key('chat-composer')),
      'First line\nSecond line',
    );
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    expect(repository.sentTexts.single.text, 'First line\nSecond line');
  });

  testWidgets('approval stays usable at high text scale on compact screens', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final semantics = tester.ensureSemantics();
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);
    await _pumpChat(
      tester,
      repository,
      textScale: 2,
      disableAnimations: true,
      darkMode: true,
    );

    repository.emitQuestion(ChatFixtures.approvalQuestion);
    await tester.pumpAndSettle();

    expect(find.text('Nod needs your approval'), findsOneWidget);
    expect(tester.takeException(), isNull);
    for (final entry in <String, String>{
      'Yes, send it': 'Approve',
      'No, do not send it': 'Decline',
    }.entries) {
      final action = find.byKey(ValueKey('question-choice-${entry.key}'));
      expect(tester.getSize(action).height, greaterThanOrEqualTo(48));
      expect(tester.getSemantics(action).label, entry.value);
    }
    expect(tester.binding.hasScheduledFrame, isFalse);
    semantics.dispose();
  });

  testWidgets('approval announces the decision and keeps safer action first', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final repository = FakeNodRepository(history: ChatFixtures.history);
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository);

    repository.emitQuestion(ChatFixtures.approvalQuestion);
    await tester.pump();

    final question = find.byKey(const Key('chat-question-question-approval'));
    expect(
      tester.getSemantics(question).label,
      contains('Nod needs your approval'),
    );
    expect(
      tester.getTopLeft(find.text('Decline')).dx,
      lessThan(tester.getTopLeft(find.text('Approve')).dx),
    );
    expect(find.text('Reply or choose an option above'), findsOneWidget);
    expect(
      tester
          .getSemantics(
            find.byKey(const ValueKey('question-choice-No, do not send it')),
          )
          .label,
      'Decline',
    );
    expect(
      tester
          .getSemantics(
            find.byKey(const ValueKey('question-choice-Yes, send it')),
          )
          .label,
      'Approve',
    );
    semantics.dispose();
  });

  testWidgets('reduced motion never hides arriving content', (tester) async {
    final repository = FakeNodRepository();
    addTearDown(repository.dispose);
    await _pumpChat(tester, repository, disableAnimations: true);

    repository.emitConnection(
      const NodConnectionState(phase: NodConnectionPhase.connecting),
    );
    await tester.pumpAndSettle();
    expect(
      tester.widget<NodPresence>(find.byType(NodPresence)).state,
      NodMotionState.connecting,
    );
    expect(tester.binding.hasScheduledFrame, isFalse);

    repository.emitConnection(
      const NodConnectionState(phase: NodConnectionPhase.connected),
    );
    repository.emitEvent(const NodActivityEvent(NodTurnState.running));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('chat-wave-progress')), findsOneWidget);
    expect(tester.binding.hasScheduledFrame, isFalse);

    repository.emitEvent(
      NodMessageEvent(
        ChatFixtures.assistantMessage(
          id: 'reduced-motion',
          text: 'Visible immediately.',
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Visible immediately.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

Future<void> _pumpChat(
  WidgetTester tester,
  FakeNodRepository repository, {
  bool autofocus = false,
  String? focusMessageId,
  bool disableAnimations = false,
  double textScale = 1,
  bool darkMode = false,
  bool settle = true,
  PageStorageBucket? storageBucket,
  Future<List<NodUploadFile>> Function()? pickAttachments,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: darkMode ? NodTheme.dark : NodTheme.light,
      builder: (context, child) {
        final media = MediaQuery.of(context);
        return MediaQuery(
          data: media.copyWith(
            disableAnimations: disableAnimations,
            textScaler: TextScaler.linear(textScale),
          ),
          child: child!,
        );
      },
      home: Scaffold(
        body: PageStorage(
          bucket: storageBucket ?? PageStorageBucket(),
          child: NodChat(
            repository: repository,
            autofocus: autofocus,
            focusMessageId: focusMessageId,
            pickAttachments: pickAttachments,
          ),
        ),
      ),
    ),
  );
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
  }
}

class _PrivateLinkRepository
    implements
        NodRepository,
        NodApiTransport,
        NodMessageFocusRepository,
        NodPrivateBrowserTransport {
  _PrivateLinkRepository(this.backend);
  final FakeNodRepository backend;
  final List<String> reads = [];
  List<NodMessage> contextMessages = const [];
  final List<String> browserTurns = [];
  @override
  Future<List<NodMessage>> loadMessageContext(String messageId) async =>
      contextMessages.where((message) => message.id == messageId).toList();
  @override
  Stream<List<int>> browserHandoffFrames(String turnId) {
    browserTurns.add(turnId);
    return const Stream.empty();
  }

  @override
  Stream<NodConnectionState> get connectionStates => backend.connectionStates;
  @override
  Stream<NodEvent> get events => backend.events;
  @override
  Future<void> connect(NodConnectionConfig config) => backend.connect(config);
  @override
  Future<void> disconnect() => backend.disconnect();
  @override
  Future<NodState> loadState() => backend.loadState();
  @override
  Future<NodHistory> loadHistory({String? cursor}) =>
      backend.loadHistory(cursor: cursor);
  @override
  Future<void> sendText(String text, {required String clientMessageId}) =>
      backend.sendText(text, clientMessageId: clientMessageId);
  @override
  Future<void> stop() => backend.stop();
  @override
  Future<Object?> requestJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    reads.add(path);
    if (path == '/api/state') {
      return {'messages': <Object?>[], 'turns': <Object?>[]};
    }
    throw const NodRequestException();
  }
}
