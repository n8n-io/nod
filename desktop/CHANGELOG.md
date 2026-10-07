# Desktop changelog

## 0.1.8 - 2026-10-07

Otto now shows what it remembers about you, where it learned it, and lets you change it.

### Memory

- A new **Memory** page (⌘Y) lists every note Otto keeps, with the message it came from (c6994ee)
- Each note has a clear status: **Mentioned once**, **Learned**, **Confirmed** or **Let go**
- Confirm a guess, edit a note, set an end date, forget it, or add your own
- Bring back anything Otto let go
- Health, religion, politics and similar topics are no longer learned unless you turn them on
- Export everything as a Markdown file from the Memory page or Settings (5ad2b77)
- Send `/memory` to Otto on Telegram or WhatsApp for a quick summary; on Telegram the file comes with it

### Tasks

- Schedules now live in Tasks, with **Current**, **Scheduled** and **Previous** views (00723b9)

### Apps and files

- Files from connected apps, like Slack images or email attachments, are saved to Otto's workspace and read before Otto summarizes them (0fa975a)
- Otto can attach workspace files when it sends email or uses other apps (388be19)

### Updates and fixes

- **Restart to update** works like **Quit Otto**, and only asks first when work is running (5c76981)
- The browser sign-in control stays on the request that is waiting for it (5911bfa)

Source: `5ad2b77f4aaa47f5f617cc24054160c961c071df`
Previous release: `desktop-v0.1.7`

## 0.1.7 - 2026-10-06

Otto has a new look based on the updated n8n design.

- Baumer fonts, neutral surfaces, and pink actions in the web and desktop apps (90caa7a)
- Consistent spacing and outline icons across the app
- Updated sign-in, setup, and empty chat layouts
- Better text contrast, keyboard access, and focus in light and dark themes

Source: `90caa7ad7de48b4a270ad0705d5ba0b439c22155`
Previous release: `desktop-v0.1.6`

## 0.1.3 - 2026-10-05

Source: `4a191997bfefaa409f702ca41d16f88ce3540566`
Previous release: `desktop-v0.1.2`

- Allow inference-capable OpenAI keys that cannot list models during setup (#121) (fece5b1)
- Keep OpenRouter models with variable pricing available (#120) (459dfc2)
- Open the browser handoff in a larger modal view (#122) (982e1c2)
- Load trusted task skills on demand (#115) (33d3997)
- Add trust checks for outside app actions and untrusted results (#119) (523a0be)
- Enable product analytics and masked session recordings by default in app, web, and hosted sessions (#123) (4a19199)
- Allow the public PostHog project token in its analytics configuration while retaining secret checks (#124) (271799f)

## 0.1.2 - 2026-10-05

Source: `0662e781e357b932f49b0914c0b531f9dab1d1c0`
Previous release: `desktop-v0.1.1`

- The application and installer are now named **Otto**. This release uses a new application identity and profile: install 0.1.2 manually and complete fresh onboarding. Previous Otto Preview data stays untouched; it is not migrated. (#114) (782c089)
- First launch automatically downloads and verifies the matching computer and browser runtime through the configured download service.
- Desktop uses the shared product onboarding and model connections, including provider API keys, ChatGPT plans and OpenRouter. (#113) (933cbb2)
- One Settings screen is available from the app and native menus, with protection for unfinished setup, profile and credential forms.
- Update menus show preparation/download progress and retain **Restart to update** after choosing **Later**. Automatic updates can be tested from this clean 0.1.2 baseline to the next Otto release.
- Interrupted update recovery keeps work paused until the engine confirms it has resumed, with explicit **Try again** and **Quit Otto** actions. (#117) (0662e78)

## 0.1.1 - 2026-10-04

Source: `b1cb5047b2d9a4aa90b3746453f85ce2c56a5af1`
Previous release: `desktop-v0.1.0`

- feat(desktop): prepare signed updates and preserve work on restart (#111) (b1cb504)
- feat: Download videos from links as playable MP4s with save-video (#110) (d4c1d31)
- fix(deploy): prepare container images before pausing admission (#109) (a40a4e0)

## 0.1.0 - 2026-10-04

Source: `d58481d2369f05b378743d0137b9ec47d0d6ee1e`
Previous release: none

- Add macOS alpha with onboarding and integration improvements (#97) (011fef9)
