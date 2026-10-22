# WhatsApp and Telegram channels

Status: implemented and under PR review. The owner has deferred the manual live check.

The implementation uses a separate Git worktree.
Branch: `feat/whatsapp-telegram-channels`, with main merged at `543867ea`.
The original checkout is unchanged. The change is under review in PR #423.

## Implemented behavior

- WhatsApp uses Baileys with QR setup, separate bot-number and self-chat modes, status, cancellation, disconnect and a new link.
- Device credentials and Signal keys use encrypted, owner-scoped storage. A new connection refuses stale writes and deletion. Disconnect removes the saved keys.
- QR data is transient. Only the private setup route returns it. The route uses `no-store`, requires local owner access and refuses a foreign origin. Session recordings exclude the setup panel.
- Sender checks reject unrelated people, groups, status messages, old history and self-chat echoes. Phone-number and LID addresses are supported. Self-chat LIDs must match the linked account's own LID, and replies cannot target another LID.
- A lost connection uses bounded reconnect delays. Saved state survives a restart. A send with an unclear result is not repeated automatically. Pending sends wait while WhatsApp is disconnected.
- Telegram and WhatsApp share the existing conversation, memory, workspace and task sessions. Task starts, progress, questions, confirmations, status, stop replies and results use channel messages.
- Native replies to messages and files select the correct task. Files do not approve actions. Private sign-in and payment steps keep their existing private forms.
- Both channels receive images, documents, video, audio and captions. The server checks the sender before it downloads a file. Downloads use fixed provider hosts, reject redirects and have byte and time limits.
- Incoming messages accept at most ten files with a combined limit of 50 MB. Telegram's hosted API limits each incoming file to 20 MB. Voice transcription has a 25 MB limit.
- Files are saved before message acknowledgement. Queued media belongs to its conversation. Reset, channel replacement and shutdown fence or stop pending media. At most four distinct media messages prepare at once; duplicate messages join the same operation. A rollback removes files with no saved row.
- Voice transcripts pass through the existing private verification-code path before normal storage or model use. A voice verification code leaves no audio artifact or raw code in the channel inbox.
- Generated speech uses Ogg/Opus and is sent as a native voice note. Telegram and linked WhatsApp send images, documents, video and audio, with a 50 MB limit per outgoing file. WhatsApp Cloud API mode keeps files in nod and sends a notice to open them there.
- A short reply with one image, video or document uses its native caption. A failed captioned send stays uncertain and is not repeated.
- Both channels show typing, support reactions and split long replies. WhatsApp converts Markdown to its native text format.
- Speech requests use the spending-limit check and the `model_usage` ledger. Reported transcription usage has an API-price estimate. Responses without usage are marked unpriced.
- The existing Meta Cloud API setup remains available. A saved Cloud API choice overrides an environment default for QR mode. Cloud API file and reply-window limits still apply.
- The pinned Signal dependency has a patch that removes direct console calls which could print session keys. A pinned Baileys patch forwards cancellation and redirect refusal to the actual download request. Container builds include both patches. Desktop runtime fingerprints include their bytes.
- A failed key deletion leaves WhatsApp unavailable. An explicit retry can finish deletion without repeating the remote sign-out.

## Verification on 22 October 2026

### Synthetic channel checks

The PR review run passed 41 focused tests with no skips. It uses the channel, delivery, application and private-code suites. It covers 64 concurrent duplicates, 32 duplicate replays after restart, four held uploads with refusal of a fifth, rollback cleanup, byte-bounded key batches, foreign self-chat LIDs, closed native code replies, speech failures and native captions. A separate earlier run passed 31 channel and browser-download tests with no skips.
A separate run of the channel and approval checks passed 64 tests with no skips before the added WhatsApp task-command case.
The ledger integration check also passed, including speech usage deduplication and refusal before provider access when the monthly limit is reached.

The fixtures use disposable database schemas and synthetic protocol events. Test processes have an empty environment with an explicit allowlist, read-only source and toolchain, writable scratch space, resource limits and no external network. An internal network reaches only the disposable PostgreSQL fixture. Chromium checks also need a writable temporary home and permission to create its own sandbox. No live model, connected account or real recipient was used.

### UI checks

A real Chromium fixture passed separate-number setup, QR display, recording exclusion, cancellation, self-chat setup and connected-panel closure. Desktop and 390-pixel mobile screenshots were inspected. They show no horizontal overflow. Closing unfinished setup cancels it; closing a connected panel keeps the link.

The [review captures and setup demo](../review/channels/README.md) use the real components and synthetic API responses. They include Telegram owner pairing and confirm that closed WhatsApp setup does not keep polling. No live account is linked.

### Repository checks

The final `pnpm run check`, `pnpm run build` and `pnpm --dir docs build` passed. The docs build checked every internal link. The final focused checks passed after the caption and disconnect changes.

The complete integration run finished with 571 passes, three failures and no skips. All three failures also occur on the original branch: shell command rewriting, the sealed CLI environment and sealed CLI downloads. One tries to fetch the synthetic `fixturecli` package; the test network blocks that request. The browser, Trust, channel, scheduling and owner-isolation checks pass. The full fixture uses an init process, a temporary home and a limit of 4096 processes and threads, which Chromium needs. Earlier runs with a smaller limit had fixture failures.

Desktop tests finished with 175 passes, six failures and two platform skips. All six release-fixture failures also occur on the original branch. The production dependency, packaged-engine and runtime-fingerprint checks pass. A regression check verifies that a change to the Signal patch changes the runtime fingerprint.

Logs are in `.local/channel-*.log`, outside Git. Fixture failures are not live-channel evidence.

### Live check

No WhatsApp or Telegram account has been linked for this work. No live voice provider has been called. The feature must not be described as fully working until a manual check passes with accounts controlled by the owner.

The owner chose to keep live verification pending. Do not connect an account or run a live check without a new instruction.

The manual check must cover QR setup in both modes; an image and a voice request; a task question and its native reply; files and a native voice result; restart; network loss; stop; disconnect; and a new link. Use disposable accounts and keep credentials and QR values in the private setup UI.

## Focused security review

The review uses the [Cloudflare security audit skill](https://github.com/cloudflare/security-audit-skill/blob/main/skills/security-audit/SKILL.md) for a scoped standard audit. It covers the changed messaging, setup, speech and key-storage paths. It is a partial audit of Nod. Independent finding and final-record checks are in progress.

The review found direct Signal console calls that could print keys, a lost native reply target before private-code dispatch and dropped cancellation options in Baileys media downloads. The PR fixes these paths. It also restricts self-chat LIDs to the linked account's own LID. Source review and synthetic checks cover owner and sender boundaries, native reply correlation, private-code handling, provider file addresses, size limits, QR privacy, stale key writes, cancellation and uncertain delivery. Trust, Vault and payment policy are unchanged.

The review does not establish that the unofficial WhatsApp protocol will remain stable, that an account cannot be restricted, or that a live provider accepts every supported file. These points need the manual check and continued maintenance.

## Primary references

- [Hermes WhatsApp channel](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp).
- [OpenClaw WhatsApp channel](https://docs.openclaw.ai/providers/whatsapp).
- [Baileys](https://github.com/WhiskeySockets/Baileys), pinned to `7.0.0-rc14`. Credential and Signal key updates must both be saved.
- [Telegram Bot API](https://core.telegram.org/bots/api), including hosted file limits and native voice messages.
- [OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) and [pricing](https://developers.openai.com/api/docs/pricing).

No native OpenHands WhatsApp implementation has been verified.
