# Chat unread count

## UNREAD-01.v1 — durable, owner-scoped read position

Source task: show the new-message count beside Chat; keep it after reopening Otto, and clear it only when the focused conversation reaches its latest committed reply.

Setup: actual cursor functions and React hook, JSDOM, synthetic messages and delayed native storage responses. No model, connected account, normal profile, or OS notification is used. Run one deterministic repetition with Node 24.21.0 or later; each gate has a ten-second test budget. Initial history establishes a baseline. Cursor storage contains only timestamps and message IDs.

| Check     | Applies when                       | Pass condition                                                                                                                        | Evidence                                                     |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| UNREAD-C1 | Initial history and later replies  | Initial messages are read; only new committed assistant replies count, including timestamp ties, without duplicate increments.        | Cursor and hook assertions.                                  |
| UNREAD-C2 | Owner changes or thread resets     | Delayed loads and callbacks cannot inherit, overwrite, or clear another scope's cursor.                                               | Actual React hook with delayed bridge reads.                 |
| UNREAD-C3 | The cursor predates loaded history | Pagination reaches the read boundary or the 100-message display cap; an abort cannot advance another thread.                          | Paginated history assertions.                                |
| UNREAD-C4 | Reading or writing storage fails   | The badge remains pending/unavailable without accepting an unpersisted cursor; focus/online retries retain the pending read position. | Injected storage errors and subsequent recovery in the hook. |
| UNREAD-C5 | A cursor is persisted              | Stored metadata contains no message text.                                                                                             | Browser/native writes inspected independently.               |

Every applicable check must pass. Measurement errors are not passes. History reconciliation has a 15-second request deadline and displays a lower bound while incomplete. Native focus, scroll, notification targeting, and OS banner acceptance remain in [U05](README.md#u05v1--message-notifications-and-unread-count).

## Hypothesis and original result

The original sidebar had no owner/thread-scoped cursor. A navigation-only clear would discard unread replies while Chat was unfocused or scrolled away. The implementation added a persistent cursor and fenced history loading. Review then found that failed native reads were treated as absent state; these now remain unknown and retry without overwriting storage.

## UNREAD-01.v2 — persistence failure gate

PR review on 2026-10-02 found that failed cursor writes were swallowed after the displayed count cleared. Version 2 adds the write-failure condition to UNREAD-C4. The general fix retains the pending cursor, serializes writes, advances the displayed read position only after persistence, and reports unavailable storage until retry succeeds. The existing primary regression was extended; it is a known regression, not an independent holdout.

Reproduce the synthetic cases from the checkout:

```sh
node --import tsx --test --test-name-pattern='chat (read|unread)' tests/channel-stream-isolation.test.ts
```

Attempt: 2026-10-02, base `df2bcca71b3a025ab10d529e7702dc123cc759a9` plus the PR review working-tree changes. The focused owner/reset/read/write recovery case passed under Node 26.7.0; its five-case invocation also passed the desktop OAuth access fence and restart-drain contract. The local log `.local/pr97-web-focused.log` is supplementary; the committed test is the reproducible source, and PR CI runs the complete file. No installed-app or live-provider claim follows from this run.

Evaluated source snapshot:

| File                                     | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `src/web/lib/chat-unread.ts`             | `54c13b42501d922f234d893682b96d5cbe9b149326066b2cf5b186639594fd81` |
| `src/web/hooks/use-chat-unread.ts`       | `ba1afe79ad544adcd625341ad8e676459aecc3cf7b07be67d32e4d3f27b4de00` |
| `tests/channel-stream-isolation.test.ts` | `b89c13cd4923d753ba3c87854963d894495db68b2a64c6b52ab66f020ac2d104` |
