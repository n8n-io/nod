# Nod

How Nod works is in the docs site, whose pages live in `docs/src/content/docs` (start with [architecture](docs/src/content/docs/how-it-works/architecture.mdx) and [Trust and Vault](docs/src/content/docs/trust/index.mdx)). Development and checks are in [CONTRIBUTING](CONTRIBUTING.md). This file holds only the rules every change follows.

## Rules

- Do not push, deploy or publish without explicit authorization.
- Keep keys, credentials and private user content out of Git, logs, prompts, test fixtures and client configuration.
- No code comments or JSDoc.
- Errors state what failed and keep the service's specific reason, status and useful details. Never replace a specific cause with a generic warning or infer a billing problem from a quota or rate limit. Remove secrets before an error is shown or stored.
- Redact diagnostic reports and the logs behind them before they leave the owner's runtime. Send bounded technical values (fixed choices, counts, versions, error classes, status codes) in place of names, identifiers, paths, URLs and message content, and test that a private value stays out. Redaction is best effort, so the owner reviews a report before it is sent.
- Prefer deleting to patching ceremony. Fix a class of problem once where it is shared, not one case at a time. Breaking changes are fine; keep the code small.
- Keep prototypes, internal research, plans, review notes and validation artifacts outside the repository.
- Use synthetic data and disposable database schemas. Never reset the normal local database, and never call a live model, connected account or real recipient from a test.
- Analytics follow [Change analytics](docs/src/content/docs/contribute/analytics.md): bounded values and no private content.
- Documentation lives only in `docs/`. When setup, behaviour or a safety rule changes, update the matching page in the same change and follow [Write docs](docs/src/content/docs/contribute/write-docs.mdx). Don't describe how features work in this file.
- Before opening a pull request for a feature a user can see, offer once to make a [feature video](docs/src/content/docs/contribute/feature-videos.md) with the `feature-video` skill. Make it only on a yes.
- Desktop releases follow [Desktop releases](docs/src/content/docs/contribute/desktop-releases.mdx), including its video and highlights steps. Preparing a release does not authorize a merge or publication.

## Architecture

- `src/server/composition.ts` is the only place that selects providers and runtime implementations, apart from the startup feedback exception in [architecture](docs/src/content/docs/how-it-works/architecture.mdx). Capabilities are ports in `src/ports`; vendor SDKs stay in `src/providers`; product policy stays in `src/server`; `src/web` imports only web and shared code.
- Every write from a turn goes through `withTurnLock` (fenced by a turn lease and monotonic `fence_token`), so a Stop or expired lease refuses it. Turns and tool calls are never retried automatically after any side effect, approval, or reply has started; a single bounded auto-retry is allowed only on provably read-only, pre-commit transient model/transport failures.
- `model_usage` is the only cost ledger. Keep execution IDs internal.

## Safety invariants

- One trust check (`src/server/trust.ts`) decides every app action, browser or computer step that can commit, sign-in or saved-session use and change to Nod's own settings before it runs. A non-read action runs only when the owner's words, schedule instruction, notification rule or rules cover it; otherwise the owner is asked. In scheduled and background work, a check that fails refuses the action instead. Pi doesn't ask first, and no stored list or past approval skips the check. See [Approvals](docs/src/content/docs/trust/approvals.mdx).
- A confirmation is bound to its exact action and arguments. A confirmed action runs once; a failed or interrupted one is uncertain and never re-run.
- App, browser, web and event content reaches Pi as untrusted data and never counts as owner words. See [Untrusted content](docs/src/content/docs/trust/untrusted-content.md).
- No tool returns a saved password, code or card to Pi, and Pi never asks for one in chat. See [Vault](docs/src/content/docs/trust/vault.mdx) and [Payments](docs/src/content/docs/trust/payments.mdx).
- Leave the page to Pi and agent-browser: no page-parsing scripts, snapshot regexes or field checks around the browser beyond the two server reads in [Sandbox and browser](docs/src/content/docs/how-it-works/sandbox-and-browser.md).
- Provider keys never enter the sandbox or the browser. The browser and web tools reach only public addresses. See [Sandbox and browser](docs/src/content/docs/how-it-works/sandbox-and-browser.md).
- [Local files](docs/src/content/docs/connect/local-files.md) and [computer use](docs/src/content/docs/connect/computer-use.md) run only in the desktop app and only in work the owner started.
- Pi never writes memory notes. See [Memory](docs/src/content/docs/how-it-works/memory.md).
- Every query and route is owner-scoped. Every local `/api` request needs the owner key, except those listed in [Security model](docs/src/content/docs/trust/security-model.md#client-access); never mount the data root or pass the key to a container or prompt.
- Artifact HTML renders only as `srcdoc` in a sandboxed iframe without same-origin, behind a no-network CSP, never in the app's DOM.
- [Conversation traces](docs/src/content/docs/trust/conversation-traces.md) leave only while the owner's switch is on.

## Validation

Run only the checks needed for the files and behaviour changed. Documentation and media changes need formatting, link and visual checks, not application lint, tests or builds. Build the docs site when its pages, configuration or code change.

For application changes, start with focused tests and run broader checks only when the change affects shared behaviour. For capability eval changes, run `pnpm --dir evals run check` and `pnpm --dir evals test`; the evals themselves call live models, so run them manually (see [evals](docs/src/content/docs/contribute/evals.mdx)). Report fixtures, UI checks and live checks separately.

## Tests

Keep only tests that would catch a real regression in:

- the core harness (one thread and Pi session per owner, sequential turns, stop, interruption, reset, session rebase);
- sandbox isolation (nothing on the host, no keys in the sandbox, contained paths);
- safety (approvals, uncertain actions, Vault and sign-in fencing, onboarding task cards);
- owner isolation (owner scoping, local access, URL guards, redaction);
- real integration contracts (channel delivery, schedule firing, downloads, OAuth completion).

No tautological tests, mocks that return what they were told, or tests of UI copy, wording, CSS, constants or configuration. Extend the existing file for an area instead of adding one.
