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
- Capture the conversation before media preparation. Under the reset lock, discard old intake before file persistence or verification. A reset also fences saved media before submission.
- Bind transcription usage IDs to the admitted turn and its actual session. Count that input cost in its task budget even when transcription finished before the turn was created.
- Restart only the exact setup generation, with a synchronous transport guard that refuses a connected device. Closing after restart cancels the replacement; old polls cannot replace its status.
- Speech can use a selected or unique owned OpenAI API key from Models. It excludes subscription and compatible-endpoint credentials and reads again before each request. Removing a key stops later requests.
- Poll WhatsApp setup only while its panel is open. Keep QR data transient, private, excluded from recordings and out of screenshots with real accounts.

The Signal console patch was already present at the audit source. A regression fixture checks that session changes do not write keys to the console. Container and desktop inputs include both dependency patches.

## Media review after the frozen audit

Three independent source reviews checked `3c25bb2f..4f8e81a1`. They covered media setup notices, attachment authority, code replies, reset fencing, owner-scoped previews, audio cleanup, map consent and native contact and location sends. They found one protocol error: Telegram checked vCard bytes before line-ending conversion. A later fix checks the exact outgoing card and preserves the original file when it is too large. A separate source check confirmed that fix. Regression cases cover line-ending expansion, a filename and MIME mismatch, and exact 2048-byte and 2049-byte cards.

Further source checks found a waveform decode limit that trusted browser duration metadata and an ordinary-persistence race in the no-model voice verification exception. Waveform decoding now requires a single mono or stereo Ogg Opus stream, valid page checksums, bounded granules and at most ten minutes of packet time. Other audio keeps native playback without a waveform. The model state at voice intake is frozen for the private-code fallback. A real Vault and verification fixture closes the request while transcription waits, connects a model, then releases the code. It checks no raw code, file, ordinary turn or failed webhook reply. No-model speech failures and rejected native replies use the plain setup notice.

These follow-up reviews do not extend the frozen audit ledger or prove codec compatibility or live delivery. Browser checks use a real synthetic Ogg file. Incoming contacts use the existing media byte limit, without an extra card-count limit. Unsupported or large contact previews keep the original downloadable file.

A later independent source review checked the OpenRouter transcription path, key selection, request targets and usage records. It found a misplaced readiness getter, which was moved to the speech wrapper. A fixture checks speech setup changes without an app restart. The final source review found no remaining issue in this change. OpenRouter sign-in supplies an inference key; ChatGPT subscription credentials remain excluded. Keys are read for each request. Both speech services use fixed addresses and refuse redirects. A failed request does not switch services. This review does not verify live API behavior or billing.

Further independent source reviews checked image-model selection, image usage, TGS playback and vCard decoding. Vision requests now make one attempt, retain subscription price estimates and record the current turn, run and session. The description is untrusted data and has no host file paths. It does not change the owner's chat model or approve an action.

TGS playback uses the pinned expression-free light canvas player in an opaque iframe. Its policy blocks network requests. The decoder bounds compressed bytes, decompressed bytes, dimensions, frames, structure, composition references, parent chains and generated shape work. It refuses expression data, unsupported modifiers, completion flags, slots, external assets, masks and mattes. The work estimate includes repeated references, styles and intermediate modifier output. Complex files keep the original download. Synthetic cases cover the reported expansion paths. The final source check found no missed bound in those paths; it was not a general audit of Lottie.

Contact parsing collects folded line chunks and joins each logical value once. A fixture checks 100,000 folded lines, quoted-printable names and vCard 2.1, 3.0 and 4.0. Contact website values remain plain text. These reviews do not change the frozen audit records.

## Finite load and failure checks

The channel fixtures send 64 concurrent copies of one message and 32 replays after restart. They check one saved file and one submitted turn. They also send 32 duplicate deliveries of one foreign message, hold four distinct uploads, refuse a fifth, release capacity and accept its explicit retry. Other checks exceed UTF-8 key-batch and actual media-stream byte limits, fail a file save after bytes are written, cancel a late stream, lose a send response and fail key deletion.

These are finite synthetic regression checks. They do not measure live provider throughput or perform a saturation test.

## Remaining live work

The owner confirmed incoming Telegram photo handling in the isolated test app. The full live checklist remains open. [The manual checklist](README.md#manual-live-check) covers both WhatsApp modes, Telegram pairing, task replies, files, voice, restart, network loss, stop and disconnect. Keep account details and real QR data in the private setup UI.

The unofficial WhatsApp protocol can change. This review cannot establish future compatibility, account restrictions, real provider retention or acceptance of each media format. The setup demo uses synthetic API responses and proves only its stated UI checks.
