# Feedback fixes: before and after

The first eleven comparisons use read-only snapshots of the branch base and final application source at a matched 1280 × 800 viewport, with the same synthetic product state and interactions. The baseline captures were preserved; all eleven after captures were refreshed on 2026-10-21 against the final source revision.

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

For the completed-action scenario, both revision fixtures represent the semantic state `filled` for credentials and `submitted` for payments. The credential transport differs: the baseline fixture makes full synthetic request metadata available at `/api/credential-requests/:token`; the after fixture serves `{ status: "filled" }` at `/api/credential-requests/:token/status`. This comparison verifies the UI outcome for completed requests, not identical response bytes or the server endpoint contract.

These screenshots demonstrate frontend behavior. They do not establish live credential entry, payment submission, native settings persistence, or server-side browser-session release.

![Before and after: Vault and completed actions](vault-and-sign-in.png)

[Overview of all eleven comparisons](overview.png)

## Browser input

The pointer and loading-frame checks were rerun against `ec9c7eebcd7c44dee7e556562c8812b8751ca261`. The original failing `21456f70` captures are preserved. The manifest records the current provider and component source objects, including `browser-handoff.tsx` object `861a4f983fda119f6e6171bec86e7c1fdca8380e` with the later `onLoad` update.

The native Chromium provider comparison uses the same local synthetic page, 1440 × 900 viewport, 2× page zoom and normalized input. The old mapping misses at CSS (432, 270); the current source hits the center at (216, 135). The fresh run waits for a decoded JPEG containing a post-zoom marker before sending the click. [Pointer measurements](browser-pointer-results.json) and [original PNGs](browser-screenshots/) are committed.

![Before and after: browser pointer alignment](browser-pointer.png)

The separate loading-frame check uses the actual Chat and BrowserHandoff in the review harness with a synthetic JPEG stream. All 400 rapid click inputs were accepted, with 400 down and 400 up events posted. 6 mouse-downs arrived while natural image dimensions were zero and were still accepted, exercising the changed loading path. The [detailed measurements](browser-loading-frame.json) preserve the original failure at input 40 and the new per-input results. These acknowledgments do not prove 400 native target hits or live provider delivery.

![Before and after: loading-frame inputs](browser-loading-frame.png)

## PDF attachments

The same one-page synthetic PDF failed to render on Chrome 142 with `pdfjs-dist` 6.4.299’s modern build: `getOrInsertComputed` was unavailable during rendering. The app now loads the documented compatibility build and its matching worker. The installed package’s `README.md` (lines 10–12) recommends `legacy/` for environments missing newer JavaScript features; see the [PDF.js browser support documentation](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#faq-support).

![Before and after: PDF rendering](pdf-rendering.png)

These are actual application screenshots at 1280 × 800 and 390 × 800 in light and dark themes. The baseline is `c60a75f8`; the fixed component source object is `db8009123d59a18788b5c114c796ca60738e9504`. All four baseline previews failed; all four fixed previews rendered visible text pixels. Text extraction, Zoom in/out, Fit page, and Fit width also passed against the real renderer. The browser was unmodified, with no compatibility shim or renderer mock.

The [detailed measurements](pdf-rendering.json) retain the original failure, source objects, canvas dimensions, screenshot digests, and the hash of the [synthetic PDF](pdf-fixture.pdf). All eight [per-run PNGs](pdf-screenshots/) are committed at the relative paths recorded in the JSON, so each digest can be verified. Every API request was intercepted; this verifies frontend rendering, not live upload storage or account access.
