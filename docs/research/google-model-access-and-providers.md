# Google account access and model providers

Researched on 2026-10-23 for [LAB-683](https://linear.app/n8n/issue/LAB-683/research-google-model-access-through-google-account-sign-in). This is a source audit, not a live account or model benchmark.

## Decision

Use Google Gemini through an AI Studio API key. A person can create that key with an existing Google account and use eligible models on the free tier. Ordinary Google sign-in does not give nod a supported consumer-subscription inference credential. Keep Vertex AI as the separate Google Cloud option. [Google key setup](https://ai.google.dev/gemini-api/docs/api-key), [pricing](https://ai.google.dev/gemini-api/docs/pricing).

Gemini 3.8 Flash is the initial Google choice: it supports agentic work and has free-tier availability. Gemini 4 Argon is a stronger paid option; it is explicitly unavailable on the free tier. Model listing does not establish billing tier or usable quota. Limits depend on the project, model, and account, and free-tier data-use terms differ from paid service terms. [Models](https://ai.google.dev/gemini-api/docs/models), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [service terms](https://ai.google.dev/gemini-api/terms).

## Google sign-in options

| Route                          | Finding                                                                                                                                | nod decision                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Google identity sign-in        | Authenticates a person, without establishing Gemini API entitlement.                                                                   | Do not treat an identity token as a model key.                                 |
| AI Studio API key              | Documented Gemini API access, including eligible free-tier models.                                                                     | Add a Google Gemini connection with a direct key-creation link.                |
| Vertex AI                      | Separate Google Cloud access and billing.                                                                                              | Preserve the existing express/API-key connection.                              |
| Gemini CLI / Code Assist OAuth | Google explicitly prohibits third-party software from reusing this OAuth access.                                                       | Do not copy CLI client credentials or impersonate Gemini CLI.                  |
| Antigravity OAuth              | Its terms prohibit third-party applications and wrappers from using the service through this route.                                    | Do not expose a consumer-account shortcut.                                     |
| Google Cloud OAuth             | A separate project, consent, scopes, billing, and credential lifecycle are required. Pi's Gemini transport currently takes an API key. | A distinct future integration, not a replacement for key setup in this change. |

Sources: [Gemini CLI FAQ](https://geminicli.com/docs/resources/faq/), [CLI terms](https://geminicli.com/docs/resources/tos-privacy/), [Antigravity terms](https://antigravity.google/terms), [Gemini OAuth guide](https://ai.google.dev/gemini-api/docs/oauth), [Vertex authentication](https://cloud.google.com/vertex-ai/generative-ai/docs/start/gcp-auth).

Google AI subscriptions can include Cloud credit benefits. Those billing benefits do not permit reusing Gemini CLI or Antigravity authentication in a third-party assistant. [Google AI plans](https://one.google.com/about/google-ai-plans/).

## What we take from OpenCode

Audited OpenCode commit [`0471a39a0f24ba8ef89954176513b839b4b56971`](https://github.com/anomalyco/opencode/tree/0471a39a0f24ba8ef89954176513b839b4b56971).

OpenCode combines a provider/model catalog with small provider adapters for authentication, cloud setup, model discovery, and protocol differences. Its catalog carries modalities, tool support, context sizes, prices, and reasoning controls. Google uses Gemini API keys or Vertex credentials; this source does not provide consumer Google subscription sign-in. [Catalog](https://github.com/anomalyco/opencode/blob/0471a39a0f24ba8ef89954176513b839b4b56971/packages/core/src/models-dev.ts), [provider plugins](https://github.com/anomalyco/opencode/blob/0471a39a0f24ba8ef89954176513b839b4b56971/packages/core/src/plugin/provider.ts), [Vertex plugin](https://github.com/anomalyco/opencode/blob/0471a39a0f24ba8ef89954176513b839b4b56971/packages/core/src/plugin/provider/google-vertex.ts).

Keep Pi as nod's runtime. The pinned Pi 1.3.0 package already supplies the transport and model metadata for the additional native providers. Reuse those definitions instead of replacing nod's agent harness or copying OpenCode's whole registry. Providers requiring a separate SDK or account-specific OAuth flow are not made compatible merely by adding their names. [Pi source](https://github.com/earendil-works/pi/tree/v1.3.0/packages/ai).

## Implementation boundaries

- Keep provider IDs, setup links, explicit environment keys, and default choices in shared metadata. Keep endpoints and authentication code in provider adapters.
- For authenticated model listings, intersect the returned models with known protocol definitions. Google listing uses the `x-goog-api-key` header and pagination, with supported text generation and tools. Never send an unknown provider's key to a default OpenAI endpoint. [Google models API](https://ai.google.dev/api/models).
- When a provider offers only a public or bundled catalog, save its key and show that access is checked on first use. A nonempty key and public catalog are not authentication evidence.
- Preserve full provider model metadata. Gateways can route different models through different protocols. Cloudflare account and gateway identifiers belong to the saved connection; do not inherit another owner's process credentials.
- Select the curated default when available, otherwise the first supported model in the connection's catalog, and respect supported reasoning levels. Google requires an explicit choice when Gemini 3.8 Flash is missing. Bedrock requires an explicit choice when several models or profiles are available because inference profiles determine geographic routing. Never switch providers after a failed request.
- Keep existing ChatGPT and OpenRouter sign-in. Do not expose every OAuth hook in the SDK as a supported product flow. Anthropic directs third-party products to API keys or supported clouds. Copilot requires a separate account entitlement/device flow, so it is not exposed as a generic GitHub key. [Anthropic guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [OpenRouter PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth).
- Exclude Pi's legacy OpenAI Codex provider, already covered by nod's current ChatGPT flow, and TypeSafe's classifier-only provider from the chat picker.
- Keep the OpenAI-compatible endpoint option for additional compatible services and local servers. Vendor-specific APIs without a Pi adapter require their own implementation or a supported gateway.

## Ant Ling catalog override

Pi 1.3.0 bundles Ant Ling/Ring 2.6 models that retire on 2026-11-15. Replace those choices with Ling-3.1-flash, which Ant recommends for long-running assistant and tool workflows. Its hosted context is 256K; the model's advertised 1M context is not currently exposed by the official service. [Deprecation notice](https://developer.ant-ling.com/en/docs/models/deprecation/), [model documentation](https://developer.ant-ling.com/en/docs/models/ling/).

The model uses the existing OpenAI-compatible endpoint and bearer authentication. Ant accepts `thinking: { type: 'enabled' | 'disabled' }`, with no documented reasoning-effort range. Pi's existing `deepseek` thinking serializer produces that exact shape when `supportsReasoningEffort` is false. Offer Off and one enabled preset, represented internally as Medium; do not expose Low, High, XHigh, or Max. Synthetic Pi sessions cover both settings, execute a tool once, and return its result to the model without sending the obsolete `reasoning.effort` or `reasoning_effort` fields. [API documentation](https://developer.ant-ling.com/en/docs/api-reference/chat/openai/), [pinned Pi serializer](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/api/openai-completions.ts).

Use a conservative 32,768-token application output cap. This matches several entries in the audited OpenCode catalog; it is not a claim about the direct API's maximum output. The native catalog has no current Ling-3.1 entry, so the adapter supplies the model metadata explicitly. [Audited catalog](https://github.com/anomalyco/opencode/blob/0471a39a0f24ba8ef89954176513b839b4b56971/packages/core/src/models-dev/snapshot.txt).

Direct prices are published in CNY. On 2026-10-23, the promotional prices were CNY0.50 input, CNY1.50 output, and CNY0.10 cache read per million tokens. At the dated USD/CNY6.6703 market quote, the rounded USD estimates are $0.075, $0.225, and $0.015 respectively. These are conversion estimates, not invoice guarantees; refresh them when the promotion or exchange rate changes. Ant does not list a separate cache-write charge. [Official pricing](https://developer.ant-ling.com/en/docs/models/price/), [dated exchange-rate quote](https://ca.investing.com/currencies/usd-cny-historical-data).

## Evidence

Source and catalog checks establish an implementation path and current model identifiers. Contract tests use synthetic credentials and controlled responses to check destination, authentication, streaming, isolation, and failure handling. A fixture walkthrough demonstrates the UI; it does not establish real provider quota, entitlement, inference quality, or production deployment. Live account acceptance must be reported separately.
