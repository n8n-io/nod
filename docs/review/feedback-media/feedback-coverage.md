# Feedback coverage

This PR implements the approved designs in the existing nod app. It retains Geist, the shared theme tokens, the continuous conversation and the existing settings controls. The separate local prototype gallery is a design reference; the [before/after images](README.md) show actual application components.

## Implemented

| Feedback                 | Product change                                                                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message actions          | Hover reaction and caret controls; bubble-only right-click menu at the clicked position; outside clicks dismiss it. Quick reactions and the scrollable full picker stay beside the reaction trigger. Timestamps sit inside the bubble at bottom right.                |
| Brand consistency        | The full emoji picker uses Geist, nod's radii, Lucide category icons and shared light/dark tokens. Native emoji retain their system rendering.                                                                                                                        |
| Inline files             | Small items inside the composer show their own waiting, uploading, processing or failure state. Failed files can be retried or removed. Drafts and sent files share the same artifact viewer on the right; narrow windows use its existing full-pane layout.          |
| Compact connection cards | The card stays inside its message and remains behind the connection dialog. Logos and one Connect action replace the previous pill.                                                                                                                                   |
| MCP setup                | The server address stays visible. The real connection discovery chooses OAuth or API-key/token entry; existing endpoint, callback and account handling are retained.                                                                                                  |
| Telegram card            | The owner's paired Telegram bot link becomes a small logo, name and Open action. Unrelated links and private pairing URLs remain ordinary links.                                                                                                                      |
| Private sign-in          | Sign-in opens beside chat, without a repeated nod logo. The actual private form handles saved accounts, staged fields, password visibility and current request status. Closing clears unsent values.                                                                  |
| Website sign-in methods  | The owner selects an observed website control once. The broker binds it to that exact document and element. Later email, password and code forms follow the active task and browser in the same panel. A selected method is not reported as completed authentication. |
| Payment                  | The existing private approval form opens beside chat. Amount, merchant, selected card, explicit approval and uncertain outcomes remain. Add-card requests use the existing Vault form.                                                                                |
| Secure action styling    | Sign in securely and Confirm payment remain compact actions in their message. Confirmed completed requests disappear; failed, expired or uncertain requests are not reported as completed.                                                                            |
| Getting started          | Notifications and Open at login use action buttons and native-tone completed states. The required preference gates and saved-state readback remain. The onboarding answer's Send button stays on the right.                                                           |
| Feedback discovery       | The informational brand invitation welcomes problems, positive feedback and ideas, and says every message is read. It has no submit CTA. It appears after first-time onboarding, is dismissible and is owner-scoped.                                                  |
| Desktop shortcuts        | Platform-correct Command/Ctrl hints and bindings for pages 1–5, sidebar B and settings comma. Web browser shortcuts are preserved.                                                                                                                                    |
| Settings page            | Settings occupies the workspace instead of a modal, retaining General, Models, App connections and Memory and their existing controls. Direct routes work; unsaved General changes survive leaving and returning.                                                     |
| Navigation continuity    | Shared rail centering and toggle position are corrected. The existing collapsed default is retained. Model selection is in Settings, with missing-model recovery pointing there.                                                                                      |

## Earlier fixes retained

- Removed the inactive onboarding microphone and the final feedback onboarding screen.
- Corrected input font inheritance, duplicate emoji shadows and pointer outlines after Escape.
- Added the compatible PDF renderer and matching worker.
- Corrected zoomed browser coordinates and input while a new frame loads.
- Kept credential deletion/sign-out retryable and selected the next applicable saved login/session.
- Added credential-storage preflight before model connections and consistent owner-scoped credential status reads.

## Explicitly deferred or dropped

- Command palette and navigation search: dropped.
- Broader settings redesign, settings search and new controls: deferred. Only the requested move to a page is included.
- Empty states, missing pages and no-result redesigns: deferred; existing useful recovery actions remain.
- Browser presentation and handoff redesign: deferred. The earlier pointer/frame bug fixes remain.
- Authenticated Instinct comparison: not verified.

## Evidence boundaries

The images use actual product components with synthetic content and intercepted API responses. Desktop screenshots use a renderer bridge fixture. They do not establish live OAuth completion, payment delivery, native OS permission acceptance or installed-app onboarding.

Separate disposable-database and browser regressions cover private form ownership, one-use claims, stale requests, staged sign-in, changed controls and uncertainty without replay. Composer checks cover upload failure, cancellation, retry and the shared viewer. The PR description records the final full-check results.

Standalone private routes remain available. Local desktop runtimes are reachable only on their own computer; channel messages direct the user back to nod when no reachable browser handoff exists.
