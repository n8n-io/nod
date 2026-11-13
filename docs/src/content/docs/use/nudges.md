---
title: Nudges
description: How Nod messages you about work it prepared on its own, and how you answer in your own words.
sidebar:
  order: 4
---

Nod prepares useful work from your connected sources on its own and messages you when it's worth an interruption. That message is a nudge: what changed, what's ready and, when there's a next step, one short question that offers it, such as "Want me to send it?". The first nudge about a kind of thing also says, once, that Nod will keep flagging things like it. You answer in words, in Nod, Telegram or WhatsApp.

Turn on **Automatic preparation** in **Settings → Notifications**. New profiles start with it off. Existing choices stay as saved.

Nod first checks for a concrete open need, such as an unanswered request, a commitment, a problem, financial risk or recoverable payment that affects you, or work you asked it to watch. Ideas, backlog entries and routine updates alone start no plan, draft or task, even in private. Nod can still use a model to check for an open need. A possible improvement or missing detail does not make the idea urgent. Saving an idea does not ask Nod to develop it.

## What a nudge looks like

> Your Juniper Tools statement lists an unused EUR 480 credit. I drafted an enquiry to use it or get a refund. Want to see it?

The full draft waits with Nod until you ask for it:

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

Nod also tells you what it couldn't confirm, here the current balance and the supplier's terms. The draft never claims a refund right or a payment that hasn't happened.

## Answer in your own words

Reply to the nudge, or just mention it. Nod finds the matching draft.

| You say              | What happens                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| "Show me"            | Nod shows the full draft in chat, with what still needs checking.            |
| "Send it"            | Nod starts normal work. The trust check decides whether your words cover it. |
| "Remind me tonight"  | Nod snoozes it until then.                                                   |
| "Done, I handled it" | Nod closes it.                                                               |
| "Not interested"     | Nod dismisses it. It comes back only if something really changes.            |
| "That wasn't useful" | Nod keeps the feedback for later choices. It doesn't close the nudge.        |

Only your own messages can snooze, close or dismiss a nudge. If you don't answer, Nod doesn't remind you or get louder, and silence doesn't count as feedback.

## When Nod nudges you

Nod saves useful work privately first and messages you only when it's worth an interruption. There's no daily count. Each matter nudges you once, however often its source repeats, and again only if something really changes. During quiet hours, nudges and due saved matters wait. A known high-impact matter with strong evidence and a deadline before quiet hours end can still get a check and a nudge. New routine preparation and its email checks wait too. An assessment already in progress can finish. Changes collect for batches of up to 10 sources when quiet hours end. Nod does not assess new changes during that wait. Set them in **Settings → Notifications**, or tell Nod.

Tell Nod "Fewer of these" and it uses that next time. To stop preparation itself, tell Nod "Pause preparation", and "Resume preparation" to turn it back on. Pausing also stops the email checks on new Gmail mail and the planned checks of tasks Nod started; schedules and tasks you started keep running. Preparation runs when a source changes or a saved matter is due, and its cost counts toward your monthly limit in **Usage**, like everything else Nod does.

## What Nod reads

Gmail is checked for new mail every 15 minutes. Your primary Google Calendar is checked for changes every 30 minutes. These change checks need no model. Saved work has its own change token. Other apps, including MCP and HTTP connections, need an app event to start preparation. They have no periodic model check. You can still ask Nod to read them in chat or in a schedule.

One small model can skip clearly routine changes across the whole batch. Possible needs and uncertain cases reach your selected model. There is no model assessment for each record. A failed or partial check leaves the source state unknown.

Automatic preparation has a $5 monthly allowance by default. This covers its source reviews, email privacy checks, observer, and tasks. Change it in **Usage**. See [Automatic preparation allowance](/use/spending/#automatic-preparation-allowance).

## What stays private

The worker that prepares nudges can only read sources, read your memory and save private work. It can't send, book, buy, delete, draft in your apps or change settings. Sending a draft always starts a new request that goes through the [trust check](/trust/approvals/).

Prepared drafts stay separate from your memory. Closed drafts are deleted after 30 days. Removing an account in **Apps** deletes the prepared work that came from it.

## Related resources

- [Proactivity engine](/how-it-works/proactivity/)
- [Proactivity evidence](/how-it-works/proactivity-evidence/)
- [Schedules and background work](/use/schedules/)
