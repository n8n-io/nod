# Security model

## Boundaries

| Component        | Authority                                                                     |
| ---------------- | ----------------------------------------------------------------------------- |
| Owner            | Chooses accounts, approves actions and changes permissions                    |
| Server           | Holds the key, checks policy, decrypts and records uses                       |
| Browser provider | Verifies origins and documents, enters values and submits                     |
| Pi               | Chooses methods, accounts and controls; receives metadata and website results |
| Review model     | Matches an action to owner messages or a schedule instruction                 |
| Website          | Receives values submitted to its origin                                       |

Page content, email, files and tool results cannot create permission. The review model receives owner messages and the message being answered, with no tool results. A domain mention is not consent. A cancelled task or a request to remain signed out must not authorize sign-in.

## Enforced rules

- A task grant binds the owner, root turn, exact origin and selected item. A standing site grant requires an explicit owner setting.
- Event, read-only and onboarding turns do not sign in. An injection flag holds use until the next owner message.
- A secure form binds owner, turn, origin, selected fields and expiry. Code replies are consumed before chat persistence.
- The browser checks the selected field's actual frame origin and document. Login fields must have the login's exact origin. Card fields must have the origins in the approved request.
- Secret entry uses an isolated JavaScript world in the same page and field-bound input. It never sends a code through global keyboard input.
- Pi chooses the submit control before entry. The provider enters and submits in one private operation. Pi cannot observe or act during that operation.
- Chrome checks JavaScript reads for side effects. A document changed by Pi JavaScript requires a reload before private entry. This removes listeners that Pi could use to copy values.
- After successful entry and submission, Pi keeps the live page. If entry fails, the observation lock remains until the filled document changes.
- Back-forward document caching is disabled, so Back loads a fresh document. Private fields have autocomplete disabled.
- Normal browser scripts, typing, screenshots and other tools work after that boundary. Native WebAuthn remains enabled.
- A saved profile has an ephemeral set of permitted exact network origins. Navigation, HTTP, HTTPS tunnels and WebSocket connections pass the profile proxy. Extra origins for APIs, assets and sign-in redirects require permission. A restored profile must receive a new scope.
- A new empty profile does not use a saved account and does not need Vault authority. Secret entry, saved-profile reuse and owner browser input retain their own checks. An anonymous checkout can continue after the owner adds a card.
- One executor claims each durable use before browser work. Forms and payments read its outcome. A claimed ID is never run twice. Interrupted or failed work is uncertain. There is no automatic retry.
- Ciphertext binds owner, record and purpose. The key check authenticates existing data before it can create a check for a legacy Vault.

Tool output replaces known values, and screenshots mask them. These checks do not detect all encodings.

## Limits

The server and browser provider can read values. There is no isolated key service, hardware-backed release policy or proof of information-flow isolation.

The destination website receives the secret and can store, encode or reflect it. An isolated JavaScript context does not hide a value from the page DOM. The live document remains available after submission, so website transformations can reach Pi.

The provider submits once. It does not use a fixed delay or network activity to infer success. Pi must inspect the result and wait for the page state that the task requires. This preserves state held only in page memory.

Once signed in, Pi can act on the permitted site. Vault permission does not review each browser click or prevent a harmful action within that site. App actions still use the separate trust check. Network origin permission also permits the site's own scripts to contact that origin.

A saved-card approval records amount and currency. It does not enforce settlement at the card issuer. A review model can make a wrong intent match. Tests cover known failure cases; they do not prove absence of all prompt injection or browser exploits.
