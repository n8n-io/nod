# Channel security review

This is a partial review of the WhatsApp and Telegram change in [PR #423](https://github.com/n8n-io/nod/pull/423). It uses the [Cloudflare security audit skill](https://github.com/cloudflare/security-audit-skill/blob/main/skills/security-audit/SKILL.md), with its scoped standard workflow. It does not establish that all of nod is secure.

The audit source is `59d1fed8d0df523a8c49093f5e37d5addf40e485`. Fixes are in later PR commits. Four reconnaissance passes and two hunter waves cover provider identity, reply and task routing, private codes, file and speech intake, device keys, private setup and dependency packaging. A critic checked each wave. A separate final critic found no missing source coverage in this scope. Each retained record has an independent candidate check and a fresh final record check. The findings and coverage validators pass.

The ledger has 11 units: seven covered without a finding, three with an audit record and one outside this scope. Unchanged Trust, Vault, payment and local-access code was read only as a control on a changed path. General release automation, cloud policy, native memory safety and unchanged product areas are outside scope.

All execution used bounded offline Linux fixtures. Source and tools are read-only. Only temporary scratch storage is writable. Each process has an empty allowlisted environment, resource limits and a deadline. Database checks use disposable schemas on an isolated PostgreSQL fixture. No live model, account, real code or recipient was used.

## Findings in the initial revision

| Record                                                               | Evidence                                                                                                                                                                                                                                                                           | PR fix                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium: a native code reply can select the wrong sign-in request     | With closed request A and sole pending B, a native reply to A called a dummy code-entry hook for B in both channels. A correctly mapped internal reply was refused. This proves wrong request dispatch, not successful sign-in.                                                    | Map native replies through owned sent messages before private verification. Bind each credential question to its exact pending request in the transaction that saves the question. Refuse closed, unknown and unbound credential-question targets. The regression fixture keeps B pending while it replies to closed A, including two requests in the same turn. |
| Low: Baileys drops media cancellation options                        | The pinned dependency received a signal but omitted it from fetch. The real channel drain, replacement and shutdown stayed pending for a 250 ms observation after abort. Releasing a synthetic response completed cleanup. No data was saved or sent.                              | A pinned patch forwards the signal and redirect policy at the actual fetch call. The adapter checks abort again before it consumes a returned stream. Regression checks hold response headers, reject redirects and return a stream after abort.                                                                                                                 |
| Needs provider evidence: self-chat recipient LID and alternate phone | Synthetic decoder input can give an outgoing message another recipient LID and the owner's alternate phone. The initial transport accepts that input. The fixture does not establish authenticated real provider metadata, decryption or live delivery. This lead has no severity. | Self-chat now requires the linked account's own LID. An alternate phone or phone mapping cannot identify self-chat. Outgoing self-chat results also refuse another LID. The fixture gives the other LID the owner's alternate phone and phone mapping, then checks refusal. The live check must also confirm valid self-chat.                                    |

The audit does not claim a redirect to an internal host, account access, private-data disclosure, an indefinite request or a deployed outage.

## Further hardening

- Check UTF-8 value bytes and cumulative sealed batch bytes before encryption or database work. Serialize encryption with key writes. Vault key checks include linked channel state.
- Prepare at most four distinct media messages at once. Concurrent duplicates join the same work. Refuse another upload until capacity is free.
- On rollback, remove only exact generated files with no owned saved artifact row. Stop, replacement and shutdown fence late writes.
- Retain file-size, transcript-length and spending-limit failures through the media wrappers, so the channel notice describes the actual failure.
- Save settings before starting unlink. A failed SQL write does not unlink. A local key-deletion failure stays failed and can be retried without a second remote logout.
- Keep failed provider sends uncertain. A local file-read failure before a send can still deliver text and the missing-file notice.
- Poll WhatsApp setup only while its panel is open. Keep QR data transient, private, excluded from recordings and out of screenshots with real accounts.

The Signal console patch was already present at the audit source. A regression fixture checks that session changes do not write keys to the console. Container and desktop inputs include both dependency patches.

## Finite load and failure checks

The channel fixtures send 64 concurrent copies of one message and 32 replays after restart. They check one saved file and one submitted turn. They also send 32 foreign messages, hold four distinct uploads, refuse a fifth, release capacity and accept its explicit retry. Other checks exceed UTF-8 key-batch and actual media-stream byte limits, fail a file save after bytes are written, cancel a late stream, lose a send response and fail key deletion.

These are finite synthetic regression checks. They do not measure live provider throughput or perform a saturation test.

## Remaining live work

The owner chose to keep live verification pending. [The manual checklist](README.md#manual-live-check) covers both WhatsApp modes, Telegram pairing, task replies, files, voice, restart, network loss, stop and disconnect. Keep account details and real QR data in the private setup UI.

The unofficial WhatsApp protocol can change. This review cannot establish future compatibility, account restrictions, real provider retention or acceptance of each media format. The setup demo uses synthetic API responses and proves only its stated UI checks.
