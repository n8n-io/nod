# Managed app uploads

Verified 2026-10-08 against Composio's documentation, the installed TypeScript SDK, and synthetic files in disposable live sessions. No connected account, recipient or model was used.

## Supported storage path

Use a session file mount, then convert its relative path with the fixed `get_mount_file_s3_key` helper. Composio documents the returned storage key as an accepted `FileUploadable.s3key`; a local or mount path itself is not accepted. [Tool Router Files](https://docs.composio.dev/kb/guide/mcp-tool-router-files)

The mount upload request takes a session ID, mount ID, relative path and optional MIME type. It returns an expiring upload URL for an HTTP PUT; there is no MD5 field. [Session mount upload API](https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSessionBySessionIdMountsByMountIdUploadUrl)

Avoid the project-wide `/files/upload/request` route for shared managed connections. Its required MD5 field drives deduplication and integrity verification. Earlier synthetic requests returned the same nonempty key and object path when only the filename changed; omitting MD5 returned400. Different action or digest changed the object. Random filenames therefore do not isolate that API. [Request file upload API](https://docs.composio.dev/reference/api-reference/files/postFilesUploadRequest)

## Live contract evidence

The frozen base used identical 78-byte synthetic content and filename in two different users' empty sessions. Initial bytes had SHA-256 `e060011739a6f815140ec3dac0b31e68e24e2897075021d84914a9e4ce4f7743`; replacement bytes had SHA-256 `b3caab3726f0ceb28077f6f819b50fd64ba59742cbb7fb8d496e76a223e369fc`.

| Check                                                                       | Result |
| --------------------------------------------------------------------------- | ------ |
| Sessions had no enabled toolkits, with workbench tool/proxy access disabled | Passed |
| Both uploads downloaded with the expected original SHA-256                  | Passed |
| Fixed file helper returned a nonempty key and empty error                   | Passed |
| Same content and filename produced distinct session keys and object paths   | Passed |
| Each key included its own user/session and matched its upload object path   | Passed |
| Overwriting the second file left the first file's bytes unchanged           | Passed |
| Both synthetic files and sessions were deleted                              | Passed |

Observed helper response: `get_mount_file_s3_key(path)` returns a tuple `[key, error]`. The successful error string is empty. The `execute_meta` response has `result_type: "completed"`, JSON printed in `data.stdout`, and empty `data.stderr`/`data.error`. The initial probe expected a string, so its preserved red result was a measurement error. Correcting that parser did not change the isolation checks or frozen inputs.

The successful base probe hash is `af032c60dae8c04c1c93ea446d326f3fe21cc61e2343d2f2b2387885a9b9c0fa`. Local ignored evidence retains the frozen case, exact scripts, prior red run and aggregate results under `.local/composio-contract-evidence/`. No project credential, storage key or signed URL is included here.

A held-out run used two sessions for the same owner, a nested path and six non-UTF8 binary bytes. The same checks passed, including distinct keys and unchanged first-session bytes after overwriting the second. Both files and sessions were deleted. Its probe hash is `fada51edde6364e9c4273dac6809590c8ef3fc507eafd79aff537b2f24daaf0a`.

A second held-out run called the Worker's exact exported file helper. Its chunked SHA-256 and byte count matched the independently calculated input for both sessions; isolation and cleanup still passed. The helper code hash before and after was `ca72573797f84d41cd009975b86093cf691fd7cf9621d11f2fa7ef80a523516a`.

Separately, the actual Otto SDK/provider and Worker passed a controlled upstream fixture: binary upload, execution from a fresh account-pinned session, rejection across owner/account/action, rejection of raw keys, and explicit cleanup. That fixture made 32 signed broker requests, left no synthetic sessions/files, and exercised no live provider account. It does not establish external attachment delivery.

## Broker requirements

The Worker should receive the bytes, verify the selected connected account, choose a fresh random path in an isolated file session, perform the PUT internally, and issue an encrypted attachment capability only after upload completes. The capability must bind the owner, account, action, file session/path, original metadata, content digest, size and expiry. Callers receive no writable storage URL, raw object key, arbitrary workbench operation or mount API. Execution accepts only an owned capability for the selected account/action and rechecks account/session ownership.

Otto prepares attachments on its cached session and executes with a fresh account-pinned session. A capability cannot require those two session IDs to be identical; both must belong to the authenticated installation.

Use only fixed file-helper code in a session configured with `workbench.enable_tool_execution: false` and `workbench.enable_proxy_execution: false`. The installed SDK's request schema documents that this leaves Python/file helpers available while disabling Composio tools, LLM/web-search helpers and authenticated proxy helpers. The live response confirmed both disabled flags and an empty toolkit list.

## Lifecycle and limits

Composio labels the mount API experimental. Mount files persist across sandbox restarts; the caller cannot configure their expiry, and a download URL's expiry is separate from file deletion. [Remote sandbox files](https://docs.composio.dev/docs/sandbox/remote)

Composio's retention policy explicitly says files under `/mnt/files` are automatically deleted from temporary object storage after 24 hours. This is a provider policy verified in the documentation on 2026-10-08; these probes did not wait 24 hours to observe deletion. It corrects the earlier inference that a mount with no caller-configurable TTL had no provider expiry. [Data retention](https://docs.composio.dev/docs/security/data-retention)

Keep staged files through pending approvals and uncertain executions, relying on that documented retention. Do not delete them in an execution `finally` block: a timeout does not prove the provider stopped reading the attachment. Explicit owned deletion remains available when safe; no local janitor table or proxy cleanup queue is required for the documented file lifetime. The file capability lasts at most 24 hours, but provider storage may expire earlier because upload/helper processing happens before capability issuance. An expired file must return a bounded failure without retrying the action.

File deletion and hidden session metadata are separate. The documented 24-hour policy covers file objects; it does not establish when Composio deletes session metadata. Likewise, successful tool execution is not proof that its logs have been removed.

This proves provider storage isolation with synthetic bytes and the fixed integrity helper. Actual attachment delivery through a connected app and the provider's 24-hour deletion policy require separate live acceptance evidence.
