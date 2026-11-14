---
title: Try mobile settings
description: Manage the paired Nod server's models, voice preferences, memory, rules, and privacy from the Flutter evaluation client.
---

Mobile settings manage the same server-backed preferences and connections as Nod web, using the paired server's authenticated connection.

This is part of the [Flutter evaluation](/contribute/mobile-evaluation/), not a supported mobile release. The host app must open `NodSettingsPage` with its existing `NodApiTransport`. Feature widgets never receive the access token.

## Change preferences and rules

1. Open **Settings → General** to change the saved appearance, time zone, region, or clock format.
2. Open **Rules & task check-ins** to edit your rules or a session's spending check-in.
3. Select **Save**. Failed saves keep your draft. Leaving an edited form asks whether to discard it.

Time zones use IANA names, such as `Europe/London`. Regions use locale tags, such as `en-GB`. Empty values restore automatic formatting. Region does not choose the language Nod replies in.

Task check-ins accept USD amounts of at least $1 with up to two decimal places. Leave the amount empty to turn them off. Each session counts model spending since your last message to it, including plan usage at its API-price estimate.

The appearance preference is saved on the server and applied to the native app after a successful change. Reconnecting restores that preference.

## Connect and choose models

1. Open **Models → Add connection**.
2. Select a provider and enter its key in the obscured **API key** field. Enter any provider-specific details.
3. Select **Save**, then select a model and its reasoning effort.

Keys go to the existing private model-configuration API, never to chat or a model prompt. Forms disable keyboard suggestions and personalised keyboard learning for secret fields. Nod never reads back a saved key.

OpenAI-compatible addresses refer to the computer running Nod, not your phone. Azure needs an endpoint, deployment, and model ID. Bedrock needs its Region. Cloudflare needs an account ID and, for AI Gateway, a gateway ID. Anthropic accepts a workspace ID when needed; automatic workspace-choice errors aren't exposed by the current mobile transport.

**ChatGPT sign-in** and OpenRouter's **Browser sign-in** open the provider's HTTPS address without passing the Nod token. Return to the sign-in page to check completion. For ChatGPT, paste the full callback address into the private **Callback URL** field if the final page cannot load. Leaving the page cancels the pending attempt. Server expiration and connection ownership still apply.

Each connection lists its available models, capabilities, and supported effort levels. When a key ending is available, the label, search, and removal confirmation show it so you can distinguish connections to the same provider. **Load models** refreshes its catalog. **Reconnect** restores browser sign-in. **Remove connection** asks before removal. Server-managed connections cannot be removed here. A running task keeps the model it started with.

## Set voice preferences

Open **Voice & audio** to select automatic or a listed voice, set when replies are spoken, or refresh the voice catalog.

When the server supports local audio, select **Free audio on your Nod server** to download its voice and recognition models. This runs on the server, not the phone. Reload to check preparation state. A timeout doesn't prove the download stopped; check its state before starting another request.

Select **Preview voice** to hear the selected voice, or the server's automatic voice. **Stop preview** discards pending audio or stops playback. A failed request shows an error and isn't retried automatically. Select **Preview voice** again to make a new request.

Preview audio uses the authenticated `/api/speech/preview` route. One preview request or player is active at a time. The native player reads only a temporary local file, never the server token. Leaving the page, backgrounding the app, or changing the paired connection stops playback and clears the temporary copy. A pending request's result is discarded after Stop; Stop doesn't prove synthesis on the server stopped.

Recording uses the system microphone. Grant permission when recording in chat, or change denied permission in device settings. Mobile settings don't provide a microphone-device picker.

## Review memory and skills

Open **Memory** to search notes or choose **Confirmed**, **Learned**, **Mentioned once**, **Let go**, or **Skills**.

- Select a note to inspect its source excerpts, dates, and status. Edit its text or end date, confirm it, archive it, or forget it.
- Select **Bring back** on an archived version to restore that exact version. Forgetting asks before permanent deletion.
- Select a skill to inspect its procedure and task reference, edit its description and steps, or forget it.
- Select **Add note** to choose a category and write one fact.
- Turn off **Save new notes** to stop learning. Turning on **Include sensitive details** requires confirmation.

Source excerpts remain readable here. Hosts can pass `onShowMessage` to `NodSettingsPage` to handle **Show message**. The action appears only for a real source ID that the server marks as openable in the current chat. The host must close settings and focus that message. Skills are context, never permission to act.

### Import and export

1. Select **Import** and paste notes from another assistant.
2. Use one fact per bullet under headings such as `## Preferences` or `## People`.
3. Select **Review notes**, remove unwanted notes with their checkboxes, then select **Import selected notes**.

The server checks each note, skips duplicates and unsafe content, and returns counts. Imported notes are confirmed context, not action permission.

**Export Markdown** downloads the same `/api/memory/export` response as web and opens the device share sheet with `nod-memory.md`. The file preserves the response bytes without rewriting the Markdown. Mobile accepts only a nonempty Markdown response up to 16 MiB and ignores server-supplied filenames. Its temporary copy is deleted when sharing returns, is cancelled, or fails. Leaving the page or changing connections before sharing discards the result. Files you save or send through another app remain there; keep them private.

The import form accepts pasted note text, not a full archive or skill restore; the server exposes no skill-import endpoint.

## Control sharing and reset the conversation

**Privacy & data** reads current sharing choices from the server. Turning sharing on requires a separate confirmation explaining what leaves Nod. Turning it off stops new sends without another confirmation.

Usage data excludes messages and screen recordings. Conversation traces include conversation content and what Nod reads and does. Recognized personal details are removed first, but traces aren't anonymous. Traces are stored in the EU for 14 days and aren't used for model training. The trace switch appears only when the server supports it.

**Reset conversation** appears only when the server enables it. Confirming sends the exact conversation ID shown when the page loaded. A stale conversation is refused rather than silently resetting another conversation. Memory is kept.

**Remove all data** is a desktop operation with no corresponding server API. Mobile doesn't erase its paired server. Self-hosted deletion belongs to the server administrator. Turning sharing off doesn't delete information already sent; contact `privacy@n8n.io` to request deletion.

## Validation boundaries

Focused transport tests exercise the real authenticated HTTP client with synthetic responses, including narrow settings patches, model selection, archive revisions, path refusal, and server errors without automatic retries. Widget checks cover explicit trace consent, preserving rejected drafts, source-message binding, and preview background cleanup. Synthetic binary-route checks cover authenticated requests, exact export bytes, MIME and size rejection, one-shot failures, stale preview results, temporary-file cleanup, and the native audio-player port's open/play/pause/dispose lifecycle.

These checks don't contact a model or account, download audio models, run native plugins, or validate physical devices. Native runtime checks and the docs build are separate integration gates.

## Related resources

- [Try the Flutter client](/contribute/mobile-evaluation/)
- [Models](/connect/models/)
- [Memory](/use/memory/)
- [Your data and privacy](/trust/privacy/)
