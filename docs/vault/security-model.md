# Security model

## Trust boundaries

| Component                          | Trusted with                                                                  | Never trusted with                        |
| ---------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------- |
| Owner                              | Everything they own                                                           | —                                         |
| Keeper                             | Outer key, data key, decryption                                               | Deciding grants; reading pages            |
| Otto server                        | Grants, policy, one released value at a time on its way to a sink             | Keys; bulk decryption                     |
| Pi and its web extension           | References, page content, tool results                                        | Any secret value; creating grants         |
| Review model                       | The owner's recent messages, the message they answered, the requested release | Page content, tool results, secret values |
| Browser                            | Typed values for the current page                                             | Deciding where values go                  |
| Pages, emails, files, tool results | Nothing                                                                       | Instructions or permission                |

The keeper is a separate process. In Docker and hosted runtimes it runs as its own user, and the server never receives the outer key. On a local macOS install without containers it runs as the same OS user, so it protects against code inside the server process but not against other programs the user runs. That is the same limit as any password manager without OS app binding.

## Invariants

These describe the finished design; [migration](migration.md#steps) says which step brings each one. Tests cite them by number.

1. **No values to the model.** No tool returns a secret value to Pi, and no secret value is written to the Pi session.
2. **Keys stay in the keeper.** Only the keeper holds the outer key and the data key. The server never receives either.
3. **Every decryption is a release.** The keeper decrypts for use only through `release(item, destination, grant)`, and writes the use row before the value leaves.
4. **Exact destination.** A login is typed only into a field whose top origin and frame origin are among the item's origins, re-read from the browser in the same step as typing. A token is sent only to its connection's base URL and path prefix, CLI path or provider.
5. **Trusted grants.** Grants come only from the owner's messages, schedule instructions, the owner's answers and the owner's approvals. Page content and tool results never create or widen one.
6. **No background secrets.** Event, read-only and onboarding turns hold no grants, standing grants included.
7. **Tripwire suspends.** A tripwire flag suspends every grant until the owner's next message. Questions still work.
8. **Mandated payments.** A payment needs a mandate approved by the owner in Otto web or desktop, with the card's security code or, with Do it for me, a yes, or in the card issuer. A chat app reply cannot approve one. A mandate is used once, is bound to merchant, amount, currency, card and the verified sites of the card fields, and expires after ten minutes. The card is entered only into the verified field's own document, never on a page Pi ran a script on.
9. **Security codes by consent.** A card's security code is stored only on an own install, only when the owner chose to remember it for that card, and never in hosted mode. Otherwise it exists only for the use that consumes it.
10. **No repeats.** A release that may have happened becomes uncertain and is never repeated.
11. **Fail closed.** A key that cannot unwrap existing data locks the Vault. No key is created over existing data.
12. **Visible.** Every release, question, held attempt and grant change appears in the activity. No activity row contains a value.
13. **Sessions are credentials.** Opening a saved browser session needs the same grant as signing in.
14. **Owner scope.** Every row, query and route is owner-scoped.
15. **Egress.** A released value registered for a thread is blocked on every outbound path except its destination.

## Policy

|                                              | Conversation   | Schedule                           | Event                 | Read-only, onboarding |
| -------------------------------------------- | -------------- | ---------------------------------- | --------------------- | --------------------- |
| Sign in or open a saved session, granted     | Direct         | Direct                             | No                    | No                    |
| Sign in or open a saved session, not granted | Question       | Question, expires after 30 minutes | No; tells the owner   | No                    |
| New values                                   | Secure form    | Secure form, waits                 | No                    | No                    |
| Pay                                          | Mandate        | Mandate, waits                     | Draft only            | No                    |
| Connected-app action with a stored token     | Trust check    | Trust check                        | Reads and drafts only | Reads only            |
| Tripwire active                              | Questions only | Questions only                     | No                    | No                    |

A connected app's token is released under the connection the owner made, and every action still passes the existing trust check.

## Threats

| Threat                                                                  | Stopped by                                                                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A page tells Otto to sign in elsewhere and send the password            | 1, 4, 5: Pi never has the password, release goes only to the login's origins, and an unmentioned site needs a question |
| A page tells Otto to buy something                                      | 8, 6, 7                                                                                                                |
| A lookalike site                                                        | 4: exact origins; a new origin needs a question that shows it                                                          |
| A login form inside a frame from another site                           | 4: the frame origin must match too                                                                                     |
| A secret in a screenshot                                                | Filled fields are masked; screenshots are refused after a card fill                                                    |
| Otto repeats a secret                                                   | 1 and 15                                                                                                               |
| Code in the server process reading keys, including the Pi web extension | 2 and 3: it can only request single releases, each recorded                                                            |
| A copied database                                                       | 2: the outer key is outside the database; lookups are keyed; 9                                                         |
| A lost or changed key                                                   | 11                                                                                                                     |
| A ciphertext moved between rows                                         | The associated data binds version, key, kind, owner and item                                                           |
| A replayed form or mandate                                              | Hashed single-use tokens; 8; 10                                                                                        |
| Background misuse                                                       | 6 and 13                                                                                                               |
| Otto uses a permission without the owner noticing                       | 12                                                                                                                     |

## Residual risks

Stated plainly, so that nothing claims more than it does:

- **Actions inside a granted site.** Once signed in, Otto can act on that site through the browser. The Vault does not judge those actions, and the trust check covers connected apps, not browser clicks. Signed-in turns review new destinations for data leaving the site. A purchase still needs a mandate.
- **A wrong match by the review model.** It may grant a site the owner did not mean. The release still goes only to the login's own origins, and the activity shows it.
- **Say-so in use.** A yes, or the owner's own entry, lets the conversation use that site until 30 minutes after its last use, so a page met in that time could steer Otto there. The tripwire, the question on any other site and the activity view are the backstops.
- **Sign-ins Otto cannot see.** Magic links and single sign-on hops are not tracked. They last only as long as the conversation that made them stays active; everything else starts with a signed-out browser.
- **Old sessions.** Plaintext from the old `get_credential` tool is removed from saved Pi sessions when they load, including passwords Pi later typed. A compaction summary written before that may still paraphrase one.
- **Values in transit.** A released value passes through the server process on its way to a sink. It is never stored there and never sent to Pi.
- **Same-user programs on local installs.** Without containers, the keeper runs as the owner's OS user.
- **Stored-card amounts.** With a stored card, the amount is what the owner approved; only one-time cards enforce it at the issuer.
- **Remembered security codes.** On an own install, a copied database together with the outer key gives a complete card for each card whose code the owner chose to remember.
- **Two factors in one place.** An authenticator seed next to the password is one factor held by Otto. Only the owner adds one.
- **Hosted card numbers.** See [payments](payments.md#hosted-mode-and-pci).
