---
title: Nudges
description: How nod messages you about work it prepared on its own, and how you answer in your own words.
sidebar:
  order: 4
---

A nudge is a normal chat message from nod about something it noticed and already prepared. It arrives in your nod chat, and in Telegram or WhatsApp if you connected them. There's no separate screen. You answer in words.

Connect a supported source and nod starts preparing useful work on its own. It messages you only when that work is worth an interruption.

## What a nudge looks like

> Your Juniper Tools statement lists an unused EUR 480 credit. I drafted an enquiry to use it or get a refund. Want to see it?

The full draft waits with nod until you ask for it:

```text
Subject: Unused credit CM-731 for invoice INV-3842

Hello Juniper Tools team,

Your statement lists an unused credit of EUR 480 for invoice
INV-3842. My customer reference is CUST-9H2, and the credit
reference is CM-731.

Please confirm whether this balance is still available and how
I can apply it to a future invoice or request a refund.

Thank you,
Alex
```

nod also tells you what it couldn't confirm, here the current balance and the supplier's terms. The draft never claims a refund right or a payment that hasn't happened.

## Answer in your own words

Reply to the nudge, or just mention it. nod finds the matching draft.

| You say              | What happens                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| "Show me"            | nod shows the full draft in chat, with what still needs checking.            |
| "Send it"            | nod starts normal work. The trust check decides whether your words cover it. |
| "Remind me tonight"  | nod snoozes it until then.                                                   |
| "Done, I handled it" | nod closes it.                                                               |
| "Not interested"     | nod dismisses it. It comes back only if something really changes.            |
| "That wasn't useful" | nod keeps the feedback for later choices. It doesn't close the nudge.        |

Only your own messages can snooze, close or dismiss a nudge. If you don't answer, nod doesn't remind you or get louder, and silence doesn't count as feedback.

## When nod nudges you

nod saves useful work privately first, then checks whether a message is allowed now. Change any limit by telling nod, for example "Only one routine message a day" or "Pause preparation".

| Limit                    | Default |
| ------------------------ | ------- |
| Routine messages per day | 2       |
| Minutes between messages | 120     |

Urgent matters, with high impact and a checked deadline, skip the daily limit and the wait. Quiet hours always hold: an urgent nudge that comes up at night goes out when they end. Each matter nudges you once, however often its source repeats. Set quiet hours in **Settings → General**, or tell nod. A zero message limit keeps everything quiet.

To stop preparation itself, tell nod "Pause preparation", and "Resume preparation" to turn it back on. Preparation runs when a source changes or a saved matter is due, and its cost counts toward your monthly limit in **Usage**, like everything else nod does.

If routine nudges pile up unanswered, new routine ones wait until you answer one. Urgent ones can still reach you.

## What nod reads

nod reads your Gmail conversations from the last 30 days, your primary Google Calendar, and the work it saved for you. Other apps keep their existing watches. A failed or partial check never means nothing needs you.

## What stays private

The worker that prepares nudges can only read sources, read your memory and save private work. It can't send, book, buy, delete or change settings. Sending a draft always starts a new request that goes through the [trust check](/trust/approvals/).

Prepared drafts stay separate from your memory. Closed drafts are deleted after 30 days. Removing an account in **Apps** deletes the prepared work that came from it.

## Related resources

- [Proactivity engine](/how-it-works/proactivity/)
- [Proactivity evidence](/how-it-works/proactivity-evidence/)
- [Schedules and background work](/use/schedules/)
