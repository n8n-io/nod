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

A schedule runs **One time** or is **Recurring**. Nod tells you when it's saved and when it runs next. If you ask for a schedule that's already active with the same name or instruction, time and chat, Nod keeps the one you have instead of adding a copy. When you hand Nod work that needs follow-up, it can also plan its own check-in, such as "I'll look for a reply on Friday". Check-ins are schedules too.

Nod uses your time zone, saved from your browser the first time you use Nod. Change it in **Settings → General**. If Nod doesn't know your time zone, it asks.

## Change, pause or delete a schedule

Open **Scheduled**. Select **New schedule** to start a conversation with Nod, which asks one question at a time about what to do and when. Existing schedules show their timing and next run.

- Use the switch to pause or resume it.
- Select **See details** to read the instruction, any saved baseline, and that schedule's runs.
- Select **Edit schedule** to change its name, instructions or timing.
- Select **Ask Nod** to change it in your own words.
- Select **Delete schedule**. Future runs stop, and past activity stays in [Usage](/use/spending/).

Pausing or deleting a schedule here removes any unanswered request to change or cancel it from Nod's chat. A request already sent to Telegram or WhatsApp remains there, but replying to it cannot change the schedule.

In chat, "stop the morning summary" asks Nod to pause the schedule. If Nod asks for confirmation, it stays active until you approve. Once paused, you can resume it in **Scheduled**; use **Delete schedule** to remove it.

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
- **A failed run tells you.** If a run stops on an error, Nod sends a short message that names the schedule and says what stopped it, so a missing summary never goes unnoticed.
- **It replies where you asked.** A schedule you set up on Telegram sends its messages to Telegram.
- **Approvals still apply.** Each action is checked against the instruction that created the schedule. If an action isn't covered, Nod asks you first, naming the schedule and what it's for. If the check itself can't decide, the action doesn't run and you aren't asked. See [Approvals](/trust/approvals/).
- **One run at a time.** While a run is still queued, working or waiting for your answer, a recurring schedule skips its next runs, so it doesn't ask you again while a question is open. A run does its work itself and can't set up more schedules.
- **Watches skip unchanged runs.** When a recurring check can only find something new after a change in your connected accounts, such as waiting for a reply, Nod saves which accounts it watches. Before each run, Nod checks those accounts for new mail, changed events or app activity without a model call, and skips the run when nothing changed since the last finished run. The first run, and the run after a failed one, always run. Reminders, digests, websites and checks tied to a time don't skip.

Open a schedule's **See details** to read its runs, newest first. Select **Load earlier runs** for older results. Completed one-time schedules remain under **Inactive**, with their runs available to review.

Each run shows its status. When a saved web reply is available, select **See details** on the result to read it within the schedule. Runs with complete API pricing also show their recorded cost. Subscription usage and runs with unavailable pricing show no cost amount. Review recorded app actions and activity from deleted schedules in [Usage](/use/spending/).

## Work Nod starts on its own

Nod reads every app you connect on its own, prepares useful work privately and messages you only when it's worth it. See [Nudges](/use/nudges/). There's nothing to turn on. At any time, you can say what's worth interrupting you for, such as "tell me when a client emails", and Nod uses it to choose what to flag.

How Nod checks:

- **Gmail.** Nod checks for new inbox mail every 15 minutes. Each new message starts a quiet private run that decides whether there's useful work, such as preparing a reply.
- **Google Calendar.** Nod checks for changed events every 30 minutes without a model call.
- **Other connected apps.** Every 30 minutes, one quiet private run reads them through their own read tools.

Work Nod starts on its own reads and drafts. It sends, deletes or changes something only when you've told it to do that on its own, such as "whenever Ana sends an invoice, forward it to accounting@acme.com". Anything else waits for your yes. [Your rules](/trust/approvals/#your-rules) can change both: a rule to go ahead lets an action run without asking, and a rule to ask first makes Nod ask even when your standing instruction covers the action. See [Standing instructions](/trust/approvals/#standing-instructions). To change or stop it, tell Nod, for example "stop flagging Slack messages".

The private preparation behind nudges can only read, prepare private work and nudge you. It can't send, delete, submit, book, buy or change connected apps. To stop it, tell Nod "Pause preparation".

The first time Nod messages you about something on its own, such as a calendar change, it sends a short second message to say it will keep doing this. When that first message asks you something, the line goes in it, before the question, so a short reply still answers the question. Tell it to stop or to do less at any time. After a one-off job that will come up again, such as this week's top posts or a reply to a client, Nod offers once, in its own message, to keep doing it, unless a schedule already covers it. It sets nothing up until you say yes. When you act on something background work brought you, such as asking Nod to reply, and it will come up again, Nod offers once to do it without asking next time.

## Edit schedule details

Select **Edit schedule** to review its name, instructions and timing together. Timing changes preview the next run without changing the saved schedule. **Save changes** applies only the fields you changed, so renaming a schedule keeps its next run. **Cancel** closes the editor without saving.

**Undo** restores the previous values only if no newer change has replaced them. The Undo notice stays available while you hover over it, focus it, or switch away from Nod. If the schedule changes while you edit, your draft stays open so you can review it.

## Quiet hours

Quiet hours are on by default, from 22:00 to 08:00. Change them in **Settings → Notifications → Quiet hours**.

During quiet hours, Nod keeps checking new mail and app activity, but prepares only what may need you before quiet hours end; everything else waits until they end. Its nudges wait until they end, except a high-impact one with strong evidence whose deadline comes first. Any task it starts on its own waits too, with its questions and approvals. Schedules you created still run and deliver on time.

## Keep Nod running

:::caution[The assistant must stay running]
A local desktop assistant runs schedules and background work only while Nod is open and your computer is awake. A [self-hosted server](/deploy/self-host/) keeps running after you close its web or desktop client, provided the server stays awake and connected.
:::

For a local assistant, closing the window keeps Nod running in the menu bar or tray. **Quit Nod** stops it. **Open at login** is on after setup; keep it on in **Settings → General** if you rely on schedules.

If a run comes due while the assistant is stopped, it runs once when Nod is running again.

## Related resources

- [Track tasks](/use/tasks/)
- [Chat with Nod](/use/chat/)
- [Telegram and WhatsApp](/use/channels/)
- [Approvals and the trust check](/trust/approvals/)
- [Connect apps](/connect/apps/)
