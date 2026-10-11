# Sign-in and saved sessions

Pi reads the page, checks saved account metadata and chooses the method and field roles. Reuse a uniquely applicable account. Ask when the account or method is ambiguous. Website defaults do not select the owner's account.

`sign_in` takes field references and a submit reference. It returns status, metadata or a secure-form request, never a saved password or verification code. The server authorizes the selected account for the current task and exact origin. A mention of a host does not bypass review. An explicit approval binds the same item and arguments.

For a new account, the owner uses a secure form. Username and password entry, identifier-first flows, passwordless identifiers and verification codes use the same private browser operation. A staged identifier is held as encrypted selection data. It is not held in a second in-memory cache.

The staged identifier binds the next password step to that account. After password submission, the same task can choose another saved account on the same origin. An automatic use cannot repeat the same account and step.

Private entry submits the chosen control and keeps the live page. Pi inspects the current result before it continues. There is no fixed completion wait or automatic reload. It does not click the same submit control again. An uncertain attempt is not replayed. A new secure request is a new explicit attempt after the result was checked.

Email verification uses the exact owned mailbox and checks sender, recipient, time and account before entry. Split code selectors can select all code boxes. The provider enters each character into the selected box in its own verified document. A focus change cannot redirect global secret keystrokes to another frame.

## Profiles

`browser_session connect` creates a private profile. `save` records Pi's observed sign-in on the connection origin. `use` selects an owned profile and an exact destination. Opening a profile is not evidence of successful authentication.

Both `connect` and `use` accept `destinations`, a list of extra exact origins for assets, APIs or sign-in redirects. `connect` creates an empty profile without a Vault permission review. For `use`, one review covers the full set of origins and the selected session. Permission binds each exact origin and item. The browser proxy blocks all other network origins for that profile. Blocked origins appear in the observation so Pi can request the ones the task needs. Ordinary scripts and browser controls stay available.

The thread has one browser holder. A continuing task can keep its signed-in browser. A new task must pass the permission check for every origin and item used by that browser. Otherwise it starts signed out. Event and read-only work starts signed out. Sign-out closes the active browser and removes the thread profile, cache and downloads; saved profiles remain.

Native WebAuthn is enabled. A passkey needs an authenticator available to that browser; Otto does not create one. Magic links and manual sign-in can use the owner handoff. A saved browser profile does not create a saved password.
