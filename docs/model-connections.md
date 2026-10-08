# Model connections

Otto keeps one selected connection, model, and effort per owner. All channels use that choice. Pi reads it when a turn opens. A running turn keeps its original choice and uses the saved Pi transcript. A removed connection cannot supply credentials to a later request. Errors do not select another connection. Pi retries a model request that fails with a temporary provider error (overload, rate limit, server or network error) up to three times; turns and tool calls are never retried.

## Connection methods

| Service    | Methods                            | Default, when available |
| ---------- | ---------------------------------- | ----------------------- |
| OpenAI     | API key                            | GPT-6.1 Sol, high       |
| ChatGPT    | ChatGPT plan in local Otto         | GPT-6 Sol, high         |
| Anthropic  | API key                            | Claude Opus 5.5, high   |
| OpenRouter | API key; browser sign-in with PKCE | GPT-6.1 Sol, high       |

Onboarding shows model connections before the setup questions and app connections. Environment connections appear as connected services without exposing saved keys. A first ChatGPT connection selects GPT-6 Sol automatically when available, without opening the model picker. The model control lets the owner change the default before opening chat. Onboarding continues once a model is selected. An empty chat without a model shows one connection action in place of the message box.

Use **Models** in the account menu to add, refresh, reconnect, or remove connections. Connect all the services you want. The model control above chat shows one searchable list from all connected services and uses high effort where the model supports it. Each model shows the connection that receives the request. Choosing a model also chooses its connection. Adding a connection keeps an existing choice. For API connections whose default is unavailable, select a listed model.

OpenRouter checks the key through its authenticated [key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key), then lists models that support text and tools. Its catalog supplies context limits, image support, prices, and effort information. Pi supplies known protocol settings. New compatible entries use its OpenAI-compatible adapter. The request requires parameter support and disables provider fallbacks. Refresh a connection to update its catalog; a failed refresh keeps the last valid list. OpenAI and Anthropic choices must also exist in the installed Pi catalog. ChatGPT choices use the intersection of the account's Codex catalog and Pi's Codex models. If GPT-6 Sol is unavailable for a first ChatGPT connection, Otto uses its OpenAI default when offered, then the first supported model. Reconnecting or adding another account keeps an existing choice.

## Credentials

Saved credentials use the existing encrypted grant vault. The macOS key store uses Keychain. Other hosts need `OTTO_VAULT_KEY`, a base64 value for a 32-byte key. Credentials never enter the agent workspace or model context. The API returns safe metadata and model choices. The key form clears its value on submission and does not store it in browser storage.

ChatGPT account labels and avatar initials use an optional email from the existing sign-in token. This is display metadata only; account fencing still uses the account ID. Missing or malformed email leaves a generic account avatar with the ChatGPT badge and does not block sign-in.

Environment keys remain server-managed connections. They stay in server memory and are not copied into the database. `LLM_PROVIDER` and `LLM_MODEL` set the initial choice. The saved choice takes priority. Removing the selected saved connection clears the choice. A later ChatGPT connection selects its default if the owner has not chosen another model.

Sign-in attempts bind the owner, state, PKCE verifier, and callback address. The owner can check a pending attempt's status without receiving credentials. The desktop app opens the system browser; the web app opens a new tab. A manual callback form remains available. Completion consumes the attempt once; cancellation and expiry release its listener and pending work. Refresh, replacement, and removal use database locks. Token rotation saves the credential as one encrypted value. Error and Inspector redaction include current and replaced secret values.

Successful model sign-ins try to close their browser tab automatically. Browsers that prevent closing show an Otto page explaining that the tab can be closed. Error pages stay open with retry instructions. Callback pages remove authorization parameters from the address bar and load no external assets.

## Subscriptions

ChatGPT uses Pi's `openai-codex` provider for both OAuth and inference. Pi calls this its legacy Codex flow: a fixed public client, browser authorization with PKCE, and a loopback callback on port 1455. Otto reserves that callback listener before opening sign-in and passes validated callbacks to Pi's manual-completion interface. If another process holds the port, sign-in stops with an actionable error before opening OpenAI. Completion, cancellation, and failure release the listener. It does not dynamically register an Otto client. The matching transport sends streaming requests to `https://chatgpt.com/backend-api/codex/responses` with `store: false`. Pi formats the conversation and tools for that endpoint. Subscription costs show unavailable pricing.

Otto saves a successful login before loading its models. If that lookup fails, the connection remains saved and the owner can retry loading models. Temporary provider failures preserve the login; terminal credential failures require reconnecting. Connections saved through Otto's previous direct ChatGPT flow require one reconnect before using the Codex transport. Otto keeps ChatGPT sign-in available only in local mode. See [Pi's Codex provider](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/openai-codex.ts).

Claude subscriptions cannot supply direct model tokens to Otto under [Anthropic's authentication conditions](https://code.claude.com/docs/en/legal-and-compliance). This release uses Anthropic API keys and OpenRouter for Claude models. It does not expose a Claude subscription connection.

A later Claude Code runtime must use an unmodified binary and keep sign-in inside that binary. It needs a private tool bridge, disabled host tools, turn-bound sandbox operations, and checks for stop, approvals, uncertain actions, restart, and session changes. That change must revise the current one-Pi-session architecture. The CLI flags alone do not prove those guarantees, so the connection must stay unavailable until these checks pass.

## Background work and voice

Memory uses the selected connection. Relevance uses that connection unless `TYPESAFE_API_KEY` enables Jev. Work that uses a model selects a smaller compatible model when present, or the selected model with its lowest supported effort. Voice uses the separate OpenAI key in server settings; a ChatGPT plan does not enable it.

## Validation

Provider contract tests use synthetic credentials and HTTP streams. Storage tests use disposable PostgreSQL schemas. They cover callback validation, state reuse, cancellation, owner isolation, encrypted storage, concurrent refresh, recovery after catalog failures, removal, and model changes with saved context. No test signs in to a real account or calls a live model.

Fixtures establish the tested contracts. Live acceptance separately requires completing sign-in with the intended account and receiving a completed inference response; a successful model lookup alone does not establish inference access.
