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

You can paste Markdown or formatted text. Chat, feedback and message display use the same CommonMark parser, with GitHub Flavored Markdown support. When you send a message or restore an unsent draft, the serializer preserves the meaning of text and links. Markdown can use escapes for literal characters. These escapes do not change the displayed text or a link's destination. Code stays literal, including text that looks like a link or a code fence.

Use the formatting toolbar to underline text. Pasted `<u>text</u>` also keeps its underline. The old `++text++` shortcut stays literal under CommonMark.

- **Attach files.** Select **Attach files**, paste an image or drop files anywhere in the conversation. Each file stays inside the composer while it uploads. Select it to open the same file viewer used for sent attachments, or retry or remove a failed upload. Each file can be 90 MB or smaller. nod gets a copy in its [workspace](/use/workspace/). It sees PNG, JPEG and WebP images directly, up to 3.75 MB each and 16 MB per message, unless the model you chose can't read images.
- **Reply to a message.** Hover over a message and select its arrow, or right-click inside the bubble, then select **Reply** or **Copy**. On touch screens, use the visible arrow. The time appears in the bottom-right corner of each bubble.

Your unfinished draft stays on this device for your account and conversation. After a reload, nod restores its text, reply target, and available uploaded files. It checks saved files before you can send them. If a check fails, select **Retry** or remove the file. An interrupted upload needs the original file again. Private entry values and recognized verification replies are excluded. A file that exceeds the limit is rejected individually; other valid files stay attached. Removing an uploaded draft file offers **Undo**.

Select a passage in a message, then **Reply to selection** to quote it. The quote stays separate from your own message. Select a reply quote to visit its source. **Return to where you were** restores your reading position. Copy controls on code blocks and tables copy only that block. Table content pastes into spreadsheet cells. Message Copy includes formatted text where the clipboard supports it. **Copy Markdown** copies the source text.

Select **Find in conversation** to search stored messages in the current conversation. Search shows up to 50 recent matches. Select **Commands**, or press Command/Ctrl+K outside an editor, to open pages, files, and tasks. In the desktop app, Command/Ctrl+F opens conversation search outside an editor.

An action confirmation shows its current state beside the question. **Done** means the confirmed action finished. **Outcome unclear** means it failed or stopped after execution started. It can still have changed the target. Check the result before you try again. nod does not repeat it automatically.

## Keep talking while nod works

You don't have to wait. The message box stays open while nod works. For work that takes more than a few seconds, nod says in one line what it will do, then answers. While it works, a bubble from nod at the bottom of the chat shows what it's doing right now, such as "Found two flights under budget, checking seats now", and the answer replaces it. Tasks you started show there too, with their title. In Telegram you see **typing…** and the same line as a live draft, and in WhatsApp **typing…**. None of this sends you a notification; see [Message cadence](/how-it-works/agent-runtime/#message-cadence). A file nod shares is attached to its next answer, or sent on its own when none follows.

Reply to a task's message to continue that task. A message without a reply target goes to the main chat. If it clearly changes an existing task, nod sends your message to that task. If the target is unclear, nod asks which task you mean.

Quick answers, single lookups, brief summaries of supplied content and simple actions stay in the main chat. Substantial work with several steps gets a saved task session, even when it can finish in one sitting. Work that waits on someone or something, runs alongside other jobs, or that you ask nod to track also gets a task. You can discuss other work while a task runs. Updates may wait for the current step to finish. Different tasks can continue in parallel. See [Track tasks](/use/tasks/).

## Answer nod's questions

When a task needs a decision, an approval or your help in its browser, it asks and waits. Reply to its question to continue the session that asked. Other tasks can keep working. For actions that need a yes or no, see [Approvals](/trust/approvals/).

nod doesn't ask for passwords or card numbers in chat. It uses a saved login or a private form instead. See [Vault](/trust/vault/).

## Stop nod

To stop nod, select **Stop** next to the send button.

The main Stop control ends active work, cancels queued messages and open questions, and closes all open tasks. To stop only one task, open its preview and select **Stop**. Your schedules stay configured. Stop can't undo something that already happened, such as an email that was already sent.

You can also tell nod in the main chat, from any app, for example "stop everything" or "stop the flight search". nod stops every task, scheduled run and app check, or only the task you name, and tells you what it stopped. nod reads your message after its current step, or after its current reply if you write from another app. For an immediate stop, use the Stop control, or `/stop` in Telegram.

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

Links to nod screens open in the current window. A link to **Settings > Models** opens that Settings tab. Close Settings to return to the screen and control you used before. Browser Back and Forward also work.

| To see or change                          | Open                                      |
| ----------------------------------------- | ----------------------------------------- |
| Your conversation                         | **Chat** in the sidebar                   |
| Saved tasks                               | **Tasks** in the sidebar                  |
| App connections                           | **Apps** in the sidebar                   |
| Telegram and WhatsApp                     | **Channels** in the sidebar               |
| Spending and activity                     | **Usage** in the sidebar                  |
| Saved logins, cards, and browser sessions | **Vault** in the sidebar                  |
| General preferences                       | **Settings** at the bottom of the sidebar |
| Model connections and selection           | **Settings > Models**                     |
| Saved notes and skills                    | **Settings > Memory**                     |

In Telegram and WhatsApp, a screen link opens a public page. Select **Open in nod** on the computer where nod is installed. On a phone, use the location on that page to continue in nod on your computer. The link contains only the screen name. It cannot change settings or approve an action.

You can also ask nod to change supported settings from any channel. For example, ask it to use a connected model, set quiet hours, change the time zone or clock format, or set a spending limit. nod uses its tools and reports the saved result. It asks when your request does not identify the target or value. Model sign-in and device settings, such as launch at login, still need the app.

Hover over a link in one of nod's replies, or focus it with the keyboard, to see its full address. Select the address to open the page, or press Enter on the focused link. Press Escape to dismiss the address.

Under a reply, nod lists the linked pages that publish a preview image, one row per page, in the order the links appear. Each row keeps the link text as its title and shows the full address as written in the reply. If the link text is just the address, the row uses the public page title when available. Private pages can publish a generic website title, so previews never add it beneath a named link. Hovering or focusing a link highlights its row, and hovering or focusing a row highlights its link. Rows appear as their images load. The first five rows show; select **Show more** for the rest. Links to pages without a preview image get no row, and links nod recognises as sign-in, Vault or payment pages are never previewed.

When a video page offers a player, such as YouTube or Vimeo, select the play button on its row to watch it in the chat. Your browser doesn't load the player until you select play.

nod's server reads the start of each linked page and its image, so your browser doesn't contact the site until you open or play it. Telegram and WhatsApp show their own previews.

## Replies go back where you wrote

nod answers each request in the app you sent it from. A message from Telegram gets its reply on Telegram. Everything also appears in the chat in nod's own app. See [Telegram and WhatsApp](/use/channels/).

## Send feedback

Select **Send feedback** at the top of the chat, choose **Bug or issue**, **Idea** or **Other**, and describe what happened. Feedback goes to the nod team at n8n.

After first-time setup, a short invitation points to **Send feedback**. Dismiss it with its close button or press Escape while the invitation or feedback button is focused; it stays dismissed on that device.

**Include diagnostic report** starts selected for every feedback category. It adds recent messages, tool inputs and results, errors, and app activity to help fix problems and improve nod. Known secrets and recognized personal details are masked, but redaction can miss information.

Select **Review** to inspect the exact report that will be attached. Untick the checkbox to leave it out. Your choice stays with the draft when you close or reload it.

Preparing a report sends recent app activity and errors to your nod runtime for redaction and assembly. The feedback recipient receives your submission only after you select **Send feedback**. If preparation fails, select **Continue without report**.

Screenshots aren't captured automatically. Your feedback text and files you add are sent as provided, so check them for personal information too.

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
