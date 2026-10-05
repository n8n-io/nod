# Desktop changelog

## 0.1.2 - 2026-10-05

Source: `782c0890f7bc60aa7896e32c0b3874ee4007df0b`
Previous release: `desktop-v0.1.1`

- The application and installer are now named **Otto**. This release uses a new application identity and profile: install 0.1.2 manually and complete fresh onboarding. Previous Otto Preview data stays untouched; it is not migrated. (#114) (782c089)
- First launch automatically downloads and verifies the matching computer and browser runtime through the configured download service.
- Desktop uses the shared product onboarding and model connections, including provider API keys, ChatGPT plans and OpenRouter. (#113) (933cbb2)
- One Settings screen is available from the app and native menus, with protection for unfinished setup, profile and credential forms.
- Update menus show preparation/download progress and retain **Restart to update** after choosing **Later**. Automatic updates can be tested from this clean 0.1.2 baseline to the next Otto release.

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
