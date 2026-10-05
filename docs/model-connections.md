# Model connections

Otto keeps one selected connection, model, and effort per owner. All channels use that choice. Pi reads it when a turn opens. A running turn keeps its original choice and uses the saved Pi transcript. A removed connection cannot supply credentials to a later request. Errors do not select another connection or repeat a request.

## Connection methods

| Service    | Methods                             | Default, when available |
| ---------- | ----------------------------------- | ----------------------- |
| OpenAI     | API key; ChatGPT plan in local Otto | GPT-6.1 Sol, high       |
| Anthropic  | API key                             | Claude Opus 5.5, high   |
| OpenRouter | API key; browser sign-in with PKCE  | GPT-6.1 Sol, high       |

Use **Models** in the account menu to add, refresh, reconnect, or remove connections. Use the model control above chat to search models and set effort. Each choice shows the service that receives the request. Adding a connection keeps an existing choice. If the requested default is unavailable, select a listed model.

OpenRouter checks the key through its authenticated [key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key), then lists models that support text and tools. Its catalog supplies context limits, image support, prices, and effort information. Pi supplies known protocol settings. New compatible entries use its OpenAI-compatible adapter. The request requires parameter support and disables provider fallbacks. Refresh a connection to update its catalog; a failed refresh keeps the last valid list. Direct OpenAI and Anthropic choices must also exist in the installed Pi catalog.

## Credentials

Saved credentials use the existing encrypted grant vault. The macOS key store uses Keychain. Other hosts need `OTTO_VAULT_KEY`, a base64 value for a 32-byte key. Credentials never enter the agent workspace or model context. The API returns safe metadata and model choices. The key form clears its value on submission and does not store it in browser storage.

Environment keys remain server-managed connections. They stay in server memory and are not copied into the database. `LLM_PROVIDER` and `LLM_MODEL` set the initial choice. The saved choice takes priority. Removing the selected saved connection clears the choice and requires another explicit selection.

Sign-in attempts have an owner, state, PKCE verifier, nonce, callback address, and ten-minute expiry. State is single-use. ChatGPT identity validation checks the signature, issuer, audience, expiry, nonce, subject, and plan-use permission. Otto retains the issued client registration and a stable host ID. Refresh, replacement, and removal use database locks. Token rotation saves the credential as one encrypted value. Error and Inspector redaction include current and replaced secret values.

## Subscriptions

ChatGPT uses the public Responses API with streaming and `store: false`. Requests keep the full history, use developer instructions, and put function tools in a namespace. Fields that the plan endpoint does not support are removed. Subscription costs show unavailable pricing. A listed model establishes catalog access; a completed request establishes inference access.

Local and open-source applications can use the documented flow with an eligible account and granted permission. Paid or hosted applications need separate access. Otto disables this connection method in hosted mode. See [OpenAI sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [inference requirements](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

Claude subscriptions cannot supply direct model tokens to Otto under [Anthropic's authentication conditions](https://code.claude.com/docs/en/legal-and-compliance). This release uses Anthropic API keys and OpenRouter for Claude models. It does not expose a Claude subscription connection.

A later Claude Code runtime must use an unmodified binary and keep sign-in inside that binary. It needs a private tool bridge, disabled host tools, turn-bound sandbox operations, and checks for stop, approvals, uncertain actions, restart, and session changes. That change must revise the current one-Pi-session architecture. The CLI flags alone do not prove those guarantees, so the connection must stay unavailable until these checks pass.

## Background work and voice

Memory and relevance use the selected connection. They select a smaller compatible model when present, or the selected model with its lowest supported effort. The Jev relevance option stays available through `TYPESAFE_API_KEY`. Voice uses the separate OpenAI key in server settings; a ChatGPT plan does not enable it.

## Validation

Provider contract tests use synthetic OAuth identities and HTTP streams. Storage tests use disposable PostgreSQL schemas. They cover identity rejection, state reuse, owner isolation, encrypted storage, concurrent refresh, removal, model changes with saved context, and one-attempt failures. No test signs in to a real account or calls a live model.

[The recorded UI demo](demos/model-connections.gif) uses synthetic accounts and keys. Real provider sign-in and first inference remain user-driven checks.
