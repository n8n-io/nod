# Payments

Otto pays only under a mandate the owner approved, and the model never sees a card number or security code.

## Card storage

Own installs are the desktop app and any server the owner runs for themselves. Hosted mode is the operator's service.

| Field                      | Stored                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Number                     | Encrypted                                                                                           |
| Cardholder                 | Encrypted                                                                                           |
| Expiry                     | Encrypted, and in clear in the hint                                                                 |
| Brand and last four digits | In clear in the hint                                                                                |
| Number lookup              | HMAC under the lookup key                                                                           |
| Security code              | Hosted mode: never. Own installs: encrypted, only when the owner chose to remember it for that card |
| First six digits           | Never                                                                                               |
| Unkeyed hash of the number | Never                                                                                               |

## PCI DSS v4.0.1

| Requirement                                                                                                                             | How                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 3.3.1: no sensitive authentication data after authorization                                                                             | Hosted mode never stores a security code. Own installs store one only with the owner's consent, under the FAQ 1574 exclusion |
| 3.3.2: sensitive authentication data before authorization is encrypted                                                                  | The code is staged encrypted on the use and wiped when the use ends                                                          |
| 3.4.1: display masked to first six and last four at most                                                                                | Only brand and last four are shown                                                                                           |
| 3.5.1: the stored number is unreadable                                                                                                  | AES-256-GCM per item                                                                                                         |
| 3.5.1.1: hashes of the number are keyed                                                                                                 | HMAC under the lookup key                                                                                                    |
| 3.5.1, FAQ 1308: hashed and truncated forms cannot be correlated                                                                        | The hash is keyed; the first six digits are not stored                                                                       |
| 3.6.1.2: keys wrapped by a key-encrypting key at least as strong, kept apart                                                            | Data key wrapped by the outer key; the outer key is outside the database                                                     |
| FAQ 1574: no stored security codes for consumers, password vaults included, except consumers storing their own card on their own device | Hosted mode never stores one. An own install is the owner's own device, and stores one only when the owner asks              |

## Mandates

A mandate is a `pay` grant with `max_amount`, `currency`, the merchant origin and the card. It is used once and expires after ten minutes.

```mermaid
sequenceDiagram
  participant Pi
  participant S as Server
  participant O as Owner
  participant K as Keeper
  participant B as Browser
  Pi->>S: pay(card, amount, currency, summary, fields)
  S->>B: merchant origin and each field's frame origin
  S->>O: payment dialog in Otto web or desktop
  O->>S: Pay, with the security code unless it is remembered
  S->>K: stage the typed code or use the remembered one; release the card under the mandate
  S->>B: type number, expiry, name and code
  S->>K: finish the use; wipe the code
  S-->>Pi: Card details entered
  Pi->>B: place the order
```

- **Tool.** `pay {card?, amount, currency, summary, fields: {number, expiry, code, name}}`.
- **Merchant.** The server reads the merchant origin from the browser, not from Pi.
- **Payment frames.** Each field's frame origin is the merchant or a payment frame such as `js.stripe.com`. The dialog lists any payment frame that will receive the card.
- **Approval.** Typing the security code is the approval. When the owner chose to remember the code, the approval is one tap on Pay, and on desktop Touch ID or Windows Hello. Pi cannot press Pay: its browser runs in a separate container without the owner key. Telegram and WhatsApp receive "Open Otto to pay securely," so a chat reply can never approve a payment.
- **Fill.** One use; an interruption makes it uncertain and it is never repeated. Screenshots are refused until the page leaves the merchant.
- **Order.** Pi places the order. A 3-D Secure challenge goes to the browser handoff.
- **Turns.** Event turns can only draft a purchase. A schedule waits for the owner.

## Card sources

| Source                    | Where                                    | Approval                                                                        | What enforces the amount                       |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| Stripe Link one-time card | Where the owner uses Link; US only today | In Link                                                                         | The issuer: one card for the exact amount      |
| Stored card               | Own installs                             | The payment dialog in Otto: the security code, or one tap when it is remembered | The owner's approval and the card's own checks |

A one-time card's number is never stored; it is released straight into the fields and discarded. Standing approvals for schedules, such as "up to €50 a month at utility.example", need a one-time card source, because only the issuer can enforce the amount. A remembered security code does not change that.

## Hosted mode and PCI

- **Own installs.** Cards, and security codes the owner chose to remember, stay on the owner's own device. PCI FAQ 1574 treats a consumer's own device like their payment card.
- **Hosted.** A hosted service that stores many owners' card numbers is a PCI service provider. That means SAQ-D or a QSA assessment, keys in a hardware-backed key service, and a random outer key per tenant so a deleted tenant can be crypto-shredded.
- **Decision.** Hosted mode offers only one-time card sources and stores no card numbers or security codes. Revisit when hosted owners need saved cards, or when agent card tokens from Visa and Mastercard are generally available.
- **Handoff.** Compliance should also review checkout handoffs: an owner who types a card into the hosted browser sends it through operator infrastructure.

## Limits

- With a stored card, Otto cannot check the final total on the page without reading it, so the approved amount is what Pi reported. One-time cards enforce it at the issuer.
- Agent-specific card tokens from Visa and Mastercard are not generally available yet. They would be another card source.
