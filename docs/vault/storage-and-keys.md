# Storage and keys

The existing key sources remain: macOS Keychain, desktop safe storage, an explicit server key, or a key derived for one hosted owner. The key stays outside PostgreSQL. The server is trusted with it. This design does not add a second process or a new wrapped-key hierarchy.

`vault-crypto.ts` is the shared AES-256-GCM implementation. Each value has a random 12-byte nonce, a 16-byte authentication tag and associated data. Callers bind the owner, record and purpose through the existing versioned format. Login, card, app grant and channel settings keep their current ciphertext contracts.

`checkedKeyStore` checks a known encrypted value under a database advisory lock. For a legacy Vault without a check, it first authenticates an existing encrypted row. A wrong key cannot create a new check over old data. A missing or invalid key stops encrypted-value use and writes. A one-time code form needs no stored encryption key. Unreadable records remain available for removal.

Login save and import take a short owner lock. Concurrent saves of the same origin and account keep one account ID. Browser work runs outside database transactions and row locks.

## Records

| Record                                | Purpose                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `vault_entries`, `vault_cards`        | Encrypted saved values and safe display metadata                                            |
| App grant and channel settings tables | Existing sealed connection values                                                           |
| `vault_payments`                      | Payment selection, approved card revision, expiry and consumption                           |
| `credential_requests`                 | Secure form selection, expiry and consumption                                               |
| `credential_account_selections`       | Encrypted account data for staged sign-in; a held password is removed before password entry |
| `vault_grants`                        | Task, item and exact-origin permission; explicit standing site permission                   |
| `vault_uses`                          | Single operation claim, automatic-attempt fence and outcome                                 |
| `vault_activity`                      | Owner-readable uses, questions, held attempts, reveals and permission changes               |

`vault_uses` has three states: `running`, `submitted` and `uncertain`. Startup changes interrupted `running` records to `uncertain`. The operation ID and automatic-attempt key remain claimed and cannot run again. `submitted` means the provider completed entry and submission, not that the website accepted sign-in or completed a purchase. No row contains the value.

Secure forms record interaction state: `pending`, `consumed`, `superseded` or `retried`. Payment requests use `pending`, `consumed` or `superseded`. They do not record operation outcomes. Their views read the outcome from `vault_uses`.

One executor runs three phases: a short claim transaction, browser work without a database transaction, and a short completion transaction. The claim consumes the request and removes a staged password before password entry. Identifier-only steps retain the encrypted password for the next step. For a payment, it also locks and reads the approved card revision. Secure-form and payment completion save account state, activity and submission with the same database connection and transaction. Saved-login, staged-login and email-code activity use separate writes. A failure after the claim records uncertainty.

The card revision is a hash of the encrypted record and its permission setting. It contains no plain card value. Card or permission changes invalidate pending approvals. A permission change and its owner activity use the same database connection and transaction. Code retention checks the current revision and permission under a row lock; it cannot restore revoked permission.

Saved accounts, staged accounts, secure forms and email codes prepare the same sign-in operation. Cards use the same executor instance. It starts once, before the application accepts turns. Legacy attempt fences and outcomes move to `vault_uses`; the old attempt table is removed.

Startup cleanup removes owner activity older than 90 days and task grants older than seven days. Task-grant lookup also refuses grants older than seven days. Do not remove use claims in a way that permits replay of an old request.
