# Otto backlog analysis, 7 October 2026

The project has 10 issues in Backlog. All 10 were reviewed with their full descriptions, comments and available diagnostic reports. The other 11 active project issues are marked Done and are outside this review.

The original checkout was at `33d3997`, 28 commits behind main. The changes and final code review use `ebf608b9203ada7c9e4e7d28ecb5e5e18a085b1c`, the current remote main when checked. The changes are on `fix/backlog-easy-wins` in a separate worktree. The original checkout was restored to its previous state.

Reports describe version 0.1.5 or a development checkout. Current main is desktop 0.1.7. A report can prove a past failure without proving that the failure remains in the current release. Saved tool outputs can be shortened; a successful search does not prove that all messages were read. No private report content is copied into this document or the regression cases.

| Issue                                           | Assessment                                                        | Impact                                              | Decision                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| [LAB-469](https://linear.app/n8n/issue/LAB-469) | Confirmed missed check before a reply suggestion                  | Medium: false work and reduced trust                | Add a specific thread check and an eval case                              |
| [LAB-458](https://linear.app/n8n/issue/LAB-458) | Confirmed browser handoff display defect                          | Medium: sign-in cannot continue through chat        | Fix the message selection and test it                                     |
| [LAB-473](https://linear.app/n8n/issue/LAB-473) | Confirmed attachment failures; schedule cancellation is not shown | High: an authorized email could not be sent         | Fix the related handoff display; keep file staging as separate work       |
| [LAB-474](https://linear.app/n8n/issue/LAB-474) | OAuth audience configuration, according to the issue comment      | High for the blocked users                          | Add the intended users in the OAuth console; no source fix is established |
| [LAB-459](https://linear.app/n8n/issue/LAB-459) | Plausible past failure; current code has two relevant fixes       | High if sign-in still fails                         | Check with the current release before another code change                 |
| [LAB-471](https://linear.app/n8n/issue/LAB-471) | Confirmed progress messages with unnecessary technical detail     | Low: clarity problem; no secret disclosure is shown | Improve the reply guidance and add an eval                                |
| [LAB-476](https://linear.app/n8n/issue/LAB-476) | Browser session was saved; Vault has a different purpose          | Low: unclear product behaviour                      | Explain the difference; do not invent or copy credentials                 |
| [LAB-475](https://linear.app/n8n/issue/LAB-475) | Valid feature request, partly covered by current task tracking    | Medium: work is difficult to find                   | Separate schedule navigation from short-task history                      |
| [LAB-470](https://linear.app/n8n/issue/LAB-470) | Valid gap in remote browser interaction                           | Low: the screen looks like a static image           | Keep for a browser protocol change                                        |
| [LAB-472](https://linear.app/n8n/issue/LAB-472) | Valid feature request with four separate parts                    | Low: feedback takes more effort                     | Separate paste support, layout, capture and dictation                     |

## LAB-469: why Otto suggested an answered request

This is a confirmed reasoning failure. All times below are Europe/Madrid on 6 October.

1. At 16:37, Otto searched Slack mentions and suggested that a request needed the owner's reply.
2. No thread-read call or search of the owner's replies occurred before that suggestion.
3. At 16:46, the owner asked which channel contained the request. Otto offered a reply again, without a new read.
4. At 16:47, the owner said the request was already answered. Otto then searched the owner's messages in that channel.
5. The result contained two owner replies in the same original thread, at 09:38 and 14:58. Both preceded the suggestion. Otto acknowledged the missed replies.

The tool access worked. The request was not newly answered after Otto's check. Otto used mention search as evidence of an open task. Search selects matching messages; it does not establish the current state of their threads.

The [Connected apps guide](../src/runtime/skills/connected-apps/SKILL.md) previously required context reads in general terms. It did not explicitly require a check of the owner's replies before a suggestion. The new instruction requires current thread context, replies, reactions and later messages. If a thread tool is unavailable, other read tools must verify current replies and reactions in the original thread. A search of only the owner's messages is incomplete because another person or a reaction can resolve the request. Failed or partial reads, or unverified reply or reaction state, must not become claims that a request is unanswered.

The existing [Slack catch-up eval](../evals/src/scenarios/slack-catchup.ts) now includes an explicit request already approved by the owner inside its thread. The expected outcome still contains only the two open requests. The data is synthetic. The live model passed all three attempts on main and on the final branch. This checks that the model excludes the answered request in this case. It does not prove that the instruction improved this model or that every model will follow it.

## LAB-458 and LAB-473: browser handoff and attachment failures

LAB-458 includes successful `browser_session connect` and `ask_user` calls with a browser link. Later schedule messages appear while the user turn remains waiting. LAB-473 shows the same pattern: a sign-in question was followed by a schedule approval message, and the owner later reported that the browser would not open.

In [chat.tsx](../src/web/pages/chat.tsx), the handoff callback was assigned only to the final visible assistant message. A later background message removed the callback from the earlier browser question. [message.tsx](../src/web/components/message.tsx) renders the browser control only when that callback is present. Thus the browser control could disappear even though the foreground turn still waited for the user.

The change selects the last assistant message of the latest visible foreground turn while that turn is waiting. A background message does not replace that selection. A new foreground turn removes it. Existing server checks still refuse browser control when the owned turn is not waiting on a question or when work is running.

The new case in [browser.test.ts](../tests/browser.test.ts) reproduced the defect before the change. After the change, it checks that a later schedule approval preserves the same browser control, a click is delivered once, and a new foreground turn removes the control. Existing continuation, input-failure and stale-frame cases also pass. This proves the display defect and its fix with fixtures; the reported websites were not revisited.

LAB-473 also has an independent file-transfer problem. Three Gmail send attempts used workspace file references or a PDF URL as attachment storage keys. Composio returned missing-file errors from its own storage. Later Drive uploads also failed. The current [Composio adapter](../src/providers/composio/integrations.ts) disables host file uploads with `fileUploadDirs: false` and does not stage workspace files for an app upload.

This does not show that Gmail cannot send attachments. It shows that these files did not reach the storage the send action expected. A complete fix needs an explicit server path from an owned workspace file to provider staging, with size limits and no host-directory access. It must preserve the exact approved recipients and file bytes. That change is larger than a small backlog fix.

The report shows the email turn as waiting, not cancelled. The schedule message therefore does not prove that a schedule cancelled the email. It did expose the handoff display defect. Keep the attachment issue open after this display fix.

## Sign-in and saved data

**LAB-474.** The issue comment identifies the Google OAuth application as restricted to test users and asks its owner to add the intended email addresses. The diagnostic report has no failed connection call, so it cannot independently establish that cause. There is no evidence of an Otto policy that excludes personal Gmail. The next action is an OAuth audience change followed by a sign-in check by the affected user. A source change would not remove the provider restriction.

**LAB-459.** OAuth consent and usable model access are separate steps. A consent email does not prove that callback handling, token exchange or model loading succeeded. [LAB-468](https://linear.app/n8n/issue/LAB-468) describes a concurrent callback defect already marked Done. Current [models.ts](../src/server/models.ts) waits for the same callback completion and also saves a connection before model loading. A model-catalog failure can now leave the account connected with a refresh instruction. These changes address two plausible causes of the old report. There is no diagnostic trace for LAB-459 that identifies its exact cause. Ask the reporter to check the current release and retain a new masked report if it fails. Do not close it solely because a similar issue was fixed.

**LAB-476.** The associated reports show a successful browser session save after sign-in. [Browser connections](../src/server/browser-connections.ts) retain the browser profile and expose it in Apps. [Vault](../src/web/pages/vault.tsx) lists saved logins and payment cards. A Google sign-in completed by the user in the browser does not create a password entry for the target website. No saved credential is shown as lost. The valid need is to make the saved session and its location clear. Do not fabricate a target-site password or move Google credentials to another origin.

## Remaining product requests

**LAB-471.** The report contains routine progress about a page requiring JavaScript and a missing saved login. These are unnecessary details for some users, but a sign-in requirement can be useful when it explains the next action. No key, password or protected internal data disclosure is established. The existing personality already refused raw tool errors. The added instruction in [personality.ts](../src/runtime/personality.ts) requires the effect on the task and the next action, with a technical cause only when requested or needed to change a setting. The new [invoice sign-in eval](../evals/src/scenarios/invoice-signin-blocker.ts) requires a read of a synthetic billing page, a clear sign-in blocker and a next action. It checks every user-visible message for internal account or page-rendering details. The live model failed this wording check once on main and twice with the first instruction. The final instruction names the saved-login and saved-access checks that must stay out of routine replies. It passed all three final attempts.

**LAB-475.** Current [tasks.ts](../src/server/tasks.ts) creates progress cards for ongoing user work and closes automatic cards when the linked turn succeeds. [Tasks](../src/web/pages/tasks.tsx) has open and finished views. Thus the claim that single-thread work has no task history is too broad for current main. Short turns can finish before the watcher creates a card, event turns are excluded, and there is no historical reconstruction. A schedule tab is also absent. Split the request into schedule navigation and the intended coverage of short or past work. Neither is a demonstrated loss of stored tasks.

**LAB-470.** The handoff is a screenshot with forwarded input, not a local page. The current [input contract](../src/shared/browser-handoff.ts) supports clicks, scrolling, text and keys; it has no pointer movement or remote cursor state. The reported behaviour follows from that contract. A full fix needs remote pointer feedback and an interaction path that remains valid during browser control. A fixed pointer cursor over the whole image would falsely imply that every point is clickable. It would not meet the request.

**LAB-472.** The current [feedback form](../src/web/components/feedback.tsx) has multiple steps and explicit image-file selection. It has no image paste handler, automatic app screenshot, annotation or dictation. These are valid feature gaps, not failures of the existing attachment path. Paste support is the smallest separate change. Automatic capture needs a visible preview and removal control because the app can display private data. Annotation and dictation are separate features. The single-screen request needs a layout check at the desktop minimum size before a design change.

## Validation

- Focused browser fixtures: 7 passed, no failures or skips.
- Source checks: `npm run check` passed on current main with the changes.
- Eval package: `npm --prefix evals run check` and `npm --prefix evals test` passed; 27 harness tests passed.
- Full integration suite: `npm run test:integration` passed; 630 tests passed with no failures, cancellations or skips.
- Final build: `npm run build` passed.
- UI evidence: synthetic chat interaction through JSDOM. No native desktop or real website check was run.
- Manual model checks: the final runtime passed 6 of 6 attempts on synthetic apps and websites. No real connected account, recipient or reported website was used.

## Manual model comparison

The agent was `openai/gpt-6.1-sol`. The judge was `anthropic/claude-sonnet-5-5`. Each case had three attempts per version. Prompts, data and checks were fixed across the runs. No failed attempt was removed.

| Case                     | Main (`ebf608b`) | First instruction (`85b283c`) | Final instruction (`d22af53`) |
| ------------------------ | ---------------- | ----------------------------- | ----------------------------- |
| `slack-catchup`          | 3/3              | 3/3                           | 3/3                           |
| `invoice-signin-blocker` | 2/3              | 1/3                           | 3/3                           |

The wording failures were model failures: the page was read, but a routine reply reported internal saved-access information. The final run had no failed required or optional checks. These small samples do not establish a general success rate. Slack passed on main too, so the comparison does not establish an improvement for that case. The new invoice case remains opt in during calibration and can be run by name.

The case fingerprints were `97ae7da8eb3e` for Slack and `72fa97d7b990` for the invoice blocker. Results remain in the ignored `.local/capability-evals` directory under `backlog-2026-10-07-ebf608b9203ada7c9e4e7d28ecb5e5e18a085b1c`, `backlog-2026-10-07-85b283c` and `backlog-2026-10-07-final`.

To repeat the final cases:

```sh
npm run eval:capability -- run --scenario slack-catchup,invoice-signin-blocker --repeat 3 --model openai/gpt-6.1-sol --judge anthropic/claude-sonnet-5-5
```

The initial review changed no Linear status, priority, description or comment. No deployment was performed.
