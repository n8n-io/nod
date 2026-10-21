# Feedback fixes: before and after

The first eleven comparisons use read-only snapshots of the branch base and final application source at a matched 1280 × 800 viewport, with the same synthetic data and interactions. The baseline captures were preserved; all eleven after captures were refreshed on 2026-10-21 against the final source revision.

- Before: `e79bf5d2fcfcadb093102c31f1e240b44cd210ce`
- After: `be9595b92b0101cb0fa2295313a1b764bb84b2f6`
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

A separate frontend defect dropped clicks while the next JPEG loaded and its natural dimensions were temporarily zero. The client now retains the last displayed frame dimensions. Native Chrome recorded that failure; after the fix, all 400 rapid click inputs were accepted using the actual Chat and BrowserHandoff with a synthetic stream. This does not establish that every website or browser failure is resolved.

## PDF attachments

The same one-page synthetic PDF failed to render on Chrome 142 with `pdfjs-dist` 6.4.299’s modern build: `getOrInsertComputed` was unavailable during rendering. The app now loads the documented compatibility build and its matching worker. The installed package’s `README.md` (lines 10–12) recommends `legacy/` for environments missing newer JavaScript features; see the [PDF.js browser support documentation](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#faq-support).

![Before and after: PDF rendering](pdf-rendering.png)

These are actual application screenshots at 1280 × 800 and 390 × 800 in light and dark themes. The baseline is `c60a75f8`; the fixed component source object is `db8009123d59a18788b5c114c796ca60738e9504`. All four baseline previews failed; all four fixed previews rendered visible text pixels. Text extraction, Zoom in/out, Fit page, and Fit width also passed against the real renderer. The browser was unmodified, with no compatibility shim or renderer mock.

The [detailed measurements](pdf-rendering.json) retain the original failure, source objects, canvas dimensions, screenshot digests, and the hash of the [synthetic PDF](pdf-fixture.pdf). Every API request was intercepted; this verifies frontend rendering, not live upload storage or account access.
