# WhatsApp and Telegram review

PR: [n8n-io/nod#423](https://github.com/n8n-io/nod/pull/423).

See the [security review and finite load checks](security.md).

## Setup demo

![Synthetic channel setup demo](channels-demo.gif)

[Download the MP4 demo](channels-demo.mp4).

The demo uses the real setup components with synthetic API responses. No account is linked. All names, numbers, tokens and QR data are synthetic. The demo proves setup rendering and interaction only. It does not prove a live provider connection or message delivery.

| Screen              | Capture                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Channels            | [Overview](channels-overview.png)                                                                                                               |
| WhatsApp bot number | [Setup](whatsapp-bot-setup.png), [QR](whatsapp-qr.png), [connected](whatsapp-connected.png)                                                     |
| WhatsApp self-chat  | [Mobile setup](whatsapp-self-mobile.png)                                                                                                        |
| Telegram            | [Create bot](telegram-create-bot.png), [pair](telegram-pairing.png), [confirm owner](telegram-confirm.png), [connected](telegram-connected.png) |

The Chromium fixture checks both WhatsApp modes, Telegram owner confirmation, cancellation, QR recording exclusion and no WhatsApp status requests after the setup panel closes. The mobile capture uses a 390-pixel viewport.

## Manual live check

Live verification is pending at the owner's request. Use accounts that you control and disposable test content. Keep tokens and QR codes in the private setup UI. Do not attach them to the PR.

1. Start this branch with a disposable database and data root. Follow the [source setup](../../src/content/docs/get-started/install-from-source.mdx) and [channel setup](../../src/content/docs/use/channels.mdx). Use the source setup page's current commands. Set the server's `OPENAI_API_KEY` only if you will check voice transcription and generation.
2. In **Channels**, connect Telegram. Create a bot with BotFather, enter its token in the private panel, press **Start** in Telegram, then confirm your account in nod. Check that a different Telegram account cannot start work.
3. Connect WhatsApp with a separate bot number. Register that number in WhatsApp first. Enter your personal number in nod, then scan the QR from the bot account's **Linked Devices** page. Check that your personal number can start work and another number cannot.
4. Repeat WhatsApp setup with **Use my own number**. Send a request in **Message yourself**. Check that an outgoing message in another direct chat does not start a nod turn or receive a nod reply. Check that nod's own reply causes no loop.
5. For each channel, send text, an image with a caption, a document, a video and a voice note. Check the shared web conversation and returned files. Ask for a voice reply and check that it arrives as a native voice note.
6. Start two tasks. Answer each task's question with a native reply to its message or file. Check `/tasks`, `/status` and `/stop`. A reply to one task must continue only that task. A file, voice note or reaction must not approve an action.
7. With a disposable sign-in, answer the current code question by native reply. Check that the raw code and source voice note do not enter normal chat storage. A reply to a closed sign-in question must not fill another pending sign-in.
8. Restart nod. Check that the WhatsApp link returns. Interrupt the network, restore it, then check a new message. Stop work during an upload. Check that stopped work does not save a late file or send a late result. An uncertain send must not repeat automatically.
9. Disconnect WhatsApp, confirm that its saved keys are removed, then make a new link. Close unfinished setup and check that its old QR cannot finish setup. Check Telegram disconnect and reconnect.

Record the platform, provider mode, results and any error. Keep private content out of screenshots. The Meta Cloud API remains a separate text path with its existing reply window and file notice.
