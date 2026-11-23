---
title: Conversation traces
description: What Nod sends to the Nod team when you turn on conversation traces, what it removes before sending, and how traces are pseudonymised.
sidebar:
  order: 12
---

Conversation traces let the Nod team at n8n see how Nod handles real requests, so they can find and fix problems. They're off until you turn them on. Nod masks secret values of at least eight characters that it knows, known secret formats and personal details it recognizes before sending a trace. Short secret values and other private content can remain.

Nod also masks values under recognized secret field names in text assignments, object fields and name/value arrays. Examples include `GITHUB_TOKEN`, `db_password` and `authToken`. Short names such as `pwd` and `otp` need a complete name or a word boundary, as in `db_pwd` and `authOTP`. A sentence such as "Enter your password" does not mark an array as a secret field. These checks use the original names before any values are masked.

This page describes n8n's trace service, used by official desktop builds. A server operator can configure another receiver; that receiver controls access and retention.

![Settings → Privacy & data, with Share usage data and Share conversation traces turned on, and How Nod uses your data beside the heading.](../../../assets/screens/conversation-traces-setting.png)

## Turn traces on or off

1. Open **Settings → Privacy & data**.
2. Turn on **Share conversation traces**.

Select **How Nod uses your data** beside the heading for a short summary of both switches.

Turn the switch off to stop sending at once. A trace that was already on its way can still arrive. Traces already sent are deleted when they expire, 14 days after they arrive.

The switch is separate from **Share usage data**, and you can turn either on without the other. It appears for an official local desktop assistant. A source install or self-hosted server needs `NOD_TRACES_TOKEN` and a nonempty receiver URL. `NOD_TRACES_URL` defaults to n8n's service (see [Configuration](/deploy/configuration/#analytics-and-feedback)). A connected desktop client uses the server's trace configuration.

## What a trace contains

While the switch is on, each request Nod makes to your model becomes one trace, from chats, tasks, helpers and background checks.

Each trace can include, after redaction:

- The messages and tool results the model saw, including text Nod read from [local files](/connect/local-files/).
- Nod's instructions, without your saved memory, learned skills and formats.
- The names of the tools the model could use.
- The model's reply, name, token counts and cost.
- Whether the request came from chat, a task, a helper or a background check.

Nod excludes:

- The original Nod session ID in trace metadata.
- Images, which become `[image]`.
- Checks of emails that may give access to an account.
- Requests to decision services.
- Separate requests to the models that write your memory, writing style or learned skills.
- The request to a small model that writes the short line about your request in the chat's status line.
- Attention and review tasks.
- Codemode scripts and results.
- Usage events, which have their own switch.

Each trace includes the Nod version as `app_version` metadata when a valid release version or source revision is available.

### IDs, errors, and cost

First desktop release for `user_id`, stable `thread_id`, and the expanded error classes: **v0.9.1**. See [release coverage](/deploy/analytics/#event-properties) for older data and fallback IDs.

A trace can lack `user_id` when Nod cannot load the analytics ID. Nod still sends the trace. Count analytics IDs only where this field exists. Older releases can also omit it.

| Metadata                  | Meaning                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_id`                 | The analytics ID (`local:<UUID>`). It equals the PostHog `distinct_id`. It identifies a runtime profile, not a verified person.                   |
| `thread_id`               | For saved sessions, a keyed hash that stays stable when the private key loads. Work without a saved session gets a new auxiliary ID for each job. |
| `turn_id`                 | A pseudonymous ID for one unit of Nod's work: a user request, schedule fire, observer batch, or continuation. It is not a user-message count.     |
| `run_id`, `parent_run_id` | Pseudonymous agent execution IDs, when available. They connect helper calls to their parent.                                                      |
| `error_type`              | A fixed error class, when the request fails. See the values below.                                                                                |
| `cost_usd`                | Nod's known cost estimate for this model call, as a number in US dollars. A known zero stays zero. An unknown cost is absent.                     |

Curator requests within a turn share its conversation and turn IDs. Curator requests outside a turn use `turn_id` for their auxiliary work. Retries keep that ID. Requests excluded for privacy stay excluded.

While usage sharing is on, server events within a turn carry the same `thread_id` and `turn_id`. Join on the analytics ID (`user_id`) matching PostHog's `distinct_id`, plus the same `thread_id` and `turn_id`. These keys identify the turn's source and task type. Task classification can arrive after the turn ends. The PostHog `run_id` is a separate analytics ID; it does not equal the trace's agent `run_id`.

Error details pass through the same removal steps as messages. The fixed error classes are:

| `error_type`           | Meaning                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `auth`                 | HTTP 401, an invalid API key, or an expired authentication token.                    |
| `billing`              | HTTP 402 or an explicit provider billing cause, such as a required positive balance. |
| `provider_unavailable` | HTTP 503, high model demand, or an overloaded provider.                              |
| `quota`                | A free-tier, daily, or subscription usage limit, including ChatGPT plan limits.      |
| `rate_limit`           | A short-term request or token limit.                                                 |
| `model_config`         | A local setup failure, such as a missing cost estimate.                              |
| `connection`           | A failed connection, timeout, or terminated stream.                                  |
| `aborted`              | The model runtime reports an aborted request.                                        |
| `unknown`              | The available reason does not match another class.                                   |

Keep `aborted` separate from provider failures in failure-rate reports. This class follows the runtime's stop reason. It can include local deadline cancellations, so it does not prove that you selected Stop.

Cost remains in the token usage data too. Plan requests use their API-price estimate. Unknown prices are not free usage; reports must keep their coverage separate. Model-call costs must be summed once, without adding helper costs again to a parent total.

When available, a trace also records the observed request phase. A prepared payload does not prove that the request reached the provider. This field contains no transport headers or request content.

The `request_kind` field distinguishes a one-token cache-warming request (`cache_warm`) from a regular request (`regular`). Regular requests include background checks. Neither kind proves that an owner received a useful result. Older traces without the field have an unknown kind.

n8n's service sees the sending machine's IP address when it receives a trace. For a self-hosted assistant, that is the server's address. It doesn't add the address to the trace.

## What Nod removes first

Every trace passes through these layers on the machine running your assistant before it's sent.

| Layer                       | What it removes                                                                                     | How it decides                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Known secrets               | Keys you saved, model and app keys, Nod's own tokens, and text shaped like a key, token or password | Known values of at least eight characters, plus known key formats |
| Secret fields               | The value of fields such as `password`, `token` or `api_key` in tool arguments and app data         | The field name                                                    |
| Your name                   | The name on each app account you connected, such as Gmail or Slack, in full or in part              | An exact match                                                    |
| Your home folder            | The path of your user folder, which often contains your name, becomes `~`                           | An exact match                                                    |
| Nod's IDs                   | Task, message, connection and file IDs in messages and tool results                                 | The ID format; each gets a keyed hash that changes daily          |
| Email addresses             | Every address, and the name written beside one, as in `Jane Doe <jane@example.com>`                 | The address format                                                |
| Phone numbers               | Numbers that are valid in a country's numbering plan, using your region for local formats           | Google's libphonenumber rules                                     |
| Payment cards               | Card numbers from Visa, Mastercard, American Express and other issuers                              | The issuer prefix and the Luhn checksum                           |
| Bank accounts               | IBANs                                                                                               | The country's length and the IBAN checksum                        |
| Crypto wallets              | Bitcoin and Ethereum addresses                                                                      | The Bitcoin address checksum, or the Ethereum address format      |
| ID numbers                  | US Social Security, Spanish DNI and NIE, UK National Insurance, Brazilian CPF and Indian Aadhaar    | Each format's check digit or rules                                |
| Network addresses           | IPv4, IPv6 and MAC addresses                                                                        | Address validation                                                |
| Personal fields in app data | The value of fields such as `first_name`, `displayName`, `birthday`, `address` or `phone`           | The field name, whatever the value's type                         |

Here's a synthetic request before and after scrubbing, for an owner called Marta in Spain:

```text title="What the model saw"
Tell Jordi Serra <jordi.serra@example.com> I paid invoice 2026-114 with card 4111 1111 1111 1111.
He can call me on 612 345 678 or at the office, 203.0.113.42. Thanks, Marta
```

```text title="What the trace contains"
[name] <[email]> I paid invoice 2026-114 with card [card].
He can call me on [phone] or at the office, [ip]. Thanks, [owner]
```

The invoice number stays because it does not match these redaction rules.

:::caution[Removal is automatic]
Nod removes what it can recognize. A trace can still contain private content in other forms, such as a short or unrecognized secret, account or device ID, another person's name, a delivery address or other people's messages in an app such as Slack. Turn traces on only if you're comfortable with that.
:::

## How traces are pseudonymised

- **Stable analytics ID.** Each trace carries the same analytics ID as usage analytics, even when usage sharing is off. It does not rotate across conversations, days, or restarts. It links traces from the same runtime profile. This ID can link traces to earlier usage data, About you choices, and an email submitted for updates. The trace switch controls sending traces. The usage switch controls sending usage events. Neither switch deletes stored data.
- **Session metadata.** Nod removes its original session ID from trace metadata and replaces its turn and run IDs with keyed hashes. Account or device IDs in conversation text or app results can remain.
- **Stable conversation IDs.** A conversation is one saved chat, task, or background session. Its `thread_id` is a keyed hash of the private session ID. When the private key loads, it stays the same across idle gaps, days, and restarts. It links traces from that saved session over time. A new session, such as a reset chat or a separate schedule fire, gets a different ID. Work without a saved session gets a new auxiliary ID for each job. The key stays in the runtime profile's private `trace-key` file. Deleting or replacing that key changes conversation IDs. Earlier releases used IDs that changed after 30 idle minutes or a restart; these earlier IDs cannot be joined to the new IDs.
- **Other execution IDs.** Turn and agent run IDs, and IDs inside messages and tool results, keep their existing keyed hashes. These hashes change daily and on restart. One active turn keeps its trace IDs until it ends. Repeated hashes can link records within the same runtime and UTC day. Other content can also connect traces, such as a website address or an account handle.
- **No owner context.** Nod replaces your saved memory, learned skills and format preferences with `[owner context omitted]`, including memory notes and learned skills it reads with a tool. Memory selected for a request is replaced with `[memory omitted]`. Those reads keep only their action, such as `memory_read`, not the note path, search words or skill name. The attention and review tasks that read your saved memory are not traced at all, and a codemode step keeps neither its script nor its result, because a script can read memory or a connected account.
- **No images.** Images are replaced with `[image]`.

These steps reduce private content. Traces are pseudonymised, not anonymous. The shared analytics ID and details in a conversation can identify you.

## Where traces go

```mermaid
flowchart LR
  Nod[Nod on your computer or server<br/>scrubs each trace]:::accent -- "HTTPS, with Nod's token" --> broker["Nod Traces service (n8n)<br/>checks and forwards"]
  broker -- write-only key --> langsmith[LangSmith, EU<br/>deleted after 14 days]
```

1. Nod sends each scrubbed trace to n8n's **Nod Traces** service. The service refuses requests without the token in official Nod builds. It checks the trace's shape and size, files it in Nod's trace project, and keeps no copy of the request. It forwards about 600 traces per clock minute from all senders combined, a best-effort cap that limits the cost of misuse.
2. The service writes the trace to n8n's LangSmith workspace in the EU with a tracing key that can write traces but can't read them. Nod itself never holds a LangSmith key.
3. LangSmith deletes each trace 14 days after it arrives. People at n8n with access to that workspace can read traces until then.

n8n uses traces to find and fix problems in Nod. It doesn't use them to train AI models.

:::note[The token isn't a secret from you]
Anyone who unpacks the desktop app can read the token it sends. The token keeps out scanners and stray requests. The real protection is the scrubbing before sending, the checks in the service and the write-only key.
:::

## For operators

If the private conversation key cannot load, Nod records `trace_conversation_key_unavailable` and keeps sending traces with a temporary runtime key. These conversation IDs survive idle gaps but change on restart. This failure does not stop Nod. The key itself never enters a trace.

The receiver accepts at most 20 input metadata keys. Contract checks send the full producer payload through the receiver, accept 20 keys, and reject 21. Keep this check when you add a metadata field.

| Variable           | What it does                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `NOD_TRACES_URL`   | The HTTPS address that receives traces. An empty value turns traces off for everyone.         |
| `NOD_TRACES_TOKEN` | The token sent as `x-nod-traces-token`. Without it, Nod sends no traces and hides the switch. |

Official desktop builds take the token from the `NOD_TRACES_TOKEN` secret of the `release` environment, and only the packaging steps can read it. The service is defined in [`deployment/n8n/traces.mjs`](https://github.com/n8n-io/nod/blob/main/deployment/n8n/traces.mjs). It uses two n8n credentials: **Nod traces webhook** holds the token and **Nod LangSmith traces** holds the LangSmith tracing key. The tracing key expires after one year. Create a new **Tracing Only** key in LangSmith and update the credential before then. To change the token, update the n8n credential and the release secret together. Desktop builds made with the old token stop sending until people update.

Before a desktop release with numeric `cost_usd` metadata, update the Nod Traces workflow from the same source revision. Earlier workflow validation accepts only string metadata and rejects traces with numeric cost metadata.

## Where this is enforced

[`src/server/traces.ts`](https://github.com/n8n-io/nod/blob/main/src/server/traces.ts) (switch, layers and pseudonymous IDs) · [`src/server/personal-data.ts`](https://github.com/n8n-io/nod/blob/main/src/server/personal-data.ts) (personal data detectors) · [`src/providers/pi/traces.ts`](https://github.com/n8n-io/nod/blob/main/src/providers/pi/traces.ts) (images and owner context) · [`src/providers/n8n/traces.ts`](https://github.com/n8n-io/nod/blob/main/src/providers/n8n/traces.ts) (sending) · [`deployment/n8n/traces.mjs`](https://github.com/n8n-io/nod/blob/main/deployment/n8n/traces.mjs) (the service)

## Related resources

- [Your data and privacy](/trust/privacy/)
- [Security review guide](/trust/security-review/)
- [Security model and limits](/trust/security-model/)
- [Trust and Vault](/trust/)
