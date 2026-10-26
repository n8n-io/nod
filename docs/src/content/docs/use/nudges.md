---
title: Nudges
description: How nod messages you about work it prepared on its own, and how you answer in your own words.
sidebar:
  order: 4
---

nod prepares useful work from your connected sources on its own and messages you when it's worth an interruption. That message is a nudge: what changed, what's ready and, when there's a next step, one short question that offers it, such as "Want me to send it?". The first nudge about a kind of thing also says, once, that nod will keep flagging things like it. You answer in words, in nod, Telegram or WhatsApp.

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

nod saves useful work privately first and messages you only when it's worth an interruption. There's no daily count. Each matter nudges you once, however often its source repeats, and again only if something really changes. Quiet hours always hold: a nudge that comes up at night goes out when they end. Set them in **Settings → General**, or tell nod.

Tell nod "Fewer of these" and it uses that next time. To stop preparation itself, tell nod "Pause preparation", and "Resume preparation" to turn it back on. Preparation runs when a source changes or a saved matter is due, and its cost counts toward your monthly limit in **Usage**, like everything else nod does.

## What nod reads

nod reads every app you connect, with nothing to turn on. Gmail and the work nod saved for you are read as soon as they change, and your primary Google Calendar is checked for changes every 30 minutes. Other apps, including MCP and HTTP connections, are read through their own read tools every 30 minutes, and only calls that read can run. A failed or partial check never means nothing needs you.

## What stays private

The worker that prepares nudges can only read sources, read your memory and save private work. It can't send, book, buy, delete, draft in your apps or change settings. Sending a draft always starts a new request that goes through the [trust check](/trust/approvals/).

Prepared drafts stay separate from your memory. Closed drafts are deleted after 30 days. Removing an account in **Apps** deletes the prepared work that came from it.

## Related resources

- [Proactivity engine](/how-it-works/proactivity/)
- [Proactivity evidence](/how-it-works/proactivity-evidence/)
- [Schedules and background work](/use/schedules/)
