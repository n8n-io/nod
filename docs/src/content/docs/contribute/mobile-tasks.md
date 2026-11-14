---
title: Evaluate mobile tasks and prepared work
description: Check saved task controls, addressed replies, and source-bound prepared results in the Flutter evaluation client.
---

The Flutter evaluation client has API-backed pages for saved tasks and prepared findings. Use the server from the same evaluation branch.

## Track a task

Open **Tasks**, then select a task. Its details show the saved status, current step, result, completion condition, waits, and activity. Task lists and details refresh every 15 seconds while the app is in the foreground. Returning to the app also refreshes them.

- Select **Rename** to change the display title without changing the goal.
- Select **Stop this task** to stop only that task. Other sessions keep running.
- Select **Reply to task** to answer its saved question or add an update.
- Select **Continue task** on finished or stopped work to continue its saved session.

A reply uses the question's message ID when available, otherwise the task's first message ID. It includes the conversation ID captured when the reply panel opens. The server selects the session, checks the reply target, and applies approvals. The client never sends a session ID or treats a button as permission.

The reply panel sends once. If delivery can't be confirmed, check chat before sending another reply. Stop and rename failures show an error and block further changes until a successful refresh. Refresh never repeats a write.

Private sign-in, verification, payment, browser handoff, structured answer choices, and attachment controls belong to chat. Don't enter passwords, codes, or card details in a task reply. The task page can return to its original message through the app's chat navigation.

## Read prepared work

Open a finding's `/prepared/<id>` link to read the latest saved draft, unknowns, and sources. The prepared-work entry page lists links found in recent assistant messages, newest first. It isn't a complete index of older private work. Older results remain accessible from their original messages.

The server checks ownership and source-account bindings before returning a result. Removed or replaced accounts make old results unavailable. Refresh failures clear the displayed draft and sources rather than keeping a stale copy. Returning from the background checks availability again.

Selecting a source rechecks the result and requires the same source record, version, and URL before opening it. Only HTTPS links without embedded credentials open externally. Reading a result grants no permission to send, book, buy, or change an app.

## Schedule a finished task

Select **Schedule task** on a completed task. The server prepares a draft from your original requests, not the model's result. Review the name and instructions for future runs. The form warns when sensitive messages were omitted or attachments weren't carried over.

Choose **Daily**, **Weekdays**, **Weekly**, or **Monthly**, a run time, and an IANA time zone such as `Europe/Berlin`. Select **Create schedule**. Nod shows the saved schedule, its next run, and its server-projected monthly cost when available.

Creation sends once. If the response is lost, check **Scheduled** before starting another creation. The form doesn't silently resend.

## Review schedules

The existing **Scheduled** page keeps schedule editing, revision checks, pause, resume, deletion, monthly cost projections, and paginated run history. Schedule details also show saved baseline observations and whether the schedule watches connected accounts for changes. Editing other fields leaves those watches unchanged.

Watch-based skipping, overlapping-run prevention, and projected costs are server decisions. A subscription run or a run without complete pricing doesn't gain a client-estimated cost.

## Connect the pages

The page entry points take `NodApiTransport`, the shared authenticated, origin-bound JSON transport:

- `NodTasksPage(transport: transport, onShowMessage: openChatMessage)`
- `NodPreparedPage(transport: transport)` for recent findings
- `NodPreparedPage(transport: transport, issueId: id)` for a specific result

The app shell supplies navigation. `onShowMessage` must open chat and focus the supplied message, including when the task detail route is open. A prepared-result deep link must pass its ID after authentication, never a credential-bearing URL.

## Check the contracts

From `clients/flutter`, run:

```sh
flutter test test/features/tasks/tasks_page_test.dart test/features/prepared/prepared_page_test.dart test/features/scheduled/scheduled_page_test.dart --reporter expanded
```

The synthetic fixtures cover task continuation, conversation-reset refusal, rename, stop, duplicate-send suppression, uncertain writes, prepared-result navigation, removed sources, version changes, and foreground recovery. Existing schedule tests cover revision-safe management and history pagination.

These are in-process transport fixtures and widget checks, not a full registered-server or database isolation test. They don't prove live account access, approvals, native browser transport, physical-device behavior, or result-file downloads. Native and live checks are separate evaluation gates.

## Related resources

- [Flutter mobile evaluation](/contribute/mobile-evaluation/)
- [Track tasks](/use/tasks/)
- [Schedules and background work](/use/schedules/)
- [Proactivity engine](/how-it-works/proactivity/)
