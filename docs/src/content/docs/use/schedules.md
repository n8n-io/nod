---
title: Schedules and background work
description: Ask Nod to do something later or on a regular schedule, and see what it does on its own when new mail or app activity arrives.
sidebar:
  order: 3
---

Ask Nod to do something later or regularly, and it saves a schedule and does the work in the background.

When you ask, Nod also notices new email and activity in your connected apps and prepares useful work on its own. This page covers both.

## Create a schedule

Ask in chat. For example:

- "Every weekday at 8:00, summarize my calendar and anything urgent in my inbox."
- "Tomorrow at 15:00, remind me to call the landlord."

A schedule runs **One time** or is **Recurring**. Nod tells you when it's saved and when it runs next. When you hand Nod work that needs follow-up, it can also plan its own check-in, such as "I'll look for a reply on Friday". Check-ins are schedules too.

Nod uses your time zone, saved from your browser the first time you use Nod. Change it in **Settings → General**. If Nod doesn't know your time zone, it asks.

## Change or cancel a schedule

Open **Tasks → Scheduled**. Each schedule shows its timing and next run.

- Use the switch to pause or resume it.
- Select **See details** to read the instruction or change the timing.
- Select **Ask Nod** to change it in your own words.
- Select **Delete schedule**. Future runs stop, and past runs stay in **Previous**.

You can also tell Nod in chat, for example "stop the morning summary".

## What happens when a schedule runs

```mermaid
flowchart TD
  due[Schedule is due]:::accent --> run[Nod runs it<br/>in the background]
  run --> check[Trust check<br/>against your instruction]
  check --> useful{{Something you asked to get,<br/>a useful result or a question?}}
  useful -- yes --> send[Message in the chat<br/>where you set it up]:::go
  useful -- no --> quiet[Stays quiet]:::muted
```

- **It runs next to your chat.** A schedule doesn't wait for the conversation, and the conversation doesn't wait for it.
- **What you asked to get arrives every time.** A summary, brief or reminder comes on every run. A watch or check-in messages you only when something needs you, such as a real price drop, a problem or a question. Routine checks stay quiet.
- **It replies where you asked.** A schedule you set up on Telegram sends its messages to Telegram.
- **Approvals still apply.** Each action is checked against the instruction that created the schedule. If an action isn't covered, Nod asks you first. See [Approvals](/trust/approvals/).

Each run appears in **Tasks → Previous**. Review its cost and recorded app actions in [Usage](/use/spending/). A recurring schedule that has finished priced runs shows about what it costs a month, from the cost of its recent runs and how often it runs.

## Work Nod starts on its own

Nod reads every app you connect on its own, prepares useful work privately and messages you only when it's worth it. See [Nudges](/use/nudges/). There's nothing to turn on. At any time, you can say what's worth interrupting you for, such as "tell me when a client emails", and Nod uses it to choose what to flag.

How Nod checks:

- **Gmail.** Nod checks for new inbox mail every 15 minutes. Each new message starts a quiet private run that decides whether there's useful work, such as preparing a reply.
- **Google Calendar.** Nod checks for changed events every 30 minutes without a model call.
- **Other connected apps.** Every 30 minutes, one quiet private run reads them through their own read tools.

Work Nod starts on its own reads and drafts. It sends, deletes or changes something only when you've told it to do that on its own, such as "whenever Ana sends an invoice, forward it to accounting@acme.com". Anything else waits for your yes. [Your rules](/trust/approvals/#your-rules) can change both: a rule to go ahead lets an action run without asking, and a rule to ask first makes Nod ask even when your standing instruction covers the action. See [Standing instructions](/trust/approvals/#standing-instructions). To change or stop it, select it in **Usage**, or tell Nod, for example "stop flagging Slack messages".

The private preparation behind nudges can only read, prepare private work and nudge you. It can't send, delete, submit, book, buy or change connected apps. To stop it, tell Nod "Pause preparation".

The first time Nod messages you about something on its own, such as a calendar change, it sends a short second message to say it will keep doing this. When that first message asks you something, the line goes in it, before the question, so a short reply still answers the question. Tell it to stop or to do less at any time. After a one-off job that will come up again, such as this week's top posts or a reply to a client, Nod offers once, in its own message, to keep doing it, unless a schedule already covers it. It sets nothing up until you say yes. When you act on something background work brought you, such as asking Nod to reply, and it will come up again, Nod offers once to do it without asking next time.

## Edit schedule details

Select a schedule title to rename it in place. Timing changes show the next run from the same schedule engine that runs the job. The preview does not change the saved schedule. Save applies the change. Undo restores its previous timing only if no newer change has replaced it. The Undo notice stays available while you hover over it, focus it, or switch away from Nod.

## Quiet hours

Quiet hours are on by default, from 22:00 to 08:00. Change them in **Settings → General → Quiet hours**.

During quiet hours, Nod keeps preparing from new mail and app activity. Its nudges wait until they end, except a high-impact one with strong evidence whose deadline comes first. Any task it starts on its own waits too, with its questions and approvals. Schedules you created still run and deliver on time.

## Keep Nod running

:::caution[The assistant must stay running]
A local desktop assistant runs schedules and background work only while Nod is open and your computer is awake. A [self-hosted server](/deploy/self-host/) keeps running after you close its web or desktop client, provided the server stays awake and connected.
:::

For a local assistant, closing the window keeps Nod running in the menu bar or tray. **Quit Nod** stops it. Turn on **Open at login** in **Settings → General** if you rely on schedules.

If a run comes due while the assistant is stopped, it runs once when Nod is running again.

## Related resources

- [Track tasks](/use/tasks/)
- [Chat with Nod](/use/chat/)
- [Telegram and WhatsApp](/use/channels/)
- [Approvals and the trust check](/trust/approvals/)
- [Connect apps](/connect/apps/)
