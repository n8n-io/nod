# LAB-646 keyboard verification

The reported accidental send did not reproduce on main at `4d10edd83708220e1cf14c09b06440b94285777f`. The issue contains the report and build metadata, with no attached image, video or diagnostic file.

The screenshots use the real web app in `scripts/analytics-fixture.ts`, with synthetic messages and no model or connected-account calls. In both send modes, typing the first line, pressing Shift+Return and typing the second line kept the two-line draft in the composer. The message above the draft was sent separately with plain Return to verify the send control.

| Enter sends                                                                   | Enter inserts a line                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| ![Shift+Return keeps a multiline draft when Enter sends](enter-send-mode.jpg) | ![Shift+Return keeps a multiline draft when Enter inserts a line](newline-mode.jpg) |

There is no failing before screenshot: this change adds regression coverage without changing the runtime behavior. The mounted Composer test verifies no send on Shift+Return, the exact multiline payload when sent, both send settings, IME Enter, and rich-text block variations. A browser fixture is not acceptance evidence for the reporter's packaged desktop build.
