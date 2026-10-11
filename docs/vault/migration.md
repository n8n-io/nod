# Migration and validation

The redesign retains existing encrypted values and the current API shape for owner pages. Sign-in accepts an optional submit selector. Pi supplies it for a submit button and omits it for an automatic step. Payment requires a submit selector. Private entry has no implicit Enter action.

Startup adds durable use records and item-bound task grants. It removes conversation grants, which could keep authority from an earlier task. Existing standing grants remain explicit site permissions. Old payment activity changes from paid to card submitted. In-flight legacy payment requests become uncertain and cannot run again. Pending payment requests without a card revision are superseded; the owner must approve a new request.

A legacy encrypted Vault must prove the old key before startup writes a key check. A wrong key rolls back without poisoning the Vault. No startup step deletes unreadable items or legacy hosted cards.

## Validation

Regression tests cover owner and ciphertext binding, wrong-key recovery, concurrent account saves, secure forms, staged login, private email codes, split OTP fields, exact frame origins, once-only claims, payment consent and uncertain results. Payment tests also cover a replaced card, permission revoked during entry and Stop after a code was accepted but before the use was claimed. Permission and activity tests use a one-connection pool and check rollback on failure.

Real browser fixtures cover known-value reflections, agent-installed listeners, foreign frames, saved-profile network scope, full script and screenshot access after submission, native keyboard input, downloads and WebAuthn availability. They also cover SPA state, delayed requests, harmless JavaScript reads and caller-selected expiry formats.

Run focused tests during edits, then `pnpm run check`, `pnpm run test:integration` and `pnpm run build`. Integration uses synthetic websites and disposable PostgreSQL schemas. No test calls a live model, a connected account or a real recipient.

Capability evaluations that call models and checks against real websites must be run separately. Unit and integration fixtures do not establish success on every website.

## Earlier branch results, 10 October 2026

| Check                            | Result                             | Scope                                                              |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Integration tests                | 768 passed, none failed or skipped | Synthetic services and disposable databases                        |
| Eval-harness tests               | 45 passed, none failed or skipped  | Evaluation code, with no model calls                               |
| Selected payment evaluations     | 31 attempts passed                 | Real models, Pi and Chromium against synthetic merchants and banks |
| Root check, eval check and build | Passed                             | Types, architecture, images, formatting and build                  |

The payment cases cover card choice, code replies, owner refusal, removed permission, a processor frame, async submission, separate expiry fields, issuer refusal, page injection, bank verification, JPY, KWD and a bank transfer with simulated phone confirmation. Checks read the merchant's stored order and submitted fields. They check approval, order count and model-visible output. No approval bypass, duplicate order or secret leak was observed in these runs.

Local reports are under `.local/capability-evals/`:

- `vault-payment-final-20261010`: 22 of 22 attempts passed.
- `vault-payment-verification-20261010`: 4 of 4 attempts passed.
- `vault-payment-security-20261010`: the two bank-transfer attempts passed. Two earlier permission-case attempts failed a fixture check; later runs above used the corrected check.
- `vault-payment-claim-final-20261010`: 3 of 3 attempts passed after the cancelled-task claim fix.

The card cases remain pending calibration. These selected results are not a pass for the full capability suite. Both bank-statement attempts retrieved all four files; one failed the final reply check because it did not name the files and periods. No new native UI check or real merchant payment was run for this validation. No comparison establishes full performance parity. See [payment task instructions](../../evals/README.md#payment-tasks).

## Engineering fix results, 10 October 2026

The assessment used real Pi sessions and Chromium with synthetic websites, cards and accounts. Database schemas were disposable. The agent was `openai/gpt-6.1-sol`; the judge was `anthropic/claude-sonnet-5-5`. Each acceptance case ran three times with unchanged task prompts, fixtures and required checks. Local source snapshots did not change the branch or the Git index.

The first candidate batch passed 35 of 36 attempts. All 21 attempts for the seven selected private-entry cases passed: code entry, processor frames, SPA checkout, split expiry, declined payment, bank verification and two saved accounts on one SPA origin. All 12 cases passed at least once; 11 passed every repeat. The remaining bank attempt saved and verified all four PDFs but failed the final reply check. A core-prompt change alone still passed only two of three repeats. The file guide had conflicting instructions about names; removing that conflict passed all three next repeats. One of those runs made an unnecessary browser handoff after access approval. The grant result and sign-in policy now state that approval grants permission without entering a credential or opening a saved session. Earlier failures remain in the reports.

Separate runs passed all three code-payment repeats and all three named-month expiry repeats. After the expiry-masking fix, the final payment batch passed nine of nine attempts across code, named-month and SPA checkouts. One judge response omitted verdicts; the harness repeated that measurement, and it is not counted as a passed attempt. Pi selected the month representation from the page. Production code uses `Intl.DateTimeFormat`, with no merchant or month-name table. A real-browser regression also reproduced expiry metadata hiding an unrelated receipt amount and passed after expiry dates were removed from global secret masking. PAN, code and cardholder masking remain.

Manual Telegram-origin tasks passed three of three repeats with a saved card and three of three with a missing card. The missing-card task saved the card through the owner API and sent Continue. The private desktop payment endpoint then submitted once and resumed the original Telegram channel. Checks read the merchant state and every saved Pi message body; no PAN or code appeared. These are model and server-flow checks, not a live Telegram bot or a real card payment.

The final channel regression also keeps a merchant's `/payments` invoice link usable while withholding private relative links, local app links and links to the configured Otto origin. It uses the existing app-origin setting and adds no service or relay.

### Code and fixture checks

Root check, eval check and the final build passed. The final integration run after the access-result and channel-link changes passed all 773 checks.

| Check                        | Result                                         | Scope                                                                                       |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Root check                   | Passed                                         | Types, architecture, images and formatting                                                  |
| Linux integration            | 773 passed; none failed or skipped             | Real Chromium, synthetic services and disposable PostgreSQL schemas                         |
| Eval check and harness tests | Passed; 45 tests passed                        | Evaluation code, with no model calls                                                        |
| Desktop tests                | 130 passed, one platform-specific test skipped | Native window handlers, session isolation and desktop lifecycle                             |
| Private-entry regressions    | Passed                                         | SPA state, delayed submission, field formats, origins, masking and readable receipt amounts |

The first integration run after the metadata change failed an old assertion that required expiry text to be hidden. That assertion now requires readable expiry metadata and retains the PAN, code and cardholder checks. The independent receipt regression was unchanged and passed. The next full integration run passed all 773 checks.

### Task comparison

The base was `0380c678`; the first candidate was `f8effe20e3df565300b360856503ba092a1f0237`. Five shared cases ran three times on each source with the same models and fixtures. The base passed 12 of 15 raw verdicts. Its three second-factor attempts failed only a check for the new `sign_in` tool name; the base used the old tools and completed the task. After excluding only that implementation-name check, the base met all remaining required checks in 15 of 15 attempts. The raw failures are retained.

| Case                     | Median seconds, base / candidate | Mean tool calls, base / candidate | Mean agent USD, base / candidate | Owner questions, base / candidate |
| ------------------------ | -------------------------------- | --------------------------------- | -------------------------------- | --------------------------------- |
| Bank documents           | 123.6 / 96.6                     | 32.7 / 30.3                       | 0.152 / 0.141                    | 3 / 3                             |
| Login with second factor | 69.6 / 55.1                      | 17.7 / 14.7                       | 0.098 / 0.094                    | 0 / 0                             |
| Weekly metrics           | 54.4 / 46.0                      | 13.0 / 9.7                        | 0.088 / 0.080                    | 0 / 0                             |
| Saved account choice     | 55.9 / 34.7                      | 12.3 / 9.0                        | 0.079 / 0.071                    | 3 / 3                             |
| Tax-number login         | 44.3 / 24.6                      | 10.0 / 8.0                        | 0.069 / 0.066                    | 0 / 0                             |

Questions are totals across three attempts and exclude private inputs and required approvals. Costs exclude the judge. The first candidate bank row includes its failed final reply. The final access batch passed six of six attempts: three bank tasks and three account-choice tasks. No attempt used a browser handoff. The final bank median was 94.5 seconds, with 33.0 mean tool calls, USD 0.159 mean agent cost and three owner questions. The base bank run used 32.7 mean tool calls and USD 0.152, so the final cost was slightly higher. Final account choice had a median of 32.5 seconds, 9.3 mean tool calls, USD 0.072 mean cost and three owner questions.

The first candidate batch used fewer measured tool calls and no added owner questions in these selected tasks. The file-guide repeats passed three of three but averaged 36 tool calls and USD 0.183, with a median of 98.6 seconds and four owner questions. The extra handoff in one run shows why time, cost and questions must remain separate from task completion. Model variation and host load limit any time or cost comparison. They do not establish performance parity for all tasks.

### Evidence and limits

Local reports under `.local/capability-evals/` retain the source reference, model, checks, trace, result state, time and cost:

- `vault-acceptance-base-1010`: the shared base cases.
- `vault-acceptance-current-1010`: the first 36 candidate attempts.
- `vault-acceptance-desktop-final-1010`: three code-payment repeats after the simpler approval flow.
- `vault-acceptance-named-expiry-1010`: three named-month repeats.
- `vault-acceptance-bank-final-1010`: two passes and one incomplete final reply after the core-prompt change.
- `vault-acceptance-bank-guide-1010`: repeats after the file-guide correction, source `4999f6b99dcc1acfb62abbc50d7046c514a14ea5`.
- `vault-acceptance-release-1010`: final payment repeats after the expiry-masking fix, source `28dde16f72836070eff5d8fd6f0aad7bef7834de`.
- `vault-acceptance-access-final-1010`: bank and account-choice repeats after the access-result fix, source `7cbc66df9cdd102e112086e07d21a01d1a02c168`.

Native Chrome UI use saved a synthetic login, and the owner API confirmed it. DOM tests with the real owner API checked private input clearing, submission and return to chat. Desktop tests called the real window handlers to check payment routing, the owner session partition and private screenshot exclusion. The UI tool later returned no page state, so no complete native visual payment check is claimed.

A separate health-PDF task retrieved, delivered and described its document. Its raw case failed the required reminder-timing check because Otto scheduled a seven-day plan check instead of a later repeat-test reminder. This is retained as a failure outside the Vault flow; it is not counted as a passing case.

No live connected account, real merchant payment or live chat-app recipient was used. The destination website receives submitted values and can transform them. Literal-value masking does not prove containment of every transformation. These checks support the selected task contracts, not a claim that every website or task is flawless.

## Deep test, 11 October 2026

The extended test continues in the [deep test record](deep-test.md). It uses frozen repeated tasks, native browser privacy checks, the real web app, desktop private forms and the Telegram and WhatsApp server paths. Each production source has its own result. The record retains failed browser, model, judge and fixture measurements. It also reports the measured cost and the limits of live-page masking.
