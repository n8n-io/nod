# Desktop changelog

Releases from before the rename to nod are the `desktop-v*` [GitHub releases](https://github.com/n8n-io/nod/releases).

## 0.2.3 - 2026-10-23

### Features

- **models:** Connect Amazon Bedrock, Google Vertex AI and Azure OpenAI. [#427](https://github.com/n8n-io/nod/pull/427) (f5ac65b)
- **trust:** Owner rules the trust check applies to every action. [#426](https://github.com/n8n-io/nod/pull/426) (09147f6)
- **ui:** Animate the sidebar and steady its layout. [commit](https://github.com/n8n-io/nod/commit/37091d785b7281c607866121a2639e3ed5555ec4) (37091d7)
- **ui:** Switch to n8n icons and tidy the sidebar and page titles. [commit](https://github.com/n8n-io/nod/commit/7ba4fa7d0eaf944b0aafa3fbb5e77fd1dda2968b) (7ba4fa7)

### Fixes

- **desktop:** Start Windows storage on a free port and name why it can't connect. [#432](https://github.com/n8n-io/nod/pull/432) (748043d)
- **ui:** Use the outline sidebar toggle icon in both states. [commit](https://github.com/n8n-io/nod/commit/ad150fdc7de6b6df2c9b4aae88cf598e6ddd8624) (ad150fd)
- **ui:** Show state in the sidebar toggle and audio play icons. [commit](https://github.com/n8n-io/nod/commit/92f98d75fcf6f6100d76e73c406ca8be8802391d) (92f98d7)
- **ui:** Soften message link underlines. [commit](https://github.com/n8n-io/nod/commit/9b3314300afc93bec784843da45c33143d473deb) (9b33143)
- **desktop:** Start after updating with apps connected before 0.2. [#428](https://github.com/n8n-io/nod/pull/428) (770e64f)
- **ui:** Smooth the chat fade and steady onboarding controls. [commit](https://github.com/n8n-io/nod/commit/3958ee6fbc5be347df4e7c2b4c46807f789dc816) (3958ee6)
- **evals:** Keep overnight release checks valid. [#425](https://github.com/n8n-io/nod/pull/425) (d5d1244)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.2.1...748043d9a43eafa4e25b6e99e9afc52f1377f931)

<details>
<summary>Build details</summary>

Source: `748043d9a43eafa4e25b6e99e9afc52f1377f931`
Previous release: `nod-v0.2.1`

</details>

## 0.2.2 - 2026-10-23

### Features

- **trust:** Owner rules the trust check applies to every action. [#426](https://github.com/n8n-io/nod/pull/426) (09147f6)

### Fixes

- **desktop:** Start after updating with apps connected before 0.2. [#428](https://github.com/n8n-io/nod/pull/428) (770e64f)
- **evals:** Keep overnight release checks valid. [#425](https://github.com/n8n-io/nod/pull/425) (d5d1244)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.2.1...770e64ff65339a35b64bcea26f76d63c1a81fec5)

<details>
<summary>Build details</summary>

Source: `770e64ff65339a35b64bcea26f76d63c1a81fec5`
Previous release: `nod-v0.2.1`

</details>

## 0.2.1 - 2026-10-22

### Features

- **channels:** Add WhatsApp QR setup and media for Telegram. [#423](https://github.com/n8n-io/nod/pull/423) (451e6f8)
- One activity model for live progress and typing on every surface. [#421](https://github.com/n8n-io/nod/pull/421) (a8ae5a1)
- **web:** Rename Activity and Logins and payment to Usage and Vault. [#422](https://github.com/n8n-io/nod/pull/422) (543867e)
- **web:** Split Trust into Activity and Logins and payment. [#419](https://github.com/n8n-io/nod/pull/419) (d206020)

### Fixes

- **desktop:** Keep Windows starting after the first launch. [#418](https://github.com/n8n-io/nod/pull/418) (0a53b79)
- **web:** Clear model step, visible selection in sent messages, task line says what it's doing. [#417](https://github.com/n8n-io/nod/pull/417) (62e58db)

<details>
<summary>Maintenance (1 changes)</summary>

- **desktop:** Cut release build time with parallel Mac checks, faster runners and multithreaded image compression. [#420](https://github.com/n8n-io/nod/pull/420) (a7d8112)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.2.0...451e6f8581d29cc93fe86249e966f5374bfb694e)

<details>
<summary>Build details</summary>

Source: `451e6f8581d29cc93fe86249e966f5374bfb694e`
Previous release: `nod-v0.2.0`

</details>

## 0.2.0 - 2026-10-22

### Features

- Streamline app connections and onboarding. [#394](https://github.com/n8n-io/nod/pull/394) (b9178f9)
- **n8n:** Build, test and publish n8n workflows and Agents through n8n's MCP server. [#395](https://github.com/n8n-io/nod/pull/395) (32b8873)

### Fixes

- **privacy:** Scrub feedback reports, make them opt-in, drop computer name and weekly ID. [#414](https://github.com/n8n-io/nod/pull/414) (3d87f3d)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.1.1...cc64f5b2b9846912ff47a1089428a12f6d115b78)

<details>
<summary>Build details</summary>

Source: `cc64f5b2b9846912ff47a1089428a12f6d115b78`
Previous release: `nod-v0.1.1`

</details>

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

- Adopt nod product naming. [#398](https://github.com/n8n-io/nod/pull/398) (09037cd)

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
