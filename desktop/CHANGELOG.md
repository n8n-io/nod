# Desktop changelog

Releases from before the rename to nod are the `desktop-v*` [GitHub releases](https://github.com/n8n-io/nod/releases).

## 0.1.1 - 2026-10-22

### Breaking changes

- Use OpenAI's official Sign in with ChatGPT and soften safety claims. [#406](https://github.com/n8n-io/nod/pull/406) (a6e8c17)

### Fixes

- **desktop:** Open at login works on macOS. [#407](https://github.com/n8n-io/nod/pull/407) (5a1b3c9)
- **onboarding:** Clip the sent answer while its row opens. [commit](https://github.com/n8n-io/nod/commit/ee121af4d233455ab5c1adb869bd1f759029905c) (ee121af)
- **onboarding:** Grow the interview typing row open as well as closed. [commit](https://github.com/n8n-io/nod/commit/a2314fb19fb4fadcb00b11b02bf4af76b1db6296) (a2314fb)
- **onboarding:** Smooth message reveals and tighten motion. [commit](https://github.com/n8n-io/nod/commit/7b5a7f36cb58eb4789ff1c76a91d43fa9d3b7912) (7b5a7f3)

<details>
<summary>Maintenance (2 changes)</summary>

- **n8n:** Use the renamed nod credential names. [#405](https://github.com/n8n-io/nod/pull/405) (a7c69d6)
- **traces:** Send traces to the LangSmith project by ID. [#404](https://github.com/n8n-io/nod/pull/404) (79550e2)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.1.0...5a1b3c9394fd33287d209699b08d2c32c1540f6b)

<details>
<summary>Build details</summary>

Source: `5a1b3c9394fd33287d209699b08d2c32c1540f6b`
Previous release: `nod-v0.1.0`

</details>

## 0.1.0 - 2026-10-22

### Breaking changes

- Rename Otto to nod. [#398](https://github.com/n8n-io/nod/pull/398) (09037cd)

### Features

- **ui:** Refine chat interactions, secure forms and settings. [#392](https://github.com/n8n-io/nod/pull/392) (bbfd826)
- **trust:** A request covers the steps of its outcome, so nod asks less. [#391](https://github.com/n8n-io/nod/pull/391) (e79bf5d)
- Share onboarding while desktop services prepare. [#378](https://github.com/n8n-io/nod/pull/378) (272456d)
- **telemetry:** Export model metadata to an owner OTLP collector. [#381](https://github.com/n8n-io/nod/pull/381) (a922f9b)

### Fixes

- **desktop:** Compress runtime images without zstd worker threads. [#402](https://github.com/n8n-io/nod/pull/402) (8d3e92f)
- **desktop:** Show why a setup step failed instead of only its exit code. [#397](https://github.com/n8n-io/nod/pull/397) (7c75c3f)
- **memory:** Remember details from earlier messages, written from the owner's own words. [#390](https://github.com/n8n-io/nod/pull/390) (2e8333f)
- **desktop:** Reinstall cleanly after deleting data and add Remove all data. [#389](https://github.com/n8n-io/nod/pull/389) (c9c7f56)
- **onboarding:** Know the owner's name from their connected Gmail account again. [#388](https://github.com/n8n-io/nod/pull/388) (7de4a7d)
- **trust:** Say what the Trust page is for, and name its tabs and Add button. [#384](https://github.com/n8n-io/nod/pull/384) (38698dc)
- End stuck turns at once and kill browsers that stop responding. [#383](https://github.com/n8n-io/nod/pull/383) (f4fd450)
- Tell nod and the owner what actually failed, and take the language only from the owner's words. [#382](https://github.com/n8n-io/nod/pull/382) (21556de)
- **chat:** Keep quick work in chat, acknowledge once, update only after a quiet stretch. [#380](https://github.com/n8n-io/nod/pull/380) (1befa21)
- Keep good first tasks, show connect buttons and live steps, refresh changed dependencies. [#377](https://github.com/n8n-io/nod/pull/377) (dc0c7e4)

### Performance

- **pi:** Keep owner context out of the system prompt so memory changes keep the prompt cache. [#387](https://github.com/n8n-io/nod/pull/387) (e94479a)
- **desktop:** Cut first-launch time and download size. [#386](https://github.com/n8n-io/nod/pull/386) (aaa2a98)
- **pi:** Share one prompt cache key per thread. [#385](https://github.com/n8n-io/nod/pull/385) (52277de)

<details>
<summary>Maintenance (1 changes)</summary>

- **desktop:** Start nod releases at 0.1.0. [#399](https://github.com/n8n-io/nod/pull/399) (4fb80c3)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.0.0...8d3e92fea1a9ad4d5fa80aa846a3e894af780bb8)

<details>
<summary>Build details</summary>

Source: `8d3e92fea1a9ad4d5fa80aa846a3e894af780bb8`
Previous release: `nod-v0.0.0`

</details>
