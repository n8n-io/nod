# Desktop changelog

Releases from before the rename to Nod are the `desktop-v*` [GitHub releases](https://github.com/n8n-io/nod/releases).

## 0.3.0 - 2026-10-26

### Features

- **chat:** Add native inline visuals for richer answers. [#466](https://github.com/n8n-io/nod/pull/466) (b74b986)

### Fixes

- **files:** Reclaim abandoned uploads. [#483](https://github.com/n8n-io/nod/pull/483) (7d7e360)

### Performance

- **runtime:** Reuse cached prompts and tool catalogs. [#486](https://github.com/n8n-io/nod/pull/486) (28eb93b)
- **desktop:** Remove duplicate Mac notarization. [#487](https://github.com/n8n-io/nod/pull/487) (6e19874)
- **ci:** Cut desktop release waits and transfers. [#485](https://github.com/n8n-io/nod/pull/485) (3ca9aae)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.2.6...28eb93baf0cf498017b71709950fbbdff9a8cfb6)

<details>
<summary>Build details</summary>

Source: `28eb93baf0cf498017b71709950fbbdff9a8cfb6`
Previous release: `nod-v0.2.6`

</details>

## 0.2.6 - 2026-10-26

### Features

- **proactivity:** Add a proactivity engine. [#479](https://github.com/n8n-io/nod/pull/479) (1289bf7)
- Make nod easy to self-host with secure remote app access. [#452](https://github.com/n8n-io/nod/pull/452) (474f36b)
- **onboarding:** Streamline setup and first-chat suggestions. [#461](https://github.com/n8n-io/nod/pull/461) (d1c0e15)
- **chat:** Add real audio waveforms and playback controls. [#464](https://github.com/n8n-io/nod/pull/464) (e58d570)
- **models:** Add native model providers and Google Gemini setup. [#451](https://github.com/n8n-io/nod/pull/451) (75c5959)
- **feedback:** Include redacted messages, tool details and rotating logs. [#453](https://github.com/n8n-io/nod/pull/453) (6799703)
- **ux:** Add native chat and file interactions. [commit](https://github.com/n8n-io/nod/commit/87b728f7dcc00f72bfca994afa196d421326dd8c) (87b728f)
- **tasks:** Stop all background work when the owner asks in chat. [#444](https://github.com/n8n-io/nod/pull/444) (f4b6e81)
- **onboarding:** Redesign model selection as one provider card. [commit](https://github.com/n8n-io/nod/commit/f27fa1ce4be8b1ab1345bf68e19d8447af8aee9d) (f27fa1c)

### Fixes

- **runtime:** Deliver results before follow-up offers. [#482](https://github.com/n8n-io/nod/pull/482) (bc2fefa)
- **agent:** Translate source wording instead of mixing languages. [#480](https://github.com/n8n-io/nod/pull/480) (4da6f52)
- **chat:** Restore attachment picker without send mode control. [#463](https://github.com/n8n-io/nod/pull/463) (e35d872)
- **apps:** Polish OAuth recovery for Gmail and MCP. [#458](https://github.com/n8n-io/nod/pull/458) (755fd00)
- **chat:** Remove composer mode and attachment buttons. [#462](https://github.com/n8n-io/nod/pull/462) (c9f1502)
- **chat:** Preserve identifying context in source references. [#460](https://github.com/n8n-io/nod/pull/460) (f5e5b14)
- **chat:** Preserve page labels in link previews. [#459](https://github.com/n8n-io/nod/pull/459) (21f4f64)
- **chat:** Preserve Shift+Return in task and schedule requests. [#456](https://github.com/n8n-io/nod/pull/456) (9ac3386)
- **apps:** Preserve missing-scope recovery for connected accounts. [#455](https://github.com/n8n-io/nod/pull/455) (e64122c)
- **apps:** Preserve icons on expired connection cards. [#454](https://github.com/n8n-io/nod/pull/454) (a3294d5)
- **feedback:** Include content-free bug diagnostics by default. [#450](https://github.com/n8n-io/nod/pull/450) (4d10edd)
- **chat:** Preserve links and keep replies readable. [commit](https://github.com/n8n-io/nod/commit/4014d5e879ace35b2f9bef7785254f1a3874a2b0) (4014d5e)
- **channels:** Remove stale WhatsApp QR codes. [commit](https://github.com/n8n-io/nod/commit/55b8a2ff325d52539c9e7b88915ffefc6a521f0d) (55b8a2f)
- **onboarding:** Address review feedback and leave out the playground. [commit](https://github.com/n8n-io/nod/commit/263eaa157a012bc124a1f53257707c5cf5f03ec4) (263eaa1)
- **browser:** Make handoff explicit and show who has control. [commit](https://github.com/n8n-io/nod/commit/e85795732057dcdef93921043a7e0f53be0845a5) (e857957)
- **models:** Repair the same account on sign-in and show connections that need reconnecting. [#442](https://github.com/n8n-io/nod/pull/442) (879a2cb)
- **ci:** Mount desktop preload files in integration tests. [#441](https://github.com/n8n-io/nod/pull/441) (05d0ce9)
- **feedback:** Keep reports sendable when diagnostics are incomplete. [#436](https://github.com/n8n-io/nod/pull/436) (6869b0f)

<details>
<summary>Maintenance (14 changes)</summary>

- Capitalise Nod in prose, UI text and docs. [#481](https://github.com/n8n-io/nod/pull/481) (1906cb1)
- **deps:** Bump the chat-sdk group across 1 directory with 4 updates. [commit](https://github.com/n8n-io/nod/commit/e92b463ab1e1c6c28c25b1287676e4cba6b34077) (e92b463)
- **deps-dev:** Bump lucide-react from 1.58.0 to 1.61.0. [commit](https://github.com/n8n-io/nod/commit/14af35dc9cc9b429ac2180d76153c2bd27291749) (14af35d)
- **deps:** Bump agent-browser from 0.39.1 to 0.39.2. [commit](https://github.com/n8n-io/nod/commit/31a6fb2f61ba502c14e873e728f740c0ccb1f5ca) (31a6fb2)
- **deps:** Bump undici from 8.12.2 to 8.12.3. [commit](https://github.com/n8n-io/nod/commit/abab9e858cdf1c96f153fc144ccaadb4fc1014eb) (abab9e8)
- **deps:** Bump jose from 6.2.12 to 6.2.13. [#471](https://github.com/n8n-io/nod/pull/471) (141aebe)
- **deps:** Bump the docs group across 1 directory with 2 updates. [commit](https://github.com/n8n-io/nod/commit/14d0ad3d4cc0783ef4ddb2e7b43938fc91750e0d) (14d0ad3)
- Remove tests that add no coverage and the web UI tests in JSDOM. [#478](https://github.com/n8n-io/nod/pull/478) (bff8856)
- **deps:** Bump tldts from 7.4.18 to 7.4.19. [#472](https://github.com/n8n-io/nod/pull/472) (ce02429)
- **deps:** Bump @fastify/static from 10.1.5 to 10.1.7. [#475](https://github.com/n8n-io/nod/pull/475) (78bf585)
- **deps:** Bump posthog-node from 5.56.1 to 5.57.0. [#476](https://github.com/n8n-io/nod/pull/476) (880089f)
- **deps:** Bump dotenv from 18.0.8 to 18.0.9. [#469](https://github.com/n8n-io/nod/pull/469) (a360aa3)
- **deps:** Bump the pi group across 1 directory with 2 updates. [#467](https://github.com/n8n-io/nod/pull/467) (17df0fb)
- Remove internal review artifacts. [#457](https://github.com/n8n-io/nod/pull/457) (a4a9537)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.2.4...bc2fefae795ae60e94bdc72a17c515d46f479220)

<details>
<summary>Build details</summary>

Source: `bc2fefae795ae60e94bdc72a17c515d46f479220`
Previous release: `nod-v0.2.4`

</details>

## 0.2.5 - 2026-10-23

### Features

- **tasks:** Stop all background work when the owner asks in chat. [#444](https://github.com/n8n-io/nod/pull/444) (f4b6e81)
- **onboarding:** Redesign model selection as one provider card. [commit](https://github.com/n8n-io/nod/commit/f27fa1ce4be8b1ab1345bf68e19d8447af8aee9d) (f27fa1c)

### Fixes

- **chat:** Preserve links and keep replies readable. [commit](https://github.com/n8n-io/nod/commit/4014d5e879ace35b2f9bef7785254f1a3874a2b0) (4014d5e)
- **channels:** Remove stale WhatsApp QR codes. [commit](https://github.com/n8n-io/nod/commit/55b8a2ff325d52539c9e7b88915ffefc6a521f0d) (55b8a2f)
- **onboarding:** Address review feedback and leave out the playground. [commit](https://github.com/n8n-io/nod/commit/263eaa157a012bc124a1f53257707c5cf5f03ec4) (263eaa1)
- **browser:** Make handoff explicit and show who has control. [commit](https://github.com/n8n-io/nod/commit/e85795732057dcdef93921043a7e0f53be0845a5) (e857957)
- **models:** Repair the same account on sign-in and show connections that need reconnecting. [#442](https://github.com/n8n-io/nod/pull/442) (879a2cb)
- **ci:** Mount desktop preload files in integration tests. [#441](https://github.com/n8n-io/nod/pull/441) (05d0ce9)
- **feedback:** Keep reports sendable when diagnostics are incomplete. [#436](https://github.com/n8n-io/nod/pull/436) (6869b0f)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.2.4...4014d5e879ace35b2f9bef7785254f1a3874a2b0)

<details>
<summary>Build details</summary>

Source: `4014d5e879ace35b2f9bef7785254f1a3874a2b0`
Previous release: `nod-v0.2.4`

</details>

## 0.2.4 - 2026-10-23

### Features

- Add app links and model selection from chat. [#438](https://github.com/n8n-io/nod/pull/438) (31f0a10)
- **web:** Useful empty states for Tasks and Vault. [#437](https://github.com/n8n-io/nod/pull/437) (81bc0d5)
- **trust:** Authenticator keys, 1Password sign-in, quoted trust reasons and receipts. [#431](https://github.com/n8n-io/nod/pull/431) (8689fd8)

### Fixes

- **onboarding:** Say which setup step is missing and go back to it. [#439](https://github.com/n8n-io/nod/pull/439) (80bf1ca)

<details>
<summary>Maintenance (2 changes)</summary>

- **desktop:** Reuse the published Windows runtime within a week and rebuild runtimes weekly. [#435](https://github.com/n8n-io/nod/pull/435) (d835c85)
- **desktop:** Cut release time with Blacksmith M4 Macs, a larger publisher and overlapped Windows work. [#434](https://github.com/n8n-io/nod/pull/434) (5b36df1)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.2.3...80bf1ca923053b68d9419c28ea858e0267c19324)

<details>
<summary>Build details</summary>

Source: `80bf1ca923053b68d9419c28ea858e0267c19324`
Previous release: `nod-v0.2.3`

</details>

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

- **n8n:** Use the renamed Nod credential names. [#405](https://github.com/n8n-io/nod/pull/405) (a7c69d6)
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

- Adopt Nod product naming. [#398](https://github.com/n8n-io/nod/pull/398) (09037cd)

### Features

- **ui:** Refine chat interactions, secure forms and settings. [#392](https://github.com/n8n-io/nod/pull/392) (bbfd826)
- **trust:** A request covers the steps of its outcome, so Nod asks less. [#391](https://github.com/n8n-io/nod/pull/391) (e79bf5d)
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
- Tell Nod and the owner what actually failed, and take the language only from the owner's words. [#382](https://github.com/n8n-io/nod/pull/382) (21556de)
- **chat:** Keep quick work in chat, acknowledge once, update only after a quiet stretch. [#380](https://github.com/n8n-io/nod/pull/380) (1befa21)
- Keep good first tasks, show connect buttons and live steps, refresh changed dependencies. [#377](https://github.com/n8n-io/nod/pull/377) (dc0c7e4)

### Performance

- **pi:** Keep owner context out of the system prompt so memory changes keep the prompt cache. [#387](https://github.com/n8n-io/nod/pull/387) (e94479a)
- **desktop:** Cut first-launch time and download size. [#386](https://github.com/n8n-io/nod/pull/386) (aaa2a98)
- **pi:** Share one prompt cache key per thread. [#385](https://github.com/n8n-io/nod/pull/385) (52277de)

<details>
<summary>Maintenance (1 changes)</summary>

- **desktop:** Start Nod releases at 0.1.0. [#399](https://github.com/n8n-io/nod/pull/399) (4fb80c3)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.0.0...8d3e92fea1a9ad4d5fa80aa846a3e894af780bb8)

<details>
<summary>Build details</summary>

Source: `8d3e92fea1a9ad4d5fa80aa846a3e894af780bb8`
Previous release: `nod-v0.0.0`

</details>
