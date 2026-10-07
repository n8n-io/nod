# Otto feedback delivery

[Otto Feedback](https://internal.users.n8n.cloud/workflow/8DyrtVGHFLptHwTr) is published in the **Otto** n8n project (`ja9rNGROYKEG8wUl`). **Receive feedback** accepts `POST https://internal.users.n8n.cloud/webhook/otto/feedback` directly from Otto, including local development. The destination is the [Otto Linear project](https://linear.app/n8n/project/otto-cbb2e43ad842/overview), in n8n Labs, with Backlog as the initial issue state. Every submission receives the n8n Labs **User feedback** label. Bug and feature submissions also receive the existing workspace **type: bug** or **type: feature** label; general feedback uses only the origin label. Labels and Backlog are set in the same issue-creation request. The Linear project's existing Canceled status is unchanged.

The 17-node workflow has three stages: validate the request, find or create its issue, and attach reports. Five Linear API nodes use the **Otto Linear** credential in the Otto n8n project. **Draft Linear issue** uses the native OpenAI node and the shared **Global OpenAI** credential. No provider credentials ship in Otto.

The installed [Linear node](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Linear/Queries.ts) cannot set a project or caller-supplied ID during creation, request private uploads, or attach files with the metadata used to match a retry. Its Get operation omits project, URL and attachment fields. HTTP requests cover these unsupported operations; native Switch and Split Out handle routing and files.

## Issue formatting

The OpenAI step receives only the feedback category and the user's written description. It requests a concise English title and a Markdown description using `gpt-5.4-mini` with a JSON schema, no tools and response storage disabled. Code validates the result before using it. The instructions preserve uncertainty and forbid invented reproduction steps, causes, fixes or verification claims.

Code appends the original feedback unchanged, reporting context and the receipt marker. Diagnostics, attachments, computer names and build metadata do not enter the formatting prompt. Invalid, incomplete or failed model responses fall back to the first nonempty feedback line as the title and the complete original message as the description. Existing submissions, status checks and attachment repairs bypass the model.

## Intake contract

The versioned envelope is defined by `src/ports/feedback.ts`. The app defaults to the public n8n URL. `OTTO_FEEDBACK_URL` can override it; an explicit empty value disables sending while local trace copying remains available.

Reporting context includes source (`desktop`, `local-web` or `hosted-web`), development mode, platform, computer name when available, app version, source commit and whether the checkout was modified. Unknown values are null. Native builds report their actual installed version and build source. Local development reports the current commit and modified state without treating the package placeholder version as a release. Hosted servers use supplied release metadata. Browser reports do not use the server's hostname as the user's computer name.

Diagnostic reports include recent user and assistant conversation messages. Tool activity uses Inspector records when capture is enabled and records exist. Installed apps and other sessions without Inspector capture use a bounded projection of recent saved tool calls and results. That tool projection excludes prompts, reasoning, binary blocks and private credential, flow and memory payloads, while preserving tool outcome and original timing. Both trace sources retain the same redaction and size limits. If the saved session cannot be read, report generation stops because credentials needed to redact mirrored values may be unavailable; the user can retry or remove the report before submitting feedback.

Feedback text is limited to 12,000 characters. Diagnostics are selected by default for every category and can be removed before submission. A diagnostic report is limited to 512 KiB. Attachments support PNG, JPEG, WebP, PDF, UTF-8 plain text (TXT, LOG and Markdown), JSON and CSV: at most three files, 2 MiB per file and 4 MiB together. The entire JSON request is at most 7 MiB.

`payloadHash` is SHA-256 over JSON with this exact property order, excluding `payloadHash` and `action`:

```js
{
  schemaVersion: 1,
  submissionId,
  category,
  feedback,
  computerName,
  appVersion,
  appRelease,
  platform,
  development,
  source,
  appModified,
  report: report ?? null,
  attachments,
}
```

Each file carries its name, MIME type, canonical base64 bytes and SHA-256. The server and workflow verify byte limits, image and PDF signatures, lossless UTF-8 text without NUL bytes, and valid JSON. The workflow also verifies every file hash and the complete envelope hash before accessing Linear or the model. These checks detect corruption and bind retries; they do not authenticate the reporter. Computer names and client-supplied context remain unverified.

The same endpoint accepts `{ action: 'status', submissionId, payloadHash }` for a read-only check, or the original envelope with `action: 'repair'` to attach missing files to the original issue. Repair never creates an issue. A confirmed rejection uses HTTP 400 with a matching submission receipt; arbitrary HTTP errors remain uncertain in the app.

## Delivery and recovery

The submission UUID is the Linear issue UUID. The workflow checks it before creation and binds the issue to its payload hash, target project/team and requested file hashes. A receipt marker at the end of the description allows reconciliation without a separate feedback database. Repeated submissions with the same UUID cannot create another issue.

The creation response includes the issue, destination and attachments and is validated before files are uploaded. Private `fileUpload` requests set `makePublic: false`; the PUT uses only the returned storage headers and content headers. Redirect following is disabled. The upload validator accepts signed HTTPS `storage.googleapis.com` uploads and private `uploads.linear.app` asset URLs. Upload private file uses no Linear credential.

Attachments receive deterministic UUIDs and submission/hash metadata. An explicit retry selects only missing attachments. A final re-read of the issue and requested attachments gates `submitted`; missing files produce `partial`, and an unverifiable response produces `unknown`. Timeouts, hash mismatches, GraphQL errors and wrong-project records cannot yield success. There are no automatic action retries.

Local receipt storage contains submission IDs, hashes, status and the Linear link. Report snapshots and repair bytes live in bounded process memory for one hour; expiry is swept on the next feedback request, and restarting discards them. An unknown submission is reconciled after five minutes before another submission is allowed, allowing the original workflow execution to finish.

## Anonymous access and retention

There is no Cloudflare relay, shared client secret, login gate, CAPTCHA, device fingerprint or application-level per-IP rate limit. Payload bounds and duplicate prevention remain. Anonymous callers can create distinct valid requests; any future per-IP throttling belongs at the n8n hosting layer before workflow execution. The public URL is not a secret.

Successful, failed, manual and progress execution payload retention are disabled in n8n. Feedback and private attachments persist in Linear. The written feedback also passes through the model provider for formatting, with response storage disabled. The app's bug-report disclosure, preview and removal controls cover the attached diagnostic snapshot.

## Validation

Run local synthetic contract checks with:

```sh
node --test deployment/n8n/feedback.test.mjs
```

Twelve checks cover anonymous validation, payload/file hashes and limits, AI formatting and fallback, prompt data boundaries, n8n expression delimiters, read-only status, issue/attachment receipts, explicit repair, private upload validation, JSON header serialization and per-item file pairing. The 17-node SDK workflow and changed node configurations validate without warnings.

Execution `99945874` reached a submitted receipt using synthetic feedback, a JSON report and a PNG. The AI output and every external HTTP node were pinned: no live model call, Linear issue or upload occurred. The prepared issue retained the original text, source/version metadata and receipt; both files kept their matching bytes and upload URLs. Manual payload retention was restored to disabled afterward.

On 2026-10-05, the authorized live acceptance report created [LAB-452](https://linear.app/n8n/issue/LAB-452) through the real feedback UI and production endpoint, using an isolated local database, synthetic diagnostic report and synthetic PNG. Linear confirmed Otto, Backlog, User feedback and bug. The model produced a structured description and title while retaining the original report and local source/commit context. Local development had no installed app version to report.

The first attempt exposed premature expression termination at adjacent braces; a read-only lookup confirmed no issue before retry. The second created LAB-452 but exposed the HTTP node's requirement for serialized JSON headers. Both defects were fixed and covered by regression checks. Manual repair execution `99950045` uploaded both files to the same issue and returned `submitted`; it did not create another issue or call the model again. Both attachments were downloaded through the authenticated Linear UI and matched the original SHA-256 hashes. An unauthenticated request for the diagnostic asset returned HTTP 401. Manual payload retention was restored to disabled.

The published version was read back as identical to the saved draft. A production request with an empty JSON body returned the expected HTTP 400 rejection before any connected service call. Installed-app delivery and collection of a real conversation's diagnostic data were not exercised by this live check.

## References

- [n8n webhook behavior](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook)
- [n8n execution settings](https://docs.n8n.io/workflows/settings/)
- [Linear GraphQL schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- [Linear private file uploads](https://linear.app/developers/how-to-upload-a-file-to-linear)
- [Linear file authentication](https://linear.app/developers/file-storage-authentication)
- [Linear attachment identity](https://linear.app/developers/attachments)
