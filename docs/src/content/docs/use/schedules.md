---
title: Schedules and background work
description: Ask Otto to do something later or on a regular schedule, and see what it does on its own when new mail or app activity arrives.
sidebar:
  order: 3
---

Ask Otto to do something later or regularly, and it saves a schedule and does the work in the background.

Otto also notices new email and activity in your connected apps and prepares useful work on its own. This page covers both.

## Create a schedule

Ask in chat. For example:

- "Every weekday at 8:00, summarize my calendar and anything urgent in my inbox."
- "Tomorrow at 15:00, remind me to call the landlord."

A schedule runs **One time** or is **Recurring**. Otto tells you when it's saved and when it runs next. When you hand Otto work that needs follow-up, it can also plan its own check-in, such as "I'll look for a reply on Friday". Check-ins are schedules too.

Otto uses your time zone, saved from your browser the first time you use Otto. Change it in **Settings → Preferences**. If Otto doesn't know your time zone, it asks.

## Change or cancel a schedule

Open **Tasks → Scheduled**. Each schedule shows its timing and next run.

- Use the switch to pause or resume it.
- Select **See details** to read the instruction or change the timing.
- Select **Ask Otto** to change it in your own words.
- Select **Delete schedule**. Future runs stop, and past runs stay in **Previous**.

You can also tell Otto in chat, for example "stop the morning summary".

## What happens when a schedule runs

```mermaid
flowchart TD
  due[Schedule is due]:::accent --> run[Otto runs it<br/>in the background]
  run --> check[Trust check<br/>against your instruction]
  check --> useful{{Useful result<br/>or question?}}
  useful -- yes --> send[Message in the chat<br/>where you set it up]:::go
  useful -- no --> quiet[Stays quiet]:::muted
```

- **It runs next to your chat.** A schedule doesn't wait for the conversation, and the conversation doesn't wait for it.
- **It only messages you when it matters.** That means a useful result, a problem or a question. Routine checks stay quiet.
- **It replies where you asked.** A schedule you set up on Telegram sends its messages to Telegram.
- **Approvals still apply.** Each action is checked against the instruction that created the schedule. If an action isn't covered, Otto asks you first. See [Approvals](/trust/approvals/).

Each run appears in **Tasks → Previous**.

## Work Otto starts on its own

You don't need a schedule for Otto to keep an eye on things.

- **Gmail.** Otto checks for new inbox mail every five minutes. It reads a new message and decides whether there's useful work, such as preparing a reply.
- **Other connected apps.** When you've told Otto what's worth interrupting you for, it looks at each update in a quiet background run and decides whether there's useful work; otherwise it only saves the update. For an app without updates, it runs a short read-only check, at most every 30 minutes per account.

Work Otto starts on its own only reads and drafts. Sending, deleting or anything else waits for your yes. Tell Otto what's worth interrupting you for, and it follows that.

## Quiet hours

Quiet hours are on by default, from 22:00 to 08:00. Change them in **Settings → Preferences → Quiet hours**.

During quiet hours, Otto keeps working on new mail and app activity, but messages you only for something that can't wait until they end. Schedules you created still run and deliver on time.

## Keep Otto running

:::caution[Runs need Otto open]
On the desktop app, schedules and background work run only while Otto is open and your computer is awake. Closing the window keeps Otto running in the menu bar or tray. **Quit Otto** stops it. Turn on **Open at login** in **Settings → General** if you rely on schedules.
:::

If a run comes due while Otto is closed, it runs once when Otto is running again.

## Related resources

- [Track tasks](/use/tasks/)
- [Chat with Otto](/use/chat/)
- [Telegram and WhatsApp](/use/channels/)
- [Approvals and the trust check](/trust/approvals/)
- [Connect apps](/connect/apps/)
