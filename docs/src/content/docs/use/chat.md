---
title: Chat with Otto
description: Send Otto requests and files, keep talking while it works, stop it and choose the model.
sidebar:
  order: 1
---

Chat is where you give Otto work, answer its questions and get the results.

Otto keeps one ongoing conversation with you. The desktop app, the web app, Telegram and WhatsApp all add to that same conversation, so Otto remembers what you said in any of them.

Otto follows your conversation language, including questions, confirmations and connection instructions. You can request another language at any point. Asking for an email or document in a different language applies to that output; a short acknowledgement keeps the conversation's language. Region, date format and time zone are separate preferences.

## Send a message

Type in the message box and press Enter. Press Shift+Enter for a new line.

- **Attach files.** Select **Attach files**, paste an image or drop files on the box. Each file can be 90 MB or smaller. Otto gets a copy in its [workspace](/use/workspace/). It sees PNG, JPEG and WebP images directly, up to 3.75 MB each and 16 MB per message, unless the model you chose can't read images.
- **Reply to a message.** Select **Reply** under a message to point Otto at it. Under each message you'll find its time, any reaction, and **Reply**, **Copy** and **React**. The controls stay light until you hover over, select or focus the message. On a long message they stay at the bottom of the window while you scroll.

## Keep talking while Otto works

You don't have to wait. The message box stays open while Otto works. For work that takes more than a few seconds, Otto says in one line what it will do, works without narrating, then answers. If you'd otherwise hear nothing for a while (half a minute in Otto web, a few minutes in chat apps), it sends one short line on what it found and what's next. A file Otto shares is attached to its next answer, or sent on its own when none follows.

Reply to a task's message to continue that task. A message without a reply target goes to the main chat. If it clearly changes an existing task, Otto sends your message to that task. If the target is unclear, Otto asks which task you mean.

Otto does work it can finish now in the main chat, even when it takes several steps, such as reading your inbox and drafting replies. Work that has to outlive its answer gets a saved task session: it waits on someone or something, runs for a long stretch, or runs alongside other jobs. You can discuss other work while a task runs. Updates may wait for the current step to finish. Different tasks can continue in parallel. See [Track tasks](/use/tasks/).

## Answer Otto's questions

When a task needs a decision, an approval or your help in its browser, it asks and waits. Reply to its question to continue the session that asked. Other tasks can keep working. For actions that need a yes or no, see [Approvals](/trust/approvals/).

Otto doesn't ask for passwords or card numbers in chat. It uses a saved login or a private form instead. See [Vault](/trust/vault/).

## Stop Otto

To stop Otto, select **Stop** next to the send button.

The main Stop control ends active work, cancels queued messages and open questions, and closes all open tasks. To stop only one task, open its preview and select **Stop**. Your schedules stay configured. Stop can't undo something that already happened, such as an email that was already sent.

Otto never repeats interrupted work on its own. If it restarts during a run, that run fails. When the model is available, Otto posts an interruption notice in the main chat or as a reply to the affected task. Saved tasks and waiting questions survive a restart.

If Otto may have sent or changed something, verify the result yourself or ask Otto to inspect it before continuing. Don't make a new attempt while the result is unclear.

## Choose the model

The model picker above the message box shows the model Otto uses. Select it to choose another model from your connected providers. See [Models](/connect/models/).

## React to messages

To react to one of Otto's replies, double-click it to add 👍, or select **React** under it and pick an emoji. Your reaction appears under the reply, next to its time. Select it to remove it. Otto takes a reaction as feedback on that reply, never as an answer to a question or an approval.

Otto sometimes reacts to your messages too, such as ✅ when you say yes to something it offered or ❤️ when you thank it. It reacts only now and then, and a reaction never replaces its reply.

## Open links in replies

Hover over a link in one of Otto's replies, or focus it with the keyboard, to see its full address. Select the address to open the page, or press Enter on the focused link. Press Escape to dismiss the address.

Under a reply, Otto lists the linked pages that publish a preview image, one row per page, in the order the links appear. Each row shows the link text, the page title when the page has one, and the full address as written in the reply. Hovering or focusing a link highlights its row, and hovering or focusing a row highlights its link. Rows appear as their images load. The first five rows show; select **Show more** for the rest. Links to pages without a preview image get no row, and links Otto recognises as sign-in, Vault or payment pages are never previewed.

When a video page offers a player, such as YouTube or Vimeo, select the play button on its row to watch it in the chat. Your browser doesn't load the player until you select play.

Otto's server reads the start of each linked page and its image, so your browser doesn't contact the site until you open or play it. Telegram and WhatsApp show their own previews.

## Replies go back where you wrote

Otto answers each request in the app you sent it from. A message from Telegram gets its reply on Telegram. Everything also appears in the chat in Otto's own app. See [Telegram and WhatsApp](/use/channels/).

## Send feedback

Select **Send feedback** at the top of the chat, choose **Bug or issue**, **Idea** or **Other**, and describe what happened. Feedback goes to the Otto team at n8n.

By default it includes a diagnostic report of your recent chat, actions and their results. Select **Review** to see the report, or clear **Include diagnostic report** before you send.

## Start with an empty chat

Otto has no button for a new conversation in normal use. When you run Otto from source in development mode (`pnpm dev`), **Clear messages** at the top of the chat starts an empty chat and stops its running tasks.

| Starts fresh                                | Stays                                             |
| ------------------------------------------- | ------------------------------------------------- |
| The chat you see and Otto's working context | Your earlier messages, stored but no longer shown |
| The workspace folder                        | Memory, connected apps and Vault                  |
| The browser, with its temporary downloads   | Saved browser sessions                            |
| Running and queued work, which is cancelled | Task history and schedules                        |

## Related resources

- [Track tasks](/use/tasks/)
- [Schedules and background work](/use/schedules/)
- [Workspace and files](/use/workspace/)
- [Telegram and WhatsApp](/use/channels/)
- [Approvals and the trust check](/trust/approvals/)
