# Desktop changelog

## 0.1.11 - 2026-10-09

### Features

- **release:** Publish three Otto binaries and select CI checks by changed code. [commit](https://github.com/n8n-io/otto/commit/927f9cf87a2b6d31d6a48dc4a2032f41249cdee1) (927f9cf)
- **web:** Polish the desktop top bar, sidebar and settings. [#211](https://github.com/n8n-io/otto/pull/211) (991b737)
- **desktop:** Add an installable Windows preview alongside Mac. [#207](https://github.com/n8n-io/otto/pull/207) (7ce4590)
- **release:** Publish signed Mac binaries from a reviewed release PR. [#208](https://github.com/n8n-io/otto/pull/208) (a7db12b)
- Enforce spending limits and show request cost in chat. [#205](https://github.com/n8n-io/otto/pull/205) (a03f2e6)
- Move the sidebar toggle next to the page title and tint hovered icons. [#161](https://github.com/n8n-io/otto/pull/161) (08b15d7)
- Make onboarding a three-question chat on the new design with instant first tasks. [commit](https://github.com/n8n-io/otto/commit/954d88145311a74de67d897ef6aa31daac3c0004) (954d881)

### Fixes

- **release:** Use release environment and sufficient build storage. [#215](https://github.com/n8n-io/otto/pull/215) (fd7e1a7)
- **release:** Run capability reports outside the build queue. [#210](https://github.com/n8n-io/otto/pull/210) (b0e0326)
- Honor schedule cancellation without repeated confirmations. [#178](https://github.com/n8n-io/otto/pull/178) (11f8f4a)
- Save desktop artifacts to Downloads (LAB-531). [#169](https://github.com/n8n-io/otto/pull/169) (31eeed0)

### Other changes

- Replace the Inspector with a Trust ledger, spending limit and /usage. [#202](https://github.com/n8n-io/otto/pull/202) (c69a7f9)
- Bundle RTK for automatic workspace token savings. [#203](https://github.com/n8n-io/otto/pull/203) (c63ee06)
- Keep desktop memory in Postgres, state schedule availability and confirm Otto-started writes. [#201](https://github.com/n8n-io/otto/pull/201) (fbf8c50)
- Add security policy, contribution guide and public install docs. [#200](https://github.com/n8n-io/otto/pull/200) (468902c)
- Compare every release with the previous one and gate on proven scenarios. [#181](https://github.com/n8n-io/otto/pull/181) (521b616)
- Call Otto's API from catalog scenarios through the authenticated session. [#184](https://github.com/n8n-io/otto/pull/184) (4994fe7)
- Add Apache 2.0 license. [#182](https://github.com/n8n-io/otto/pull/182) (b56360c)
- Offer to save browser logins and schedule completed tasks. [#180](https://github.com/n8n-io/otto/pull/180) (31d2341)
- Fix layout-generated characters in the inline browser. [#176](https://github.com/n8n-io/otto/pull/176) (3dedd52)
- Never count a tapped first task as the owner's request in the trust check. [#179](https://github.com/n8n-io/otto/pull/179) (2bc71c2)
- Add an onboarding and first-value eval and compare each release with the previous one. [#177](https://github.com/n8n-io/otto/pull/177) (a5b2fdc)
- Fix security audit findings without limiting capability. [#172](https://github.com/n8n-io/otto/pull/172) (95358e9)
- Expand app discovery and reconnect saved accounts safely. [#166](https://github.com/n8n-io/otto/pull/166) (d783d5a)
- Read eval workspace files as the sandbox user and fix the video and Slack scenarios. [#175](https://github.com/n8n-io/otto/pull/175) (7c097be)
- Accept BotFather message paste and clarify Telegram pairing. [#168](https://github.com/n8n-io/otto/pull/168) (4056597)
- Fix eval harness workspace permissions and three scenario flaws. [#174](https://github.com/n8n-io/otto/pull/174) (245f2f4)
- Pass eval runs with incomplete attempts and report them. [#173](https://github.com/n8n-io/otto/pull/173) (759796e)
- Run all controlled capability cases by default. [#171](https://github.com/n8n-io/otto/pull/171) (1271511)
- Rebuild onboarding as a guided conversation. [commit](https://github.com/n8n-io/otto/commit/d0d205a76bbec289de7acbd8e6c4355c228654f7) (d0d205a)

<details>
<summary>Maintenance (13 changes)</summary>

- Remove archived RTK evaluation reports. [#209](https://github.com/n8n-io/otto/pull/209) (d6db565)
- **repo:** Use pnpm and check conventional PR titles. [#206](https://github.com/n8n-io/otto/pull/206) (48e0384)
- **deps:** Bump @modelcontextprotocol/sdk from 1.30.1 to 1.32.1. [#196](https://github.com/n8n-io/otto/pull/196) (f678c34)
- **deps:** Bump dotenv from 17.4.2 to 18.0.5. [#194](https://github.com/n8n-io/otto/pull/194) (17d997b)
- **deps:** Bump the chat-sdk group across 1 directory with 4 updates. [#190](https://github.com/n8n-io/otto/pull/190) (437687b)
- **deps:** Bump docker/build-push-action from 6.19.2 to 7.4.0. [#187](https://github.com/n8n-io/otto/pull/187) (a12bf0c)
- **deps:** Bump docker/setup-buildx-action from 3.12.0 to 4.4.1. [#188](https://github.com/n8n-io/otto/pull/188) (4c0f047)
- **deps:** Bump the tiptap group across 1 directory with 10 updates. [#189](https://github.com/n8n-io/otto/pull/189) (c563a4f)
- **deps:** Bump e2b from 2.51.0 to 2.52.1. [#193](https://github.com/n8n-io/otto/pull/193) (5efdb06)
- **deps:** Bump pg from 8.23.0 to 8.23.1. [#197](https://github.com/n8n-io/otto/pull/197) (12b2fe0)
- **deps:** Bump @fastify/static from 10.1.4 to 10.1.5. [#198](https://github.com/n8n-io/otto/pull/198) (2d444a2)
- **deps:** Bump useblacksmith/setup-docker-builder. [#186](https://github.com/n8n-io/otto/pull/186) (b1497e2)
- Automate dependency updates with Dependabot. [#183](https://github.com/n8n-io/otto/pull/183) (6c3af62)

</details>

[Full changelog](https://github.com/n8n-io/otto/compare/desktop-v0.1.10...fd7e1a73989b83c42d667db6bcab86259ebd25cf)

<details>
<summary>Build details</summary>

Source: `fd7e1a73989b83c42d667db6bcab86259ebd25cf`
Previous release: `desktop-v0.1.10`

</details>

## 0.1.9 - 2026-10-07

When Otto hands you its browser, you now see it live, and the app has a softer, rounder look.

### Browser handoff

- The handoff panel shows Otto's browser live, so spinners, redirects and popups appear as they happen (35515c7)
- New **Back** and **Reload** buttons, and popups open in the same panel
- Sign-ins that offer a passkey show their other methods instead of freezing
- Background tasks no longer keep the handoff on "Opening Otto's browser…" or change the page while you use it (3c3745f)

### Look and feel

- Rounder buttons, chips and tabs, a lighter sidebar and a rounder chat box (646f283)
- Memory is now a tab in Settings; ⌘Y and `/memory` open it from anywhere (8b6e430)
- Task cards show a one-line summary, with **See details** for the full prompt and timing
- Apps and Channels share one card layout
- Outline buttons and chips stay visible in the dark theme

### Feedback

- Paste images and documents into **Send feedback**, and mark up screenshots with pen, highlights, cover and comments (86adca3)
- Unsent feedback is kept if you close or reload
- Pasting into chat keeps line breaks

### Fixes

- Scheduled and event tasks no longer pick up a request from the conversation in progress (86adca3)

Source: `50d4639cdc3517c7de3f9a58384c9c1842ed84eb`
Previous release: `desktop-v0.1.8`

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
