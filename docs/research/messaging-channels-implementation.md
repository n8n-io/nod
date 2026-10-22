# WhatsApp and Telegram channels

Status: implemented and under PR review. Manual provider verification remains with the owner.

The implementation uses a separate Git worktree.
Branch: `feat/whatsapp-telegram-channels`, with main merged at `a8ae5a1b`.
The original checkout is unchanged. The change is under review in PR #423.

## Implemented behavior

- WhatsApp uses Baileys with QR setup, separate bot-number and self-chat modes, status, cancellation, disconnect and a new link.
- Device credentials and Signal keys use encrypted, owner-scoped storage. A new connection refuses stale writes and deletion. Disconnect removes the saved keys.
- QR data is transient. Only the private setup route returns it. The route uses `no-store`, requires local owner access and refuses a foreign origin. Session recordings exclude the setup panel.
- Sender checks reject unrelated people, groups, status messages, old history and self-chat echoes. Phone-number and LID addresses are supported. Self-chat LIDs must match the linked account's own LID, and replies cannot target another LID.
- A lost connection uses bounded reconnect delays. Saved state survives a restart. A send with an unclear result is not repeated automatically. Pending sends wait while WhatsApp is disconnected.
- Telegram and WhatsApp share the existing conversation, memory, workspace and task sessions. Task starts, progress, questions, confirmations, status, stop replies and results use channel messages.
- Native replies to messages and files select the correct task. Each private code question is bound to its exact request in the same transaction as the question. A closed question cannot fill a later request, including one in the same turn. Files do not approve actions. Private sign-in and payment steps keep their existing private forms.
- Both channels receive images, documents, video, audio and captions. The server checks the sender before it downloads a file. Downloads use fixed provider hosts, reject redirects and have byte and time limits.
- Web audio has an inline player with a locally decoded waveform, play, pause, seek and speed controls. Only one audio player runs at a time. Playback stops when its message unmounts.
- Stickers reach the runtime as conversation messages. Contacts keep their original vCard, with a web preview. Locations have a web card and load OpenStreetMap only after a click. Live-location shares are snapshots. Valid outgoing cards and points use native sends; Telegram sends grouped or oversized cards as files.
- Media sent before model setup usually receives a setup notice before download. A voice message received while a verification request is pending can be downloaded and transcribed first, so its code can reach private entry. Missing speech credentials have a separate setup notice when a model is available.
- A message usually has one file. An animated Telegram sticker can also have an image preview. Album files remain separate messages. Shared intake has safety caps of ten files and 50 MB. Telegram's hosted API limits each incoming file to 20 MB. Voice transcription has a 25 MB limit.
- Files are saved before message acknowledgement. Queued media belongs to its conversation. Reset, channel replacement and shutdown fence or stop pending media. At most four distinct media messages prepare at once; duplicate messages join the same operation. A rollback removes files with no saved row.
- Voice transcripts pass through the existing private verification-code path before normal storage or model use. A voice verification code leaves no audio artifact or raw code in the channel inbox.
- Generated speech uses Ogg/Opus and is sent as a native voice note. Telegram and linked WhatsApp send images, documents, video and audio, with a 50 MB limit per outgoing file. WhatsApp Cloud API mode keeps files in nod and sends a notice to open them there.
- A short reply with one image, video or document uses its native caption. A failed captioned send stays uncertain and is not repeated.
- Both channels use the shared activity model for typing, support reactions and split long replies. WhatsApp converts Markdown to its native text format.
- Speech uses a selected or unique OpenAI API key saved through Models, with server `OPENAI_API_KEY` as an override. A ChatGPT subscription cannot supply speech. Key removal takes effect on later requests. Speech requests use the spending-limit check and the `model_usage` ledger. Transcription usage binds to the actual admitted turn and session, including a native task reply, and counts toward its check-in budget. Reported transcription usage has an API-price estimate. Responses without usage are marked unpriced.
- The existing Meta Cloud API setup remains available. A saved Cloud API choice overrides an environment default for QR mode. Cloud API file and reply-window limits still apply.
- The pinned Signal dependency has a patch that removes direct console calls which could print session keys. A pinned Baileys patch forwards cancellation and redirect refusal to the actual download request. Container builds include both patches. Desktop runtime fingerprints include their bytes.
- A failed key deletion leaves WhatsApp unavailable. An explicit retry can finish deletion without repeating the remote sign-out.

## Verification on 22 October 2026

### Synthetic channel checks

All 181 combined focused checks pass with no skips after the full Cubic review fixes. The checks cover channel intake and delivery, setup, private codes, the thread harness and Pi. They include 64 concurrent duplicates, 32 duplicate replays after restart, four held uploads with refusal of a fifth, rollback cleanup, byte-bounded key batches, foreign self-chat LIDs, exact private-code request binding, speech failures and native captions. A ledger check covers speech usage deduplication and refusal before provider access when the monthly limit is reached.

The fixtures use disposable database schemas and synthetic protocol events. Test processes have an empty environment with an explicit allowlist, read-only source and toolchain, writable scratch space, resource limits and no external network. An internal network reaches only the disposable PostgreSQL fixture. Chromium checks also need a writable temporary home and permission to create its own sandbox. No live model, connected account or real recipient was used.

### UI checks

A real Chromium fixture passed separate-number setup, QR display, recording exclusion, cancellation, self-chat setup and connected-panel closure. Desktop and 390-pixel mobile screenshots were inspected. They show no horizontal overflow. Closing unfinished setup cancels it; closing a connected panel keeps the link.

The [review captures and setup demo](../review/channels/README.md) use the real components and synthetic API responses. They include Telegram owner pairing and confirm that closed WhatsApp setup does not keep polling. No live account is linked.

### Repository checks

`pnpm run check`, `pnpm run build` and `pnpm --dir docs build` pass in bounded offline fixtures. The docs build checks every internal link. The focused desktop check verifies that a change to either dependency patch changes the runtime fingerprint.

The normal GitHub CI fixture passed the full integration suite, desktop contracts, docs and Windows checks at `4f8e81a1`. Later changes fix the full Cubic review findings and private Models speech setup. The PR checks show the result for the current head.

The stricter local offline integration run has 578 checks: 562 passes, 13 failures and three skips. An unchanged-main run at `a8ae5a1b` has 550 passes, the same 13 failures and the same three skips. The 12 failed native browser and download cases also fail on main; the failed parent test adds the thirteenth failure. These fixture results do not prove a channel regression or a live provider connection. A test from main also read a failure notice before its asynchronous save; the merged test now waits for that save before it checks the exact result.

Local reports are kept outside Git. CI results are on PR #423. Synthetic fixtures, UI checks and live checks are separate evidence.

### Live check

Automated checks use no live account, model, speech provider or recipient. The owner has a separate test app for private manual checks. Its profile and content are not test fixtures or PR evidence. The feature must not be described as fully verified until the manual checklist passes with accounts controlled by the owner.

The automated work does not send test messages through the owner's connected accounts. Keep manual results separate from synthetic evidence.

The manual check must cover QR setup in both modes; an image and a voice request; a task question and its native reply; files and a native voice result; restart; network loss; stop; disconnect; and a new link. Use disposable accounts and keep credentials and QR values in the private setup UI.

## Focused security review

The review uses the [Cloudflare security audit skill](https://github.com/cloudflare/security-audit-skill/blob/main/skills/security-audit/SKILL.md) for a scoped standard audit. It covers the changed messaging, setup, speech and key-storage paths. It is a partial audit of Nod. Two hunter waves, two post-wave critics, a distinct final critic, independent candidate checks and fresh final-record checks are complete. Both structured validators pass. See the [findings, fixes and remaining provider check](../review/channels/security.md).

The review found direct Signal console calls that could print keys, a lost native reply target before private-code dispatch and dropped cancellation options in Baileys media downloads. The PR fixes these paths. It also restricts self-chat LIDs to the linked account's own LID. Source review and synthetic checks cover owner and sender boundaries, native reply correlation, private-code handling, provider file addresses, size limits, QR privacy, stale key writes, cancellation and uncertain delivery. Trust, Vault and payment policy are unchanged.

The review does not establish that the unofficial WhatsApp protocol will remain stable, that an account cannot be restricted, or that a live provider accepts every supported file. These points need the manual check and continued maintenance.

## Primary references

- [Hermes WhatsApp channel](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp).
- [OpenClaw WhatsApp channel](https://docs.openclaw.ai/providers/whatsapp).
- [Baileys](https://github.com/WhiskeySockets/Baileys), pinned to `7.0.0-rc14`. Credential and Signal key updates must both be saved.
- [Telegram Bot API](https://core.telegram.org/bots/api), including hosted file limits and native voice messages.
- [OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) and [pricing](https://developers.openai.com/api/docs/pricing).

No native OpenHands WhatsApp implementation has been verified.
