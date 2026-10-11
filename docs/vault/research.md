# Engineering assessment

Assessment date: 10 October 2026. The shared server modules are small and retain the existing Pi harness. The review found five browser and account failures. The worktree now removes their shared assumptions: submission keeps the live page, fields can specify an expiry format, and a completed account choice does not bind the next account. This resolves the reproduced failures. It does not establish full performance parity.

## Engineering review, 10 October 2026

The initial review covered branch `vault-redesign` at `b9f5d733`, including the uncommitted worktree changes before the fixes below. It assessed code size, task completion and browser contracts. The findings in this table describe that initial state. Source links show the committed baseline. Git does not retain the uncommitted worktree that was assessed.

Five failures were reproduced with real Chrome and synthetic pages. The second-account case also used a separate temporary PostgreSQL instance. No case called a model or a real account.

| Priority | Failure                                                             | Task effect                                                                                                                                                | Source                                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Private entry reloads a page when submission does not navigate.     | An identifier form changed to a password form in page memory. The reload removed the password step.                                                        | [Private entry](https://github.com/n8n-io/otto/blob/b9f5d7335f681f8ea48ab18d39de5a70c6dc7622/src/providers/agent-browser/index.ts)                                                                                                                                            |
| P1       | Completion uses a fixed 500 ms wait and active network requests.    | A submit handler delayed its request by 1.2 seconds. The provider returned `submitted`, but the reload cancelled the timer. No request reached the server. | [Completion wait](https://github.com/n8n-io/otto/blob/b9f5d7335f681f8ea48ab18d39de5a70c6dc7622/src/providers/agent-browser/devtools.ts)                                                                                                                                       |
| P2       | Card expiry entry permits only fixed representations.               | A valid select with value `aug` and label `August` failed. Pi can select a field but cannot select its required representation.                            | [Card entry](https://github.com/n8n-io/otto/blob/b9f5d7335f681f8ea48ab18d39de5a70c6dc7622/src/providers/agent-browser/index.ts)                                                                                                                                               |
| P2       | A completed account selection remains bound to the task and origin. | One task could use the first saved account but could not use a second saved account on the same origin. The server required fresh credentials.             | [Account selection](https://github.com/n8n-io/otto/blob/b9f5d7335f681f8ea48ab18d39de5a70c6dc7622/src/server/vault.ts)                                                                                                                                                         |
| P2       | Every page script requires a reload before private entry.           | Reading `document.title` blocked sign-in. Cleanup then reloaded the page and removed a company field that Pi had already filled. No submission occurred.   | [Script tracking](https://github.com/n8n-io/otto/blob/b9f5d7335f681f8ea48ab18d39de5a70c6dc7622/src/providers/agent-browser/index.ts), [entry precondition](https://github.com/n8n-io/otto/blob/b9f5d7335f681f8ea48ab18d39de5a70c6dc7622/src/providers/agent-browser/index.ts) |

The first two cases have one design cause: completion requires a new document or state that survives a reload. A single-page application need not satisfy either condition. Increasing the timer or adding website exceptions would retain this failure.

Keep the small shared modules. `vault-crypto.ts` uses Node crypto. `vault-use.ts` claims, performs and completes one operation, with browser work outside the database transaction. The branch retains the turn queue, browser holder and saved profiles. No merchant-specific handler was found in the reviewed Vault paths. The saved-profile path reports blocked origins and lets Pi request access to them.

The custom DevTools module also implements input and selection beside agent-browser. Its `document.execCommand` path needs a specific reason and browser compatibility evidence. The W3C draft does not promise consistent implementation. This is a design concern, not another reproduced failure. Bounded waits for an explicit page state are established browser practice; network activity alone does not identify completion. See the primary sources below.

Required changes:

1. Define completion for the selected step without requiring a reload after every submission. Preserve a next step that exists only in page memory.
2. Let the selected field operation specify the required expiry representation. Reuse the existing browser driver where its contract is sufficient.
3. Bind repeat prevention to one operation. Keep a staged account choice separate from completed account use.
4. Preserve normal form preparation and page inspection across private entry. Do not clear completed fields when a precondition refuses entry.
5. Compare the same tasks on the base and candidate with the same models and fixtures. Measure completion, tool calls, time, cost and owner questions.

The review passed 196 focused database tests, 89 agent-guard and Pi tests, 45 eval-harness tests and three existing Chrome checks. Root check, eval check and build passed. The full Linux integration command could not run because the Docker daemon was unavailable. The five task probes failed their task-result assertions and established the limits above. No new owner UI check, real website check or live model evaluation was run. These results do not establish performance parity.

## Engineering fixes, 10 October 2026

- Delete the fixed completion wait and its network-request tracking. Private entry submits once and keeps the live page. Pi observes the result and waits for the state that the task requires.
- Keep precondition checks before the observation lock. A refused entry does not clear earlier form preparation. Chrome's native side-effect check permits harmless JavaScript reads; scripts that cannot pass that check still mark the document as changed.
- Let an expiry field specify a selector, format and optional locale. `Intl.DateTimeFormat` supplies month names. There are no merchant-specific cases or month-name tables.
- Record whether an account choice is an identifier stage or a completed password submission. Repeat prevention includes the selected account. A staged identifier stays bound to its account; a completed choice permits another saved account.
- Keep new empty browser profiles outside saved-account permission. The missing-card task exposed an anonymous checkout that could be closed on Continue. Saved-session reuse and private entry still use Vault checks.
- Keep expiry dates as card metadata. Global masking of a two-digit expiry year hid an unrelated receipt amount. Private entry still masks the card number, security code and cardholder.
- State the effect of access approval. It grants permission but does not enter a credential or open a saved session. A bank run mistook approval for sign-in and made an unnecessary browser handoff. The result and policy now state that Pi must call the requested tool after permission is granted.

Telegram and WhatsApp use the desktop private forms. Payment approval resumes the original channel. Missing cards use the existing empty Vault card form and an owner Continue message. No phone relay or new access service is required. Code storage remains an explicit setting; a first payment does not add a setting question.

Chat delivery keeps Otto's private URLs in the app. It checks the configured Otto origin and local app URLs before replacing an absolute link. A merchant invoice link with a `/payments` path remains usable. The previous path-only filter removed both kinds of link.

The desktop window rules accept private payment pages and exclude them from feedback screenshots. The file guide now requires each requested document and its location in the final reply. An earlier guide told Pi to omit names unless requested and could produce a count without the requested results.

The owner selected live-page retention so SPA tasks can continue. Known-value output replacement and screenshot masking remain. The destination website can retain and transform submitted values in page memory. The documents now state that limit.

Regression tests use real Chrome for SPA transitions, delayed requests, expiry formats, harmless reads, value masking and origin checks. Database tests cover both account choices and repeat prevention. A separate browser and database probe completed two saved-account submissions in one task. See [validation](migration.md#engineering-fix-results-10-october-2026) for the final check results.

The private input path uses the existing DevTools connection and an isolated JavaScript world in the same page. This world shares the website DOM. It checks the approved field and focus in the same operation that enters each value. The agent-browser command receives field selectors, not the secret. The real Chrome fixtures cover input events, processor frames, single and split OTP fields, and SPA state. This supports the shipped Chromium path; it does not establish portability to other browser engines.

## Deep test, 11 October 2026

The extended test found a payment form that remained open after a later owner message cancelled the purchase. Browser entry failed before any card reached the shop, but the server consumed the request and resumed the cancelled task with an uncertain result. The payment lookup and claim now share one current-task check. A later conversation request invalidates the old form, while approval resumes and separate background tasks remain valid. The regression checks concurrent submissions, a lost response, queued cancellation, approval resumes and background scope.

The native probe also found that a closed shadow root could hide the actual field from the private entry helper. A month entry could replace the card number, and image masking missed a visible value. Native inspector access now resolves the real field and masks values in closed roots. Field focus reads only the selected node's subtree. Image masking reads the full document to cover reflected values. A native pixel check and repeated Pi tasks cover the change.

A retained form also exposed a formatted card number in an image and separate code digits in a snapshot. Image masking now follows the identity of the selected private control. A native password display hides input values during snapshot capture and retains their references. The helper restores the original input type after capture. Public expiry fields remain visible. The real browser regression checks both privacy and continued control. Image capture uses native opacity properties and restores the prior style. It works with the fixture's strict content security policy and inline priority rules. Complete PAN matching also covers spaced text reflected outside the input. A mask failure stops observation before any snapshot.

Split code boxes inside closed components use an ordered list of references selected by Pi. Each character uses the existing private field path. The user still enters one code in one private form. The helper adds no field detector or automatic retry.

Automatic code pages exposed a duplicate submission from an implicit Enter key. Private entry now clicks only the control selected by Pi. An automatic page needs no submit selector. The container sender uses the same login and card schemas as the worker, so it cannot omit a supported submit selector through a copied field list. Native tests cross the full client, bridge, worker and browser.

A page transition could delay the opacity mask and expose private pixels. Image capture now disables the transition while it masks the selected nodes, then restores the visual and transition properties in order. The native regression checks immediate masking and full style restoration. There is no timed wait.

Native Chrome completed the full management and desktop payment flow through the real web app. See the [deep test record](deep-test.md) for the task matrix, repeated runs, query and browser measurements, and limits.

## Primary sources

| Source                                                                                      | Application to this design                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [OWASP: Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)      | Put permission outside the model. Bind approval to an exact action. Reduce authority without removing tools needed for the task.                 |
| [Chrome DevTools: Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)       | Frame trees, loader IDs and isolated contexts support document-bound entry. An isolated context still shares the DOM with the website.           |
| [Chrome DevTools: Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) | Execution contexts identify where private browser code runs. They do not stop the destination page from reading its own input.                   |
| [agent-browser: Wait](https://agent-browser.dev/commands#wait)                              | Prefer a selector, text, URL or JavaScript condition for the required page state. Use network-idle waiting only for pages known to become quiet. |
| [Playwright: Auto-waiting](https://playwright.dev/docs/actionability)                       | Use bounded checks for element state before an action. These checks do not by themselves establish submission completion.                        |
| [W3C: execCommand](https://w3c.github.io/editing/docs/execCommand/)                         | This incomplete draft does not establish consistent input behavior across browsers.                                                              |
| [PCI SSC FAQ 1280](https://www.pcisecuritystandards.org/faqs/1280/)                         | Code storage needs an explicit scope assessment. Consent does not establish PCI compliance.                                                      |

## What is strong

Permission uses the owner's request, not page content. Task and item binding prevents a grant for one account from authorizing another. Exact frame checks close the gap between the top page and the actual input. A durable use claim separates database state from browser effects and stops automatic replay. One encryption module keeps ciphertext rules consistent. Native WebAuthn is not disabled.

The private operation replaces a broad browser restriction with a short boundary: select, authorize, claim, enter, submit, inspect. Real Chrome tests exercise the boundary and confirm that ordinary tools return. Saved-session network scope extends to page scripts and redirects, with explicit extra origins for normal site dependencies.

## Security review, 10 October 2026

The review reproduced three payment failures before applying the fixes. It also corrected the transaction for card permission and activity. The existing test files cover all four cases.

| Failure                                                                                         | Fix                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Code retention could restore permission that the owner revoked during entry.                    | Retention checks current permission and the card revision under a row lock. Only an explicit setting action can enable permission. |
| A card replaced after approval could be entered under the old request.                          | The request binds a card revision. The claim transaction locks and reads that revision before browser work.                        |
| Stop left waiting turns active, so an accepted code could still claim a payment.                | Stop cancels waiting turns. The claim transaction requires an active source turn.                                                  |
| A permission change could commit before activity failed, or block with one database connection. | Permission and activity commit together on the same connection. Tests check one-connection use and rollback.                       |

These changes use the existing operation and permission paths. They add no page detectors or model tool restrictions. Stop can prevent an unclaimed action; it cannot reverse an action that has already started. See [validation results](migration.md#validation).

## What is not established

This is not a formal proof, a separate key process, issuer-enforced payment control or PCI certification. The review model can misread intent. A permitted website receives the submitted secret and can transform or disclose it. Browser clicks inside an authorized account retain normal agent authority.

These limits prevent an absolute claim that no secret can ever reach a model or that every site works without an owner handoff. A defensible product claim is: **Pi uses saved accounts through references. Otto authorizes and submits values in a private operation, then returns normal tools to Pi so it can complete the task.**

Hardware-backed keys, a separate key process and issuer-bound payment credentials could strengthen specific boundaries. Add them when there is a concrete deployment or payment provider contract. A speculative keeper protocol would add code without proving those guarantees.
