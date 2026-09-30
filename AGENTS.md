# Otto

Setup and commands are in [README](README.md); how the system works is in [architecture](docs/architecture.md).

## Rules

- Do not push, deploy or publish without explicit authorization.
- Keep keys, credentials and private user content out of Git, logs, prompts, test fixtures and client configuration. The only prompt exception is `get_credential`, which can return one saved website login to Pi by owned ID and exact origin.
- No code comments or JSDoc.
- Prefer deleting to patching ceremony. Breaking changes are fine; keep the code small.
- Use synthetic data and disposable database schemas. Never reset the normal local database, and never call a live model, connected account or real recipient from a test.

## Architecture

- One thread per owner: a persistent Pi session, a sandbox workspace and a browser computer, all keyed by the thread ID and shared by web, Telegram and WhatsApp.
- Every user message, schedule fire, event wake and resume is a turn. Turns run one at a time; every write from a turn goes through `withTurnLock`. Nothing is retried automatically.
- Pi-native tools (read, bash, edit, write, find, ls) run inside the sandbox through `WorkspaceSession.exec`. The pinned Pi web extension runs in the server process with its process permissions.
- Provider keys never enter the sandbox or the browser. The Pi web extension, `create_audio` and apps run server-side.
- `src/server/composition.ts` is the only place that selects providers and runtime implementations. Capabilities are ports in `src/ports`; vendor SDKs stay in `src/providers`; product policy stays in `src/server`; `src/web` imports only web and shared code.
- Hosted mode: a gateway authenticates Google sessions and routes to one immutable-owner tenant runtime per user. Never change the owner per request.

## Safety invariants

- Approvals: unknown, destructive or ambiguous outside actions need an owned yes/no confirmation bound to the exact action, account and arguments. Confirmed actions run once; interrupted ones become uncertain and are never re-run.
- Vault and sign-in: `get_credential` can return one saved login to Pi by owned ID and exact origin. The value enters the Pi model context and saved session. Omit it from separate tool observations and user messages. New credentials go through secure forms and the trusted browser broker, bound to owner, turn, exact origin and expiry.
- Pi interprets website login methods and field roles from the current browser page. The broker validates selected elements and secure entry; do not gate login on site names or field-label dictionaries. Keep site-specific cases in regression fixtures.
- Before choosing a login method, check saved account metadata. Reuse a uniquely applicable login; ask when several methods are available without a matching saved login, unless the user already chose. Ask when the matching account or method remains ambiguous.
- Credential guard: the runtime withholds messages that ask the user for passwords, codes or API keys and redirects the model to `get_credential`.
- The onboarding welcome turn is read-only.
- Owner and tenant isolation: every query and route is owner-scoped; tenants get their own SQL role and schemas and never receive control or auth credentials.
- Internal gateway-to-tenant requests use signed HMAC envelopes binding owner, environment, generation, method, target, body, nonce and expiry. Keep replay and expiry checks.

## Validation

Run focused tests while editing, then `npm run check`, `npm run test:integration` and `npm run build`. For deployment changes also run `npm --prefix deployment/cloudflare run check`, `npm --prefix deployment/cloudflare test` and both Wrangler dry runs (see [Cloudflare](deployment/cloudflare/README.md)). Report fixtures, UI checks and live checks separately.

## Tests

Keep only tests that would catch a real regression in:

- the core harness (one thread and Pi session per owner, sequential turns, stop, interruption, reset, session rebase);
- sandbox isolation (nothing on the host, no keys in the sandbox, contained paths);
- safety (approvals, uncertain actions, Vault and sign-in fencing, credential guard, read-only welcome);
- owner and tenant isolation (gateway, signed envelopes, owner scoping, URL guards, redaction);
- real integration contracts (channel delivery, schedule firing, downloads, OAuth completion).

No tautological tests, mocks that return what they were told, or tests of UI copy, wording, CSS, constants or configuration. Extend the existing file for an area instead of adding one.
