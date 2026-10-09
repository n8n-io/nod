# Research

Survey date: 9 October 2026. Sources are primary unless marked otherwise. Several products launched in 2026 and publish little; where a claim could not be confirmed, it is not used.

## Password managers

| Product                    | Mechanism                                                                                                                                | Used here                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1Password                  | AES-256-GCM items under vault keys; overview and details encrypted separately; versioned keysets; the server never decrypts              | Versioned, self-describing keys                       |
| Bitwarden                  | A user key wraps a key per item; ciphertext carries its type; new crypto goes through one module whose associated data names the purpose | One crypto module; purpose bound into associated data |
| Proton Pass                | One helper, `encryptData(key, data, tag)`, with a required purpose tag                                                                   | The same                                              |
| Apple Passwords and Safari | Credentials reach an app only after consent; Safari stores a card's security code only if the user chooses, with a warning               | Consent before remembering a security code            |
| Chrome                     | Ciphertext tagged with its key source; on macOS a missing Keychain item silently creates a new key; saving security codes is opt-in      | The tag and the opt-in; not the silent creation       |
| Firefox                    | Security codes never saved; device sign-in before filling cards                                                                          | A check before reveal                                 |

## Secret managers

| Product         | Mechanism                                                                                                                                       | Used here                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| HashiCorp Vault | Versioned barrier format with the storage path as associated data; stays sealed on a wrong key; Transit keeps keys inside and decrypts per call | Keeper; fail closed               |
| AWS KMS         | Envelope encryption: a data key per use, wrapped by a key that never leaves; encryption context as associated data                              | Data key wrapped by the outer key |
| Google Tink     | Key IDs in the ciphertext prefix; add, promote, then retire keys                                                                                | Key ID in the ciphertext          |
| Infisical       | Root key wrapped by an environment key; refuses to start when the configured key cannot decrypt                                                 | Fail closed                       |
| Signal Desktop  | Database key wrapped by safe storage; refuses a changed backend; creates a key only when none exists                                            | Fail closed; refuse `basic_text`  |

## Agents and credentials

| Product or work                                         | Mechanism                                                                                                                                        | Used here                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 1Password Secure Agentic Autofill, 1Password for Claude | The agent requests a login; the owner approves; 1Password fills; exact URL match; the model is told only which login was used                    | Fill outside the model; exact origin            |
| Chrome agent mode                                       | The model has no access to stored passwords; an alignment critic sees only the proposed action; origin sets split read-only and read-write sites | Review from trusted input only; signed-in turns |
| MCP specification                                       | No token passthrough; secrets requested only through a URL the model cannot see                                                                  | Secure forms; release into sinks                |
| Steel, browser-use, Stagehand, Notte                    | Placeholders replaced at the action; domain-scoped secrets; filled fields blurred                                                                | References; masking                             |
| Vellum                                                  | A separate service injects credentials the assistant cannot read                                                                                 | Keeper                                          |
| CaMeL; Design Patterns for Securing LLM Agents          | Authority from the trusted query only; capability and data-flow controls                                                                         | Grants from trusted input only                  |
| The Attacker Moves Second                               | Adaptive attacks beat published classifier defenses                                                                                              | Classifiers are a layer, not the boundary       |
| Brave on Comet                                          | A page made an agent read a sign-in code from the inbox and post it                                                                              | Codes never reach Pi                            |

## Consumer agents

| Product                                      | Adopted                                                                                                                    | Avoided                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Instinct (Spear Street, beta 26 August 2026) | A Vault the agent fills from; authenticator codes without phone interruptions; Link one-time cards                         | The agent enrolling its own authenticator; Vault logins in scheduled runs without a stated rule; no published Vault design |
| OpenInstinct (Merit Systems, open source)    | Opaque handles; origin checked again inside the frame; filled fields blurred in screenshots                                | Security codes stored without asking; card numbers left in tool results                                                    |
| Grok Bot (xAI, beta 11 August 2026)          | Allow once, always or deny; questions from routines expire; write-only secrets; a dedicated read-only 1Password vault      | Every bot and routine using every session without approval; auto fill removing the question; audit logs only on Enterprise |
| ChatGPT Work (OpenAI, 25 August 2026)        | Secure form with the exact address and a preview; a review model checking the sign-in target; sessions kept                | —                                                                                                                          |
| TinyFish Vault                               | Origin checked against the browser's real URL; codes generated at fill time; says plainly it does not cover session misuse | —                                                                                                                          |

The lesson across them: hiding the password protects the password, not the account. The easy products keep sessions and allow "always"; the trustworthy ones put those behind the same rules as the password. This design does both, and shows the owner every use.

## Payments

| Item                                             | Status, October 2026               | Used here                                        |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------------ |
| PCI DSS v4.0.1 and FAQs 1154, 1308, 1574         | In force                           | [Payments](payments.md#pci-dss-v401)             |
| PCI SSC AI principles                            | Published September 2025           | No card data in model context; a person approves |
| Stripe Link Agent Wallet                         | Available in the US                | One-time card source                             |
| Stripe Shared Payment Tokens, Issuing for agents | Preview; by application            | Possible future sources                          |
| Visa Intelligent Commerce, Mastercard Agent Pay  | Sandbox, pilot or through partners | Future card sources                              |
| Google AP2                                       | Open specification                 | Mandates                                         |

## Comparison

| Area          | Leading practice                                                             | This design                                                                         |
| ------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Agent sign-in | Fill outside the model, exact origin, approval for each use                  | The same fill; approval from the owner's request, a question only on a mismatch     |
| API tokens    | Injected at each call, never passed through                                  | The same, through one release                                                       |
| Authority     | Privileged decisions from trusted input only                                 | Grants from owner messages, schedule instructions, answers and approvals            |
| Storage       | Wrapped data keys, versioned ciphertext, associated data, fail closed        | The same, sized for one owner                                                       |
| Key isolation | A separate process or service holds keys                                     | The keeper                                                                          |
| Cards at rest | Keyed fingerprints, masked display, security codes only by the user's choice | The same; hosted mode never stores a security code                                  |
| Payments      | Mandates and scoped credentials                                              | Mandates approved with the security code or one tap; one-time cards where available |
| Transparency  | Audit logs for enterprises, if any                                           | Every owner sees every use, held attempt and permission                             |
| Still below   | Hardware-bound and zero-knowledge vaults; agent card tokens                  | Otto must decrypt to act on its own; most agent card programs are still pilots      |

## Sources

Standards and payments:

- PCI SSC FAQ 1574: https://www.pcisecuritystandards.org/faqs/1574
- PCI SSC FAQ 1154: https://www.pcisecuritystandards.org/faqs/1154/
- PCI SSC FAQ 1308: https://www.pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/how-can-an-entity-ensure-that-hashed-and-truncated-versions-cannot-be-correlated
- PCI SSC AI principles: https://blog.pcisecuritystandards.org/ai-principles-securing-the-use-of-ai-in-payment-environments
- Stripe security: https://docs.stripe.com/security
- Stripe Link agent payments: https://stripe.com/blog/giving-agents-the-ability-to-pay
- Stripe Link Agent Wallet: https://docs.stripe.com/agentic-commerce/agents/link-agent-wallet/use-link-wallet-pay-online
- Agent Payments Protocol: https://ap2-protocol.org/
- iCloud Keychain and security codes: https://www.apple.com/legal/privacy/data/en/icloud-keychain/

Password and secret managers:

- 1Password security design: https://agilebits.github.io/security-design/
- Bitwarden security white paper: https://bitwarden.com/help/bitwarden-security-white-paper/
- HashiCorp Vault rotation: https://developer.hashicorp.com/vault/docs/internals/rotation
- HashiCorp Vault Transit: https://developer.hashicorp.com/vault/docs/secrets/transit
- Tink wire format: https://developers.google.com/tink/wire-format
- AWS KMS cryptography: https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html
- XAES-256-GCM: https://c2sp.org/XAES-256-GCM
- Electron safe storage: https://www.electronjs.org/docs/latest/api/safe-storage
- Fail-closed key handling in source: Infisical `backend/src/services/kms/kms-service.ts`; Signal Desktop `app/main.main.ts`

Agents:

- 1Password Secure Agentic Autofill: https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents
- 1Password for Claude: https://support.1password.com/1password-claude/
- Bitwarden Agent Access SDK: https://github.com/bitwarden/agent-access
- Chrome agentic security: https://blog.google/security/architecting-security-for-agentic/
- MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP elicitation: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- Steel Credentials API: https://docs.steel.dev/overview/credentials-api/overview
- browser-use: https://github.com/browser-use/browser-use
- Vellum security practices: https://www.vellum.ai/docs/trust-security/security-best-practices
- TinyFish Vault: https://www.tinyfish.ai/blog/tinyfish-vault-your-web-agent-can-now-log-in-without-touching-your-passwords
- CaMeL: https://arxiv.org/abs/2503.18813
- Design Patterns for Securing LLM Agents against Prompt Injections: https://arxiv.org/abs/2506.08837
- The Attacker Moves Second: https://arxiv.org/abs/2510.09023
- Brave on Comet: https://brave.com/blog/comet-prompt-injection/

Consumer agents:

- Instinct authenticator support: https://x.com/noahrshinn/status/2098466184912089143
- Instinct payments through Link: https://x.com/noahrshinn/status/2093368511003574730
- OpenInstinct: https://github.com/Merit-Systems/OpenInstinct
- Grok Bot announcement: https://x.ai/news/introducing-grok-bot
- Grok Bot computer and apps: https://docs.x.ai/grok-bot/computer-and-apps
- Grok Bot approvals: https://docs.x.ai/grok-bot/approvals-security-and-privacy
- Grok Bot secrets: https://cursor.com/help/grok-bot/secrets
- Grok Bot 1Password vault access: https://forum.cursor.com/t/1password-vault-only-access-in-grokbot/172524
