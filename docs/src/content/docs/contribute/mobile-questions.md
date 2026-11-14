---
title: Answer questions in the Flutter client
description: Use server-backed answer choices and addressed replies in the evaluation Flutter client.
---

The evaluation Flutter client lets you answer a question in the session that asked it, including a background task or a spending check-in.

## Choose an answer

Choices appear below their original message, not just the latest question. Select an answer to send it. For a question that accepts several answers, select the checkboxes and then **Send selected answers**. Descriptions are included in the answer Nod receives.

Select **Write an answer** to address a typed answer to that question. This leaves your existing draft intact. A reply preview above the message box shows the target. Select **Cancel reply** to return to the main chat.

For approvals, spending check-ins and questions without choices, select **Reply** below the message and type your answer. The server interprets it and continues the session that asked. A reaction is not an answer or an approval. The client does not invent a yes/no decision or dispatch an app action itself.

Addressed replies currently support typed text. Clear the reply target before sending a voice message or an attachment. Private sign-in, verification and payment forms have a separate entry point supplied by the app shell; never enter passwords or card details in the message box.

## Open a task's question

The shell can pass a task's exact message ID to `NodChat.focusMessageId`. Chat loads that message's surrounding history through the server's owner-scoped message-context route, anchors the conversation at the target and sets up a reply without sending anything. Newer and older messages remain scrollable. Changing the target updates the reply; opening Chat without a target does not select one.

Read-only destinations can set `replyToFocusedMessage: false`. A removed message, a stopped focus request or a conversation reset cannot leave an old message selected as the reply target. If the target is unavailable, Chat says so instead of silently replying to another task. The shell's private-entry controls remain available alongside the target. This focus API does not make relative private-form links in Markdown open an external browser.

## Stop and reconnect

**Stop** clears local question controls and asks the server to stop active work. It cannot undo an action that already happened. A refresh replaces the list of questions still waiting for answers. Stopped or replaced choice questions no longer offer choices; the server also refuses a late choice or custom answer.

An uncertain send keeps its message ID for a manual retry of the same answer and target. There is no automatic retry of an answer. The server uses that ID to deduplicate an accepted message. Resetting the conversation clears reply targets, and new messages use the new thread. A reply already in flight retains its original thread so it cannot silently become an answer in the replacement conversation.

## Check the integration

From `clients/flutter`, run:

```sh
flutter pub get
flutter analyze lib/api/http_nod_repository.dart lib/core/nod_models.dart lib/features/chat test/api/http_nod_repository_test.dart
flutter test test/api/http_nod_repository_test.dart test/features/chat
```

The focused tests use synthetic HTTP fixtures. They cover canonical choice text and IDs, addressed approval and check-in replies, a lost receipt followed by a deduplicated manual retry, stale questions, reset state, and framed browser-handoff stream cancellation and malformed frames. They do not call a model, connected account or recipient. They do not prove native-device behavior or a live approval.

The authenticated browser stream uses a separate same-origin HTTP client. It delivers complete length-prefixed image frames, refuses empty or oversized frames and truncated streams, and closes on cancellation, disconnect, Stop or disposal. It sends no access token in its URL.

See [Try the Flutter client](/contribute/mobile-evaluation/) for pairing, native validation and the evaluation's remaining limits, and [Approvals](/trust/approvals/) for the server's authorization rules.
