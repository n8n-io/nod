# Feedback fixes: before and after

The first eleven comparisons were recaptured on 2026-10-21 from read-only snapshots of the exact PR base and rebased application frontend at a matched 1280 × 800 viewport, with the same synthetic API data and interactions in both revisions.

- Before: `e79bf5d2fcfcadb093102c31f1e240b44cd210ce`
- After: `f1d7d4d18f6914686ca7b5982fde766b9e0e9c33`
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
