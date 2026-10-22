---
title: Chat with nod
description: Send nod requests and files, keep talking while it works, stop it and choose the model.
sidebar:
  order: 1
---

Chat is where you give nod work, answer its questions and get the results.

nod keeps one ongoing conversation with you. The desktop app, the web app, Telegram and WhatsApp all add to that same conversation, so nod remembers what you said in any of them.

nod follows your conversation language, including questions, confirmations and connection instructions. Only your own messages set it, never your email or other data, and before you've written anything, such as at the start of setup, nod writes in English. You can request another language at any point. Asking for an email or document in a different language applies to that output; a short acknowledgement keeps the conversation's language. Region, date format and time zone are separate preferences.

## Send a message

Type in the message box and press Enter. Press Shift+Enter for a new line.

- **Attach files.** Select **Attach files**, paste an image or drop files on the box. Each file stays inside the composer while it uploads. Select it to open the same file viewer used for sent attachments, or retry or remove a failed upload. Each file can be 90 MB or smaller. nod gets a copy in its [workspace](/use/workspace/). It sees PNG, JPEG and WebP images directly, up to 3.75 MB each and 16 MB per message, unless the model you chose can't read images.
- **Reply to a message.** Hover over a message and select its arrow, or right-click inside the bubble, then select **Reply** or **Copy**. On touch screens, use the visible arrow. The time appears in the bottom-right corner of each bubble.

## Keep talking while nod works

You don't have to wait. The message box stays open while nod works. For work that takes more than a few seconds, nod says in one line what it will do, then answers. While it works, a bubble from nod at the bottom of the chat shows what it's doing right now, such as "Found two flights under budget, checking seats now", and the answer replaces it. Tasks you started show there too, with their title. In Telegram you see **typing…** and the same line as a live draft, and in WhatsApp **typing…**. None of this sends you a notification; see [Message cadence](/how-it-works/agent-runtime/#message-cadence). A file nod shares is attached to its next answer, or sent on its own when none follows.

Reply to a task's message to continue that task. A message without a reply target goes to the main chat. If it clearly changes an existing task, nod sends your message to that task. If the target is unclear, nod asks which task you mean.

nod does work it can finish now in the main chat, even when it takes several steps, such as reading your inbox and drafting replies. Work that has to outlive its answer gets a saved task session: it waits on someone or something, runs for a long stretch, or runs alongside other jobs. You can discuss other work while a task runs. Updates may wait for the current step to finish. Different tasks can continue in parallel. See [Track tasks](/use/tasks/).

## Answer nod's questions

When a task needs a decision, an approval or your help in its browser, it asks and waits. Reply to its question to continue the session that asked. Other tasks can keep working. For actions that need a yes or no, see [Approvals](/trust/approvals/).

nod doesn't ask for passwords or card numbers in chat. It uses a saved login or a private form instead. See [Vault](/trust/vault/).

## Stop nod

To stop nod, select **Stop** next to the send button.

The main Stop control ends active work, cancels queued messages and open questions, and closes all open tasks. To stop only one task, open its preview and select **Stop**. Your schedules stay configured. Stop can't undo something that already happened, such as an email that was already sent.

When a run you started stops on an error or on your spending limit, nod tells you what failed, in the main chat or as a reply to the affected task, with the error's own details, such as low credits or a rejected key with your model provider. Its next turn knows what went wrong. If nod restarts during a run you started, that run fails and nod posts an interruption notice. nod never repeats failed or interrupted work on its own. Saved tasks and waiting questions survive a restart.

If nod may have sent or changed something, verify the result yourself or ask nod to inspect it before continuing. Don't make a new attempt while the result is unclear.

## Choose the model

Open the **Settings** page, then **Models** to choose the model nod uses from your connected providers. See [Models](/connect/models/).

## Desktop shortcuts

In the desktop app, hold Command on a Mac or Ctrl on Windows and Linux to show shortcut hints. Use that key with 1–6 for Chat, Tasks, Apps, Channels, Usage and Vault; B expands or collapses the sidebar, and comma opens Settings. Web browsers keep their own shortcuts.

## React to messages

To react to one of nod's replies, hover over the bubble and select its reaction icon. Pick a quick reaction, or choose **More emoji** to search and scroll through the full picker. On touch screens, the reaction icon is always visible. Your reaction appears at the bottom of the bubble. Select it to remove it. nod takes a reaction as feedback on that reply, never as an answer to a question or an approval.

nod sometimes reacts to your messages too, such as ✅ when you say yes to something it offered or ❤️ when you thank it. It reacts only now and then, and a reaction never replaces its reply.

## Open links in replies

Hover over a link in one of nod's replies, or focus it with the keyboard, to see its full address. Select the address to open the page, or press Enter on the focused link. Press Escape to dismiss the address.

Under a reply, nod lists the linked pages that publish a preview image, one row per page, in the order the links appear. Each row shows the link text, the page title when the page has one, and the full address as written in the reply. Hovering or focusing a link highlights its row, and hovering or focusing a row highlights its link. Rows appear as their images load. The first five rows show; select **Show more** for the rest. Links to pages without a preview image get no row, and links nod recognises as sign-in, Vault or payment pages are never previewed.

When a video page offers a player, such as YouTube or Vimeo, select the play button on its row to watch it in the chat. Your browser doesn't load the player until you select play.

nod's server reads the start of each linked page and its image, so your browser doesn't contact the site until you open or play it. Telegram and WhatsApp show their own previews.

## Replies go back where you wrote

nod answers each request in the app you sent it from. A message from Telegram gets its reply on Telegram. Everything also appears in the chat in nod's own app. See [Telegram and WhatsApp](/use/channels/).

## Send feedback

Select **Send feedback** at the top of the chat, choose **Bug or issue**, **Idea** or **Other**, and describe what happened. Feedback goes to the nod team at n8n.

After first-time setup, a short invitation points to **Send feedback**. Dismiss it with its close button or press Escape while the invitation or feedback button is focused; it stays dismissed on that device.

To help the team investigate, tick **Include diagnostic report** to add your recent chat, actions and their results. It's off by default. nod removes known secrets and the personal details it recognizes, but can miss others, such as another person's name in a sentence. Select **Review** to see the report before you send.

## Start with an empty chat

nod has no button for a new conversation in normal use. When you run nod from source in development mode (`pnpm dev`), **Clear messages** at the top of the chat starts an empty chat and stops its running tasks.

| Starts fresh                                | Stays                                             |
| ------------------------------------------- | ------------------------------------------------- |
| The chat you see and nod's working context  | Your earlier messages, stored but no longer shown |
| The workspace folder                        | Memory, connected apps and Vault                  |
| The browser, with its temporary downloads   | Saved browser sessions                            |
| Running and queued work, which is cancelled | Task history and schedules                        |

## Related resources

- [Track tasks](/use/tasks/)
- [Schedules and background work](/use/schedules/)
- [Workspace and files](/use/workspace/)
- [Telegram and WhatsApp](/use/channels/)
- [Approvals and the trust check](/trust/approvals/)
