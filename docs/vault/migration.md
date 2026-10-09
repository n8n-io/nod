# Migration

## Current state

Assessed on 9 October 2026 from the code.

**What works well and stays:**

- the server-side fill: the exact origin is checked before every field and keystroke;
- single-use, hashed, expiring secure-form tokens;
- uncertain steps are never replayed;
- private email codes;
- AES-GCM bound to owner and record;
- Vault content kept out of analytics, session replay, feedback screenshots and link previews.

**What this design replaces.** The file references are from before the first steps.

| Problem                                                                                                                       | Where                                                                 | Now                                |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| `get_credential {id, origin}` returns the password to Pi, with no turn, page or tripwire check, and puts it in the Pi session | `src/server/composition.ts:762-770`                                   | Fixed: `sign_in`                   |
| Event turns can use credentials                                                                                               | `src/server/triage.ts:425-432`                                        | Fixed: no grants                   |
| Saved sessions are usable by event turns, which are not read-only                                                             | `src/runtime/index.ts:42`, `src/server/browser-connections.ts`        | Fixed: grants and browser sign-out |
| The thread browser stays signed in for any later turn, background work included                                               | agent-browser thread profiles                                         | Fixed: browser sign-out            |
| Old saved Pi sessions hold plaintext `get_credential` results                                                                 | Saved Pi sessions                                                     | Fixed: removed on load             |
| A wrong key opens nothing, then seals new items beside the old ones                                                           | `src/server/vault.ts`                                                 | Fixed: key check                   |
| Security codes are stored without a choice, in hosted mode too                                                                | `src/server/vault.ts:81-85`                                           | Fixed                              |
| A missing Keychain item silently creates a new key                                                                            | `src/providers/keychain/key-store.ts:33-48`                           | Fixed                              |
| One unreadable login fails the whole Vault list                                                                               | `src/server/vault.ts:484-490`                                         | Fixed                              |
| A new password for an existing account adds a duplicate                                                                       | `src/server/vault.ts:530-533`, `tests/vault.test.ts:401-414`          | Fixed                              |
| Disconnect on Apps deletes the saved login                                                                                    | `src/server/integrations.ts:2018-2026`, `src/web/pages/apps.tsx:1301` | Fixed                              |
| Saved cards cannot be used                                                                                                    | Only `src/server/vault.ts` reads `vault_cards`                        | Open: `pay`                        |
| Four copies of seal and open, one raw key, no key ID or rotation                                                              | `vault.ts`, `vault-app-grants.ts`, `channel-settings.ts`              | Open                               |
| Sign-in state spread over three tables and an in-memory map, never cleaned up                                                 | `src/server/vault.ts:374-396`                                         | Open                               |
| The owner-wide thread lock is held while typing into the browser                                                              | `src/server/vault.ts:907`                                             | Open                               |
| About nine separate redaction mechanisms                                                                                      | `composition.ts`, `bug-report.ts`, `redaction.ts`, agent-browser      | Open                               |

## Prerequisites

- Otto's browser tool cannot reach fields inside cross-origin frames. agent-browser 0.38 can switch frames; release needs that, plus each field's frame origin and bounding box.
- Check Touch ID and Windows Hello support in Electron for the desktop reveal and the one-tap payment approval.

## Steps

Each step ships on its own.

1. **`sign_in`.** Built. `get_credential` is replaced by `sign_in`, which never returns a value, and old results are removed from saved Pi sessions when they load. Grants (`vault_grants`) come from the owner's words, the schedule instruction, a yes, the owner's own entry, or Sign in without asking; event, read-only and onboarding turns hold none, and the tripwire suspends them. Saved sessions need a grant and open only their own site. When a turn first takes the browser, the browser signs out unless the turn may use every site it is signed in to. Each sign-in, session use, question and held attempt is recorded in `vault_activity`.
2. **Secrets.** A key check already fails closed on a wrong key. Add `secrets.ts`, `vault_keys` and key IDs. Re-encrypt existing rows in one transaction. Move app grants and channel settings onto it.
3. **Items and uses.**
   - Add `vault_items` with lookups, `release` and `vault_uses`.
   - Delete the three sign-in tables and the identifier map.
   - Type outside locks.
   - Show the activity view. Built as `vault_activity` beside the existing sign-in tables; the tables are not merged yet. The chat stays quiet: activity lives in Vault, as the Trust panel direction asks.
4. **Keeper.** Move `secrets.ts` and `release` into the keeper process.
5. **Cards.** Remember security code with consent per card is built, and hosted mode never keeps a code. `pay` with mandates remains.
6. **Egress.** Add the egress registry in place of the redaction lists, and screenshot masking.
7. **Accounts.** Built for sessions: website sessions and logins live in Vault, Apps no longer lists them, and Disconnect no longer deletes a password. The per-site Sign in without asking switch is built. CSV import remains.
8. **Signed-in turns.**
9. **One-time cards.** Add the Stripe Link source. Hosted cards follow the compliance decision.
10. **1Password.** Optionally read a dedicated 1Password vault through a read-only service account.

When a step ships, update [architecture](../architecture.md), [AGENTS.md](../../AGENTS.md), [SECURITY.md](../../SECURITY.md) and the [README](../../README.md) to describe it.

## Tests

The current Vault tests keep their invariants and become the acceptance suite: single use, exact origin, no replay, owner scoping. New tests, by [invariant](security-model.md#invariants):

| Invariant | Test                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1         | No tool result or Pi session entry contains a released value                                                                  |
| 2         | The server process never receives the outer key or the data key                                                               |
| 3         | A release without a valid grant is refused, and every release writes its use first                                            |
| 4         | A login is not typed when the top or frame origin differs                                                                     |
| 5         | No grant is created from page content or tool results                                                                         |
| 6         | Event, read-only and onboarding turns cannot release or open a saved session                                                  |
| 7         | A tripwire flag suspends standing grants until the owner's next message                                                       |
| 8         | A mandate is used once, expires and cannot be approved from a channel                                                         |
| 9         | A security code is stored only on an own install with consent, never in hosted mode, and is otherwise gone after its use ends |
| 10        | An interrupted release becomes uncertain and is not repeated                                                                  |
| 11        | A wrong outer key locks the Vault and creates nothing                                                                         |
| 12        | Every release and held attempt has an activity row with a reason and no value                                                 |
| 13        | A saved session cannot be opened without a grant                                                                              |
| 15        | A released value in a message or URL is blocked                                                                               |

Also: saving the same account updates its password; the same card cannot be saved twice.

## Evals

- The existing sign-in scenarios.
- `saved-card-checkout` as a real purchase.
- Two injection scenarios: a page asks Otto to sign in to another site, and a page asks Otto to pay.
- A measure of extra questions from signed-in turns.

## Decisions

1. **Hosted cards.** Hosted mode offers only one-time card sources and stores no card numbers or security codes. Revisit when hosted owners need saved cards, or when agent card tokens from Visa and Mastercard are generally available.
2. **Security codes on own installs.** Remembered per card when the owner chooses it. The payment dialog then needs one tap, and on desktop Touch ID or Windows Hello.
3. **Recovery.** No passkey recovery for now. Owners of local and Linux installs back up the outer key.
