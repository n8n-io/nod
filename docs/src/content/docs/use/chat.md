---
title: Chat with Nod
description: Send Nod requests and files, keep talking while it works, stop it and choose the model.
sidebar:
  order: 1
---

Chat is where you give Nod work, answer its questions and get the results.

Nod keeps one ongoing conversation with you. The desktop app, the web app, Telegram and WhatsApp all add to that same conversation, so Nod remembers what you said in any of them.

Nod follows your latest clear message's language, spoken or typed, including questions, confirmations and connection instructions. An explicit language request takes precedence. Only your own messages set it, never your email or other data, and before you've written anything, such as at the start of setup, Nod writes in English. Asking for an email or document in a different language applies to that output; a neutral acknowledgement such as "OK" keeps the preceding language. What Nod reads on websites, in email and in documents comes back translated. It keeps the original wording only in quotes, such as a menu or button name you need to find, with a short translation when the meaning isn't clear. Voice, region, date format and time zone are separate preferences.

## Send a message

Type in the message box and press Enter. Press Shift+Enter for a new line.

You can paste Markdown or formatted text. Chat, feedback and message display use the same CommonMark parser, with GitHub Flavored Markdown support. When you send a message or restore an unsent draft, the serializer preserves the meaning of text and links. Markdown can use escapes for literal characters. These escapes do not change the displayed text or a link's destination. Code stays literal, including text that looks like a link or a code fence.

Use the formatting toolbar to underline text. Pasted `<u>text</u>` also keeps its underline.

- **Attach files.** Select **Attach files**, press Command+U on Mac or Ctrl+U on Windows and Linux while writing a message, paste an image or drop files anywhere in the conversation. Each file stays inside the composer while it uploads. Select it to open the same file viewer used for sent attachments, or retry or remove a failed upload. Each file can be 90 MB or smaller. Nod gets a copy in its [workspace](/use/workspace/). It sees PNG, JPEG and WebP images directly, up to 3.75 MB each and 16 MB per message, unless the model you chose can't read images.
- **Reply to a message.** Hover over a message and select **Reply**, or right-click inside the bubble and select **Reply**. On touch screens, the reply button stays visible. Replies to a whole message show a formatted excerpt in the composer and sent reply. Select it to jump to the original message, then select **Return to where you were** to go back. Use **Message actions** to copy text. To see the time below a bubble, hover over the message, focus one of its controls, or tap its text.

Your unfinished draft stays on this device for your account and conversation. After a reload, Nod restores its text, reply target, and available uploaded files. It checks saved files before you can send them. If a check fails, select **Retry** or remove the file. An interrupted upload needs the original file again. Private entry values and recognized verification replies are excluded. A file that exceeds the limit is rejected individually; other valid files stay attached. Removing an uploaded draft file offers **Undo**.

Unsent files become eligible for cleanup 24 hours after upload or their last successful renewal. Existing unsent uploads get a fresh 24-hour grace period on the first upgrade that adds cleanup. Keeping the draft open renews its files every five minutes. Returning to the app or restoring a draft checks and renews them again. Removed files stop renewing. You can still renew or send a file until cleanup starts deleting it. After that, attach it again from your device. Sent attachments and files Nod publishes are kept.

Select a passage in a message, then **Reply to selection** to quote it. Selected passages keep their exact text, including literal symbols, and stay separate from your own message. Select a reply quote to visit its source. **Return to where you were** restores your reading position. Copy controls on code blocks and tables copy only that block. Table content pastes into spreadsheet cells. Message Copy includes formatted text where the clipboard supports it. **Copy Markdown** copies the source text.

Select **Find in conversation** to search stored messages in the current conversation. Search shows up to 50 recent matches, with highlighted text and each message’s date. Use the arrow keys to move between results and Enter to open a message. Press Command/Ctrl+K outside an editor to open pages, files, and tasks. In the desktop app, Command/Ctrl+F opens conversation search outside an editor.

Action confirmations show the question without extra status labels. [Usage](/use/spending/) shows the recorded action results.

## Send an audio message

Select **Record an audio message** beside the send button and allow microphone access. Select **Send** when you finish. To listen first, select **Preview**. You can discard the recording before sending. Recordings can be up to five minutes long. They stay in this window until you send them and are not restored after a reload.

Use the arrow beside the microphone to choose an input. Nod remembers your choice in this browser. If that microphone is disconnected, Nod uses your system default.

Your message shows the recording and any caption you typed. Nod keeps an internal transcript for private verification and action authorization; the generated transcript is not shown in the message. Models marked **Audio input**, currently **GPT Audio 1.5** through an OpenAI API connection, also receive the actual recording. Text-only models use the transcript. If sending fails, your recording and typed text remain available. A recording that answers a private verification request is handled privately instead of being added to the conversation.

An audio model's **Text support** label shows its companion from the same connection. Requests to the selected model without recordings, including a new text conversation, trust checks and session summaries, use that companion. Background work can still use a smaller model from the same connection. Follow-ups that still include recent recordings use the audio model. Your saved model selection stays unchanged. An audio model is unavailable when its connection has no text companion.

With **Auto**, Nod chooses when a spoken reply helps. Ask it to answer in audio notes to keep a conversation in that format, or ask for text when you prefer reading. Select **Play audio** to listen; replies do not play automatically.

In **Settings → General → Voice**, choose a **Voice provider**, then open **Assistant voice** to compare samples and choose a voice. Set **Spoken replies** to **Auto**, **When I send audio**, **Always**, or **Off**. Auto is the default for new settings; existing choices stay unchanged. Off stops automatic spoken replies, but you can still explicitly request an audio file.

**Automatic** uses the first connected speech service in this order: OpenRouter, OpenAI, ElevenLabs, then downloaded free voices. Multilingual voices follow the reply's language. For voices with a specific language, **Automatic** chooses a matching voice from that service. If the language is unclear or unsupported, it keeps the service's default. Select **Automatic** in the voice picker to restore this behavior. This default can change when your connections or provider's voice list change. To keep a particular voice, choose its provider, then select the voice. Your chat model stays unchanged. Cloud speech uses the provider's credits; a chat subscription alone does not include it.

Native audio keeps the two most recent recording messages available across follow-ups and session compaction. Older recordings remain saved and their transcripts provide conversation context. Each recording is limited to five minutes and 25 MB. Browser recordings are converted to WAV for compatible models; externally uploaded native audio supports WAV, WebM, Ogg and MP3. Audio input uses the selected model's API credits, separately from your chosen spoken-reply voice.

Existing API connections make their voices available automatically. Select a provider to see its connection status. If it isn't connected, sign in to OpenRouter for ElevenLabs and Kokoro voices, or connect ElevenLabs or OpenAI with an API key. OpenRouter doesn't need a separate ElevenLabs key. For local speech, select **Free voices → Download voices**. Setup stays on this page, and your connected chat model stays selected.

A direct ElevenLabs connection brings in voices saved in your account. Give the key Text to Speech, Speech to Text, and Voices read access. Select **Browse voices** to add or create voices on ElevenLabs, then **Refresh voices** to see them in Nod. Saved keys have a **Disconnect** action. Samples and replies use the selected provider’s credits.

ElevenLabs and OpenAI voices are multilingual: they speak the language of the reply. Kokoro voices have a specific language, shown beside their name. Through OpenRouter, Kokoro offers English, Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese and Mandarin Chinese. Choose a specific voice to keep it across replies, or **Automatic** to follow the conversation language. Changing a voice doesn't change the language Nod writes in.

Under **Free voices**, select **Download voices** for a one-time download of about 180 MB, with no account needed. Local replies offer English, Spanish, French, Hindi, Italian and Brazilian Portuguese voices. Downloads need an internet connection; downloaded voices run on the computer hosting nod. Choose a local assistant voice to keep both transcription and replies local, including when you have an API connection. Local speech can take longer on slower computers. A ChatGPT or Claude subscription alone does not include those providers' speech APIs.

## See visual answers

When a visual makes an answer easier to understand, nod can include images, maps, flight comparisons, seat plans, booking summaries, diagrams, or charts.

Each visual stays beside its explanation. References stay in the reply as links. Nod can capture a page it visits and include the screenshot with its answer; select the image to inspect it in the file panel.

When nod suggests apps to connect, it lists up to three below its message, each with a **Connect** button. Connect starts sign-in right there in the chat, the same as the email step in onboarding. If the app list fails to load, select **Try again** below the message. If catalog access is unavailable, select **Open Apps** to see the available connections. In Telegram and WhatsApp, nod names the apps to connect in [Apps](/connect/apps/) instead.

Location cards show numbered markers and a **View map** link for every place. Each link opens OpenStreetMap with that location marked. Select a marker or place to inspect it, then **Load map** to see its street map in chat. Maps load only when you choose. A place's **Source** link opens its supplied reference separately.

Flight comparisons give each option its own numbered card, price and expandable journey. Connection airports, technical stops and supplied stop durations stay visible before you expand it. The details keep each leg of an outbound, return or multi-city journey, with supplied local dates and time zones. Airport changes and self-transfers stay visible. Missing transfer information remains unknown.

Seat plans group the supplied rows by cabin and deck, preserving different layouts, aisles and empty positions. The coverage states whether the source shows the whole aircraft, a cabin or selected rows. Each plan refers to one flight or aircraft configuration. The view is schematic; nod can show the original image when exact geometry matters. Inspecting a seat doesn't reserve it or confirm its availability.

Venue cards can include photos, review summaries with their source rating and review count, and notes such as access or cancellation conditions. Comparisons keep each venue's details together. A proposed booking stays an option until nod has evidence of confirmation.

Charts use bars for comparisons, lines for trends, and pie or donut charts for parts of a whole. Select a category or point to inspect its values.

Telegram and WhatsApp receive the answer and visual details as text, with source links. Locations keep their marked map links. Flight options keep their numbers and separate journey details. Telegram and the WhatsApp QR connection also receive image attachments up to 50 MB each. The WhatsApp Cloud API receives PNG and JPEG images up to 5 MB each. If a file cannot be delivered in the channel, the answer points you back to nod to open it. Interactive visuals stay in nod's chat.

## Listen to audio

Audio attachments play directly in chat. Select **Play audio** to listen, then **Pause audio** to pause. Starting another attachment pauses the previous one.

The waveform shows the sound in the file. Click or drag along it to move backward or forward. With the waveform focused, press the Left or Right arrow key to move five seconds.

Select the speed button to cycle through 1×, 1.25×, 1.5×, 2×, and 0.75×. Select **Download** to save the file.

For large files or formats whose waveform your browser can't read, the player shows a seek track instead. Playback remains available if your browser supports the audio format.

## Keep talking while Nod works

The message box stays open while Nod works. You can send another message at any time. Your sent messages have no receipt or queue labels.

One short status line beside the typing dots shows the current activity, such as "Finding flights back from Copenhagen" or "Comparing flight prices". Nod updates this line when the main activity changes. It describes the task and contains no tool names. Tasks you started show their title beside the status. The line clears when Nod finishes, stops, or waits for your answer.

Nod can send a useful, verified partial result before it finishes. The activity line continues while work remains.

Telegram shows **typing…** and a quoted progress section in your language when its first message [supports live updates](/use/channels/#while-nod-works). A longer chat request has one short opening message there so the activity has a place to update. A saved task uses its existing start message. WhatsApp shows **typing…** without extra progress messages. For Business Cloud connections, typing stops when the 24-hour reply window closes. QR connections have no such limit. These indicators send no notification. See [Message cadence](/how-it-works/agent-runtime/#message-cadence). A file Nod shares is attached to its next answer, or sent on its own when none follows.

Reply to a task's message to continue that task. A message without a reply target goes to the main chat. If it clearly changes an existing task, Nod sends your message to that task. If the target is unclear, Nod asks which task you mean.

Nod keeps quick answers, simple lookups and status questions in chat. It starts a saved task for substantial work, including multi-step work it can finish in one sitting, such as research across sources, checked comparisons or report creation, and for an outside wait, such as a person, a reply or an action elsewhere, or work you ask it to track. You don't choose an execution mode: Nod starts the task itself. A new independent request while other work runs starts its own task, and each task keeps its goal; send a correction or a related update to the existing task by replying to its message. You can discuss other work while a task runs. Updates may wait for the current step to finish. Different tasks can continue in parallel. See [Track tasks](/use/tasks/).

## Notifications

Choose **Enable notifications** after the first introduction, or turn them on in **Settings → General**. **Not now** dismisses the offer. Nod only asks your browser for permission after you choose to enable notifications. If you block the request, allow notifications in the browser’s site settings before trying again.

If your browser resets or blocks permission, the switch turns off. Once your browser allows requests again, turn on **Browser notifications** in **Settings → General** to ask for permission. The switch stays off until permission is granted. Dismissing the request leaves it off; you can try again with the same switch. When enabled, **Send test notification** lets you check delivery.

On desktop, enabling notifications sends a confirmation. If it does not appear, allow Nod in your computer’s notification settings and check Focus or Do Not Disturb.

Notifications use Nod's name and icon. In the web app, they announce a new reply without showing its contents. Keep the Nod tab open to receive them while it is in the background. Select a notification to return to its message. Ordinary browser tabs may also show the browser’s name; the operating system controls that attribution.

The web choice applies to this account in this browser. Turning it off does not revoke the browser’s site permission. Quiet hours apply to web and desktop notifications.

### Notice new messages on macOS

With desktop notifications enabled, Nod's Dock badge shows how many replies you haven't read, up to **99+**. It stays visible after a banner disappears, while the window is closed, and when you reopen Nod. Read the latest messages in Chat to clear it; opening another screen doesn't clear it.

A new reply briefly bounces the Dock icon while Nod is in the background. Quiet hours suppress banners and bouncing, but keep the unread badge. Turning off desktop notifications clears the badge; turning them on restores unread replies.

macOS controls whether badges appear. In **System Settings > Notifications > Nod**, allow notifications and enable **Badge application icon**.

## Answer Nod's questions

When a task needs a decision, an approval or your help in its browser, it asks and waits. Reply to its question to continue the session that asked. Other tasks can keep working. For actions that need a yes or no, see [Approvals](/trust/approvals/).

Nod doesn't ask for passwords or card numbers in chat. It uses a saved login or a private form instead. See [Vault](/trust/vault/).

## Stop Nod

While Nod works, one progress indicator shows the chat's activity and any background tasks.

To stop Nod, select **Stop** next to the send button.

The main Stop control ends active work, cancels queued messages and open questions, and closes all open tasks. To stop only one task, open its preview and select **Stop**. Your schedules stay configured. Stop can't undo something that already happened, such as an email that was already sent.

You can also tell Nod in the main chat, from any app, for example "stop everything" or "stop the flight search". Nod stops every task, scheduled run and app check, or only the task you name, and tells you what it stopped. Nod reads your message after its current step, or after its current reply if you write from another app. For an immediate stop, use the Stop control, or `/stop` in Telegram.

When a run you started stops on an error or on your spending limit, Nod tells you what failed, in the main chat or as a reply to the affected task, with the error's own details, such as low credits or a rejected key with your model provider. Its next turn knows what went wrong. If Nod restarts during a run you started, that run fails and Nod posts an interruption notice. Nod never repeats failed or interrupted work on its own. Saved tasks and waiting questions survive a restart.

If Nod may have sent or changed something, verify the result yourself or ask Nod to inspect it before continuing. Don't make a new attempt while the result is unclear.

## Choose the model

Open the **Settings** page, then **Models** to choose the model Nod uses from your connected providers. See [Models](/connect/models/).

## Desktop shortcuts

In the desktop app, hold Command on a Mac or Ctrl on Windows and Linux to show shortcut hints. Use that key with 1–6 for Chat, Tasks, Apps, Channels, Usage and Vault; B expands or collapses the sidebar, and comma opens Settings. Web browsers keep their own shortcuts.

## React to messages

To react to one of Nod's replies, hover over the bubble and select its reaction icon. Pick a quick reaction, or choose **More emoji** to search and scroll through the full picker. On touch screens, the reaction icon is always visible. Your reaction appears at the bottom of the bubble. Select it to remove it. Nod takes a reaction as feedback on that reply, never as an answer to a question or an approval.

Nod sometimes reacts to your messages too, such as ✅ when you say yes to something it offered or ❤️ when you thank it. It reacts only now and then, and a reaction never replaces its reply.

## Open links in replies

Links to Nod screens open in the current window. A link to **Settings > Models** opens that Settings tab. Close Settings to return to the screen and control you used before. Browser Back and Forward also work.

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

In Telegram and WhatsApp, a screen link opens a public page. Select **Open in Nod** on the computer where Nod is installed. On a phone, use the location on that page to continue in Nod on your computer. The link contains only the screen name. It cannot change settings or approve an action.

You can also ask Nod to change supported settings from any channel. For example, ask it to use a connected model, set quiet hours, change the time zone or clock format, or set a spending limit. Nod uses its tools and reports the saved result. It asks when your request does not identify the target or value. Model sign-in and device settings, such as launch at login, still need the app.

Links stay inline in the reply. Hover over a link, or focus it with the keyboard, to see its full address. Select a link, or press Enter while it is focused, to open its page. Telegram and WhatsApp control their own link previews.

## Replies go back where you wrote

Nod answers each request in the app you sent it from. A message from Telegram gets its reply on Telegram. Everything also appears in the chat in Nod's own app. See [Telegram and WhatsApp](/use/channels/).

## Send feedback

Select **Send feedback** at the top of the chat, choose **Bug**, **Idea** or **Other**, and describe what happened. The dialog names the recipient: the Nod team at n8n by default, or your server operator's configured collector.

After first-time setup, a short invitation points to **Send feedback**. Dismiss it with its close button or press Escape while the invitation or feedback button is focused; it stays dismissed on that device.

**Include diagnostic report** starts selected for every feedback category until you change it. It adds recent messages, tool inputs and results, errors, and app activity to help fix problems and improve Nod. Known secrets and recognized personal details are masked, but redaction can miss information.

Select **Review** to inspect the **Chat**, **Activity** and **Connections** tabs. Tool activity groups each input with its result and status. **Download** saves the same redacted report as a JSON file. Untick the checkbox to leave it out. Nod remembers your choice for your account on this device, including after sending or discarding a draft.

Preparing a report sends recent app activity and errors to your Nod runtime for redaction and assembly. The feedback recipient receives your submission only after you select **Send feedback**. If preparation fails, select **Continue without report**.

In the desktop app, a new draft includes a screenshot of the Nod window when capture is available. Reopening a draft keeps its original screenshot. Nod skips private screens, embedded browsers, open dialogs, and unsent text or files. You can annotate or remove the screenshot. It is separate from the diagnostic report. Your feedback text and attachments are sent as provided.

## Start with an empty chat

Nod has no button for a new conversation in normal use. When you run Nod from source in development mode (`pnpm dev`), **Clear messages** at the top of the chat starts an empty chat and stops its running tasks.

| Starts fresh                                | Stays                                             |
| ------------------------------------------- | ------------------------------------------------- |
| The chat you see and Nod's working context  | Your earlier messages, stored but no longer shown |
| The workspace folder                        | Memory, connected apps and Vault                  |
| The browser, with its temporary downloads   | Saved browser sessions                            |
| Running and queued work, which is cancelled | Task history and schedules                        |

## Related resources

- [Track tasks](/use/tasks/)
- [Schedules and background work](/use/schedules/)
- [Workspace and files](/use/workspace/)
- [Telegram and WhatsApp](/use/channels/)
- [Approvals and the trust check](/trust/approvals/)
