# Desktop changelog

Releases from before the rename to nod are the `desktop-v*` [GitHub releases](https://github.com/n8n-io/nod/releases).

## 0.1.0 - 2026-10-22

### Breaking changes

- Rename Otto to nod. [#398](https://github.com/n8n-io/nod/pull/398) (09037cd)

### Features

- **ui:** Refine chat interactions, secure forms and settings. [#392](https://github.com/n8n-io/nod/pull/392) (bbfd826)
- **trust:** A request covers the steps of its outcome, so Otto asks less. [#391](https://github.com/n8n-io/nod/pull/391) (e79bf5d)
- Share onboarding while desktop services prepare. [#378](https://github.com/n8n-io/nod/pull/378) (272456d)
- **telemetry:** Export model metadata to an owner OTLP collector. [#381](https://github.com/n8n-io/nod/pull/381) (a922f9b)

### Fixes

- **desktop:** Show why a setup step failed instead of only its exit code. [#397](https://github.com/n8n-io/nod/pull/397) (7c75c3f)
- **memory:** Remember details from earlier messages, written from the owner's own words. [#390](https://github.com/n8n-io/nod/pull/390) (2e8333f)
- **desktop:** Reinstall cleanly after deleting data and add Remove all data. [#389](https://github.com/n8n-io/nod/pull/389) (c9c7f56)
- **onboarding:** Know the owner's name from their connected Gmail account again. [#388](https://github.com/n8n-io/nod/pull/388) (7de4a7d)
- **trust:** Say what the Trust page is for, and name its tabs and Add button. [#384](https://github.com/n8n-io/nod/pull/384) (38698dc)
- End stuck turns at once and kill browsers that stop responding. [#383](https://github.com/n8n-io/nod/pull/383) (f4fd450)
- Tell Otto and the owner what actually failed, and take the language only from the owner's words. [#382](https://github.com/n8n-io/nod/pull/382) (21556de)
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

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.0.0...4fb80c3611087556d461b24ac261bfa70cc2c553)

<details>
<summary>Build details</summary>

Source: `4fb80c3611087556d461b24ac261bfa70cc2c553`
Previous release: `nod-v0.0.0`

</details>
