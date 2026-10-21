# Feedback fixes: before and after

The first eleven comparisons were captured on 2026-10-21 from the actual application frontend at a matched 1280 × 800 viewport, with the same synthetic API data and interactions in both revisions.

- Before: `52277de24103dad09ae3bab1038b99c830dc5620`
- After: `21456f70cf47a49b30fffdef1681678c263f433c`
- Eleven scenarios, 22 screenshots. The three full-resolution comparison sheets preserve the original screenshots; the overview scales them to half width.
- Every API request was intercepted. No live model, connected account, recipient, backend write, or OS setting was used. Desktop screenshots simulate the renderer bridge and do not demonstrate installed Electron or OS permission behavior.
- Capture completed with no page errors, unexpected API requests, or external requests. Measured states and source revisions are in [the manifest](manifest.json).

## Navigation and chat

The web rail is vertically centered. The sidebar toggle stays at the same position between Chat and Trust. The chat model picker is removed. Closing a pointer-opened context menu no longer leaves an outline around the message, and the reaction no longer has the duplicate shadow. The collapsed default and centered desktop rail were already present and remain unchanged.

![Before and after: navigation and chat](navigation-and-chat.png)

## Onboarding

The conversation composer has no microphone. Desktop notifications and Open at login must be enabled before Continue becomes available. After the last web setup action, onboarding enters the chat without the extra final feedback screen.

![Before and after: onboarding](onboarding.png)

## Vault and completed actions

The revealed synthetic Vault password uses the app font. Credential and payment action buttons disappear only after the mocked server reports `filled` and `submitted`, respectively. Deleting a login keeps its remaining browser session selected, with Sign out visible.

These screenshots demonstrate frontend behavior. They do not establish live credential entry, payment submission, native settings persistence, or server-side browser-session release.

![Before and after: Vault and completed actions](vault-and-sign-in.png)

[Overview of all eleven comparisons](overview.png)

## Browser input

The browser comparison uses the real native Chromium provider on a local synthetic page at a matched 1440 × 900 viewport and 2× page zoom. With the same normalized input, the old mapping misses the target at CSS (432, 270); the corrected mapping hits its center at (216, 135). The baseline is `21456f70`; the manifest records source object IDs for the patch.

![Before and after: browser pointer alignment](browser-pointer.png)

A separate frontend defect dropped clicks while the next JPEG loaded and its natural dimensions were temporarily zero. The client now retains the last displayed frame dimensions. Native Chrome recorded that failure; after the fix, all 400 rapid clicks reached their targets using the actual Chat and BrowserHandoff with a synthetic stream. This does not establish that every website or browser failure is resolved.
