# Otto

Setup, use and how the system works are in the docs site, whose pages live in `docs/src/content/docs` (start with [architecture](docs/src/content/docs/how-it-works/architecture.mdx) and [Trust and Vault](docs/src/content/docs/trust/index.mdx)). Development and checks are in [CONTRIBUTING](CONTRIBUTING.md).

## Rules

- Do not push, deploy or publish without explicit authorization.
- Keep keys, credentials and private user content out of Git, logs, prompts, test fixtures and client configuration. No tool returns a saved password, code or card to Pi.
- No code comments or JSDoc.
- Prefer deleting to patching ceremony. Breaking changes are fine; keep the code small.
- Use synthetic data and disposable database schemas. Never reset the normal local database, and never call a live model, connected account or real recipient from a test.
- Documentation lives only in `docs/`. When setup, behaviour or a safety rule changes, update the matching page in the same change and follow [Write docs](docs/src/content/docs/contribute/write-docs.mdx). Package READMEs stay short pointers to the docs.

## Architecture

- One thread per owner: a persistent Pi session, a sandbox workspace and a browser computer, all keyed by the thread ID and shared by web, Telegram and WhatsApp.
- Every user message, schedule fire, event wake and resume is a turn. Conversation turns run one at a time on the thread's Pi session; schedule and event turns start when they fire, in parallel, each in its own Pi session. Every write from a turn goes through `withTurnLock`. Turns and tool calls are never retried automatically; Pi retries only a failed model request.
- The thread browser has one holder: the conversation, a background turn or the user. Others wait in order. The conversation keeps it while it waits for the user, so a browser handoff is never blocked by background work.
- Pi-native tools (read, bash, edit, write, find, ls) run inside the sandbox through `WorkspaceSession.exec`. The pinned Pi web extension runs in the server process with its process permissions.
- Provider keys never enter the sandbox or the browser. The Pi web extension, `create_audio` and apps run server-side.
- A connected CLI token reaches only a sealed install of the path's declared source, run as `otto-connected` with an environment built from scratch; nothing the sandbox user can write runs with a token.
- `src/server/composition.ts` is the only place that selects providers and runtime implementations. Capabilities are ports in `src/ports`; vendor SDKs stay in `src/providers`; product policy stays in `src/server`; `src/web` imports only web and shared code.
- Hosted mode: a gateway authenticates Google sessions and routes to one immutable-owner tenant runtime per user. Never change the owner per request.

## Safety invariants

- Trust check (`src/server/trust.ts`): one checker decides every connected app action before it runs, reads included. It is the owner's selected model at its lowest reasoning effort. It sees only the owner's recent messages and the message they answered (a first task the owner tapped is Otto's wording, so it never counts as their message), or for a scheduled run the instruction that created its schedule, plus the action's arguments as Otto sends them, never tool results; app requests over 32,768 characters are refused, so it always sees the whole request. Work Otto starts on its own (event turns) gives it no owner words. It runs reads, drafts and actions the owner's words ask for; anything else waits for the owned yes/no confirmation, and a failed check asks. In read-only and onboarding turns, anything it does not run is refused. No stored list of recipients or past confirmations skips the check. Every confirmation is bound to the exact action and arguments. Confirmed actions run once; interrupted ones become uncertain and are never re-run.
- App, browser, browser-flow, web and codemode results that the model receives directly, confirmed-action results and connected-app event data reach Pi inside one `untrusted_tool_result` block with a data-not-instructions notice; tags inside the content are neutralised. Errors reach Pi unwrapped. Calls made by codemode scripts stay raw. A tripwire matches every untrusted result, error or block Pi receives against a short list of injection patterns aimed at AI assistants; a hit labels the block and, until the owner's next message, makes sign-in wait for the owner and payments need the card's security code. It is a security tripwire, not page parsing, and never acts on the page.
- Vault and sign-in: `sign_in` never returns a saved value. Permission binds the current task, selected item and exact origin. A domain mention does not grant consent. The server claims a durable use before browser work. Pi selects the fields and submit control; the provider checks actual frame origins, enters and submits privately, then keeps the live page for Pi to inspect. Known secret values are removed from tool output and masked in screenshots. Native side-effect checks permit read-only JavaScript without a reload; a document changed by Pi JavaScript requires a reload before entry. All normal Pi tools work after submission. Failed entry keeps the observation lock until the filled document changes. Event, read-only and onboarding turns never sign in; a tripwire suspends use until the next owner message. Secure forms bind owner, turn, origin and expiry. Saved profiles require exact network destinations, including explicit extra origins for assets and redirects. A new task must pass checks for every used origin and item or start signed out. The server and destination website are trusted with submitted values; output redaction does not contain every transformation a website can make.
- Pi reads the page from the agent-browser snapshot and chooses login methods and fields. Do not add page-parsing scripts, snapshot regexes or field checks around the browser; leave the page to Pi, the model and agent-browser. Pi can run page JavaScript with browser evaluate. Tool output replaces known secret values. Keep site-specific cases in regression fixtures.
- Before choosing a login method, check saved account metadata. Reuse a uniquely applicable login; ask when several methods are available without a matching saved login, unless the user already chose. Ask when the matching account or method remains ambiguous.
- Payments: `pay` binds one request to the shop, checkout document, actual card-field origins, submit control, amount, currency and selected card revision. The owner approves in Otto web or desktop with a code or, after explicit card permission, yes. A chat-app task uses the desktop private form and resumes in its original channel. Private URLs and payment codes never pass through chat apps. The claim locks and reads the approved revision on an active turn. Code retention never restores revoked permission. The provider uses field-bound private entry and submission, then keeps the live page and removes known secret values from observations. A durable use never runs twice; interrupted work is uncertain. Activity records card submitted, not paid. `payment_setting` requires an owned confirmation for the exact card and setting. Hosted mode refuses PAN storage and payment use. Event and read-only turns never pay. Stored PAN use does not enforce settlement at the issuer or establish PCI compliance.
- Credential guard: the runtime withholds messages that ask the user for passwords, codes, card details or API keys and redirects the model to `sign_in` or `pay`.
- Memory learning reads only the owner's own user messages (short, no attachments, none with a memory-save approval), never assistant text or tool results; web content reaches it only if the user pasted it. Learned entries stay tentative until a second message repeats them, the model never writes consolidated entry text, and automatic changes archive active entries instead of deleting them. The archive itself is bounded, and only a user-requested forget deletes. Sensitive topics (health, religion, politics and similar) are learned only when the owner turns them on or explicitly asks. One exception: when Gmail connects, a background job reads the owner's own text from recent sent emails (quoted, forwarded and automated mail removed) and saves only their writing style, with no facts, names or quotes, as one capped `preferences` entry labelled "Learned from your sent email" that replaces its earlier version by archiving it.
- Owner and tenant isolation: every query and route is owner-scoped; tenants get their own SQL role and schemas and never receive control or auth credentials.
- Local access: loopback and Host are not identity, since containers reach host listeners. Every local `/api` request needs the owner key from `OTTO_DATA_ROOT/access-key` (a cookie set from the printed `#access=` link, or the desktop header); only verified webhooks, OAuth callbacks with one well-formed state, the key exchange and the privacy notice go without it. Never mount the data root or pass the key to a container or prompt.
- Internal gateway-to-tenant requests use signed HMAC envelopes binding owner, environment, generation, method, target, body, nonce and expiry. Keep replay and expiry checks.

## Model policy

- Pi still asks before a destructive connected app action that the current request does not clearly authorize. The trust check is the server floor beneath that instruction, not a replacement.
- Onboarding turns and activity checks must only read connected apps. The trust check refuses any app action it does not judge a read in these turns.
- The first-chat task cards are prepared without a turn from the owner's setup answers and, when Gmail is connected, one read of recent inbox subjects and snippets that drops tripwire matches and security mail; the owner's selected model sees that mail only as data, and its cards are validated or replaced by fixed ones. **Do it** sends exactly the visible card title as a normal owner message.

## Validation

Run focused tests while editing, then `pnpm run check`, `pnpm run test:integration` and `pnpm run build`. For capability eval changes also run `pnpm --dir evals run check` and `pnpm --dir evals test`. The evals themselves call live models, so run them manually (see [evals](docs/src/content/docs/contribute/evals.mdx)). For deployment changes also run `pnpm --dir deployment/cloudflare run check`, `pnpm --dir deployment/cloudflare test` and both Wrangler dry runs (see [Cloudflare](docs/src/content/docs/deploy/cloudflare.mdx)). For docs changes run `pnpm --dir docs build`, which fails on a broken link. Report fixtures, UI checks and live checks separately.

## Tests

Keep only tests that would catch a real regression in:

- the core harness (one thread and Pi session per owner, sequential turns, stop, interruption, reset, session rebase);
- sandbox isolation (nothing on the host, no keys in the sandbox, contained paths);
- safety (approvals, uncertain actions, Vault and sign-in fencing, credential guard, read-only turns, onboarding task cards);
- owner and tenant isolation (gateway, signed envelopes, owner scoping, URL guards, redaction);
- real integration contracts (channel delivery, schedule firing, downloads, OAuth completion).

No tautological tests, mocks that return what they were told, or tests of UI copy, wording, CSS, constants or configuration. Extend the existing file for an area instead of adding one.
