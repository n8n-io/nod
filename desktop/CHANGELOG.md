# Desktop changelog

## 0.1.18 - 2026-10-20

### Features

- **chat:** Preview linked pages with images and play videos inline. [#375](https://github.com/n8n-io/otto/pull/375) (e289a3e)
- **onboarding:** Run the setup interview from one skill file. [#374](https://github.com/n8n-io/otto/pull/374) (b9dca01)
- **settings:** One General tab and ask about usage data at the start of setup. [#368](https://github.com/n8n-io/otto/pull/368) (1d3edce)
- **web:** Open every file in a side panel next to the chat. [#371](https://github.com/n8n-io/otto/pull/371) (9ec1014)
- **analytics:** Define real jobs and count weekly installations. [#369](https://github.com/n8n-io/otto/pull/369) (c94ba33)
- **memory:** Import memory from another assistant. [#370](https://github.com/n8n-io/otto/pull/370) (afe0b24)

### Fixes

- **analytics:** Link What's shared to the live docs site. [#373](https://github.com/n8n-io/otto/pull/373) (5f1eefc)
- **integrations:** Stop a false sign-in error after Easy Connect succeeds. [#372](https://github.com/n8n-io/otto/pull/372) (a4a11f6)
- **approvals:** Return approved-action failures to the task and record only questions. [#367](https://github.com/n8n-io/otto/pull/367) (4cf52a5)

[Full changelog](https://github.com/n8n-io/otto/compare/desktop-v0.1.17...e289a3e31a59589cd89b945efb55e1e554d5ad08)

<details>
<summary>Build details</summary>

Source: `e289a3e31a59589cd89b945efb55e1e554d5ad08`
Previous release: `desktop-v0.1.17`

</details>

## 0.1.17 - 2026-10-20

### Breaking changes

- Remove E2B and hosted mode so Otto runs locally only. [#345](https://github.com/n8n-io/otto/pull/345) (2f193f2)
- **vault:** Never store card security codes. [#336](https://github.com/n8n-io/otto/pull/336) (5d95a26)

### Features

- **analytics:** Complete product analytics coverage and fix recording leaks. [#361](https://github.com/n8n-io/otto/pull/361) (3c8635b)
- **traces:** Opt-in conversation traces to LangSmith with on-device PII scrubbing. [#359](https://github.com/n8n-io/otto/pull/359) (19cb8ab)
- **tasks:** Show what a task is doing, post light updates and ask for email at sign-in. [#352](https://github.com/n8n-io/otto/pull/352) (e5e0e5d)

### Fixes

- Preserve app permission errors and browser handoff input. [#362](https://github.com/n8n-io/otto/pull/362) (963e3e1)
- **desktop:** Clean up old runtimes, stage updates in the background and recover from failed checks. [#357](https://github.com/n8n-io/otto/pull/357) (30d4769)
- **chat:** Show time, reaction and controls under each message. [#342](https://github.com/n8n-io/otto/pull/342) (4b50df2)
- **vault:** Show the full username when choosing a saved login. [#340](https://github.com/n8n-io/otto/pull/340) (9a75c30)
- **apps:** Explain how to create a Composio key with the right permissions. [#344](https://github.com/n8n-io/otto/pull/344) (3f3cc42)
- **vault:** Keep Sign in buttons clickable and post action links with their waiting turn. [#339](https://github.com/n8n-io/otto/pull/339) (b8da2e4)
- **sandbox:** Run find without RTK so it sees .otto files. [#338](https://github.com/n8n-io/otto/pull/338) (503294a)

### Documentation

- **contribute:** Keep the default workflow token read-only. [#337](https://github.com/n8n-io/otto/pull/337) (634ef20)

<details>
<summary>Maintenance (10 changes)</summary>

- **deps:** Bump @radix-ui/react-popover from 1.2.0 to 1.3.1. [#353](https://github.com/n8n-io/otto/pull/353) (66c680e)
- **deps-dev:** Bump jsdom from 30.1.2 to 30.1.3. [#356](https://github.com/n8n-io/otto/pull/356) (7d9ef00)
- **deps-dev:** Bump prettier from 3.9.9 to 3.9.10. [#348](https://github.com/n8n-io/otto/pull/348) (bc4a74c)
- **deps:** Bump posthog-node from 5.55.1 to 5.56.1. [#354](https://github.com/n8n-io/otto/pull/354) (1de48b5)
- Drop hosted leftovers in analytics, feedback and object storage. [#358](https://github.com/n8n-io/otto/pull/358) (82abd44)
- **deps:** Bump pg-boss from 12.37.1 to 12.38.0. [#355](https://github.com/n8n-io/otto/pull/355) (f0409e3)
- **deps-dev:** Bump fake-indexeddb from 6.2.5 to 6.2.6. [#349](https://github.com/n8n-io/otto/pull/349) (3cffbde)
- **deps:** Bump undici to 8.12.2 and wrap its dispatchers for Node's fetch. [#334](https://github.com/n8n-io/otto/pull/334) (977431a)
- **security:** Clear known vulnerabilities, pin base images and fuzz redaction. [#335](https://github.com/n8n-io/otto/pull/335) (c7996aa)
- Delete Git notes refs on every CI run. [#333](https://github.com/n8n-io/otto/pull/333) (0bd5626)

</details>

[Full changelog](https://github.com/n8n-io/otto/compare/desktop-v0.1.16...3c8635be1f257f490a091db122299d0e9e15117d)

<details>
<summary>Build details</summary>

Source: `3c8635be1f257f490a091db122299d0e9e15117d`
Previous release: `desktop-v0.1.16`

</details>

## 0.1.16 - 2026-10-19

### Features

- **trust:** Treat what an email says as its sender's claim, plus WhisperBench. [#310](https://github.com/n8n-io/otto/pull/310) (1c494cc)
- **memory:** Recall what you said, with ranked search and dated notes, plus LongMemEval. [#308](https://github.com/n8n-io/otto/pull/308) (f727692)
- **models:** Set an OpenAI-compatible server in .env, and make adding local models more robust. [#311](https://github.com/n8n-io/otto/pull/311) (5ba593e)
- **models:** Connect Ollama, LM Studio, vLLM and other OpenAI-compatible servers. [#309](https://github.com/n8n-io/otto/pull/309) (d3dbb2a)
- **trust:** Judge website steps by the form they send, and keep a task's request. [#304](https://github.com/n8n-io/otto/pull/304) (9f727af)
- Learned skills, scheduled brief and watch fixes, and a task list that starts fresh after a reset. [#305](https://github.com/n8n-io/otto/pull/305) (0671c5c)
- Otto writes its task and tip messages instead of fixed text. [#302](https://github.com/n8n-io/otto/pull/302) (e2a9250)
- **trust:** Show and edit the standing instruction on the Trust page. [#299](https://github.com/n8n-io/otto/pull/299) (cfab43d)
- **evals:** Add a 153-case release suite and fakes for Drive, Docs, Notion and Linear. [#286](https://github.com/n8n-io/otto/pull/286) (d742104)
- **trust:** Let background work act on the owner's standing instruction. [#298](https://github.com/n8n-io/otto/pull/298) (dca741f)
- Connect apps with Google sign-in or a Composio key. [#204](https://github.com/n8n-io/otto/pull/204) (6585f15)
- **trust:** Check browser steps that can commit with the same checker. [#293](https://github.com/n8n-io/otto/pull/293) (71b721e)
- Use decision models for trust checks. [commit](https://github.com/n8n-io/otto/commit/bd284fb228f78d0ecbd25686200bedd71643e053) (bd284fb)

### Fixes

- **web:** Block private IP addresses and saved proxies in the web extension. [#331](https://github.com/n8n-io/otto/pull/331) (b50c966)
- Harden hosted tenant isolation and lifecycle. [#307](https://github.com/n8n-io/otto/pull/307) (b9a778f)
- Harden browser, hosted runtime and connection boundaries. [#306](https://github.com/n8n-io/otto/pull/306) (4e9c208)
- A question keeps the last word, drop two unsupported prompt rules, and harness fixes. [#301](https://github.com/n8n-io/otto/pull/301) (34ff171)
- Continued tasks browse again, and other release eval misses. [#300](https://github.com/n8n-io/otto/pull/300) (834e861)
- **trust:** Decide actions with the selected model, and other release eval findings. [#296](https://github.com/n8n-io/otto/pull/296) (05f95ae)
- **trust:** Check memory forget and clear, and never click from a download. [#295](https://github.com/n8n-io/otto/pull/295) (11880c7)
- **desktop:** Smooth onboarding and unify Telegram setup. [#297](https://github.com/n8n-io/otto/pull/297) (2aecaf2)
- Watch apps only when asked, hand the browser back without a message, hide passkeys. [#294](https://github.com/n8n-io/otto/pull/294) (0e9e640)
- **trust:** Give the gate the facts it was missing. [#285](https://github.com/n8n-io/otto/pull/285) (a7dae35)
- **chat:** Drop the author line from reply quotes. [#283](https://github.com/n8n-io/otto/pull/283) (9987b24)
- **release:** Wait up to 30 minutes for Apple's staple ticket. [#282](https://github.com/n8n-io/otto/pull/282) (094ac05)

### Documentation

- **trust:** Add a narrated video tour of the trust check. [#303](https://github.com/n8n-io/otto/pull/303) (660b62f)
- List n8n update checks and web search, and fix memory and checker facts. [#292](https://github.com/n8n-io/otto/pull/292) (86ef97e)
- Say a separate check decides and what lessons are. [#291](https://github.com/n8n-io/otto/pull/291) (816b561)

<details>
<summary>Maintenance (22 changes)</summary>

- **deps:** Bump e2b from 2.52.1 to 2.56.0. [#329](https://github.com/n8n-io/otto/pull/329) (9bca9b4)
- **deps:** Bump dotenv from 18.0.7 to 18.0.8. [#330](https://github.com/n8n-io/otto/pull/330) (078f12e)
- **deps:** Bump @radix-ui/react-slot from 1.4.0 to 1.5.0. [#328](https://github.com/n8n-io/otto/pull/328) (3e21553)
- **deps-dev:** Bump fake-indexeddb from 6.2.4 to 6.2.5. [#325](https://github.com/n8n-io/otto/pull/325) (e773b03)
- **deps:** Bump pi-web-access from 0.37.0 to 0.41.0. [#327](https://github.com/n8n-io/otto/pull/327) (790ba12)
- **deps:** Bump the chat-sdk group across 1 directory with 4 updates. [#315](https://github.com/n8n-io/otto/pull/315) (a0ce31a)
- **deps:** Bump agent-browser from 0.38.2 to 0.39.1. [#318](https://github.com/n8n-io/otto/pull/318) (5e5d880)
- **deps-dev:** Bump yaml from 2.9.0 to 2.9.1. [#326](https://github.com/n8n-io/otto/pull/326) (3885898)
- **deps:** Bump the react group across 1 directory with 2 updates. [#316](https://github.com/n8n-io/otto/pull/316) (1184d8f)
- **deps:** Bump zod from 4.6.5 to 4.6.7. [#319](https://github.com/n8n-io/otto/pull/319) (8b2a54e)
- **deps:** Bump @radix-ui/react-dialog from 1.2.0 to 1.3.1. [#322](https://github.com/n8n-io/otto/pull/322) (e3e8e9d)
- **deps:** Align @types/node with the Node 24 runtime and hold mermaid at 11. [#320](https://github.com/n8n-io/otto/pull/320) (723077c)
- **deps:** Bump astro to 7.4.0 and @astrojs/markdown-satteri to 0.4.4. [#317](https://github.com/n8n-io/otto/pull/317) (776ff72)
- **deps:** Bump the tiptap group across 1 directory with 10 updates. [#314](https://github.com/n8n-io/otto/pull/314) (b32bb67)
- **deps:** Bump rust in /. [#313](https://github.com/n8n-io/otto/pull/313) (f36071a)
- **deps:** Bump @fastify/multipart from 10.1.3 to 10.1.4. [#323](https://github.com/n8n-io/otto/pull/323) (5cfffcf)
- **deps-dev:** Bump lefthook from 2.2.1 to 2.2.2. [#321](https://github.com/n8n-io/otto/pull/321) (91aa39c)
- **deps:** Bump the pi group across 1 directory with 2 updates. [#312](https://github.com/n8n-io/otto/pull/312) (c9a20f0)
- **release:** List only the installers in the release notes. [#290](https://github.com/n8n-io/otto/pull/290) (9106ca9)
- Remove internal Linear link from the RTK eval manifest. [#289](https://github.com/n8n-io/otto/pull/289) (05a63fa)
- Package desktop apps only for releases. [commit](https://github.com/n8n-io/otto/commit/90aa7b9590618493a5fa57e6b8f842057b4a2371) (90aa7b9)
- Remove low-value tests and legacy compatibility code. [#284](https://github.com/n8n-io/otto/pull/284) (01912b8)

</details>

[Full changelog](https://github.com/n8n-io/otto/compare/desktop-v0.1.15...b50c966f53cd74a7ed7483ecf8409ab075d280f3)

<details>
<summary>Build details</summary>

Source: `b50c966f53cd74a7ed7483ecf8409ab075d280f3`
Previous release: `desktop-v0.1.15`

</details>

## 0.1.15 - 2026-10-15

Mac builds are now signed with n8n's Developer ID and notarized by Apple, so macOS opens them without **Open Anyway**. Otto 0.1.12 and earlier can't update to this version on its own: download it and replace Otto in Applications once, or run the Terminal installer. Your data is kept.

### Features

- **trust:** One Trust page for spending and saved logins, with task check-ins. [#278](https://github.com/n8n-io/otto/pull/278) (b45d012)
- **desktop:** Download the Windows runtime on first launch. [#276](https://github.com/n8n-io/otto/pull/276) (db98c78)
- **chat:** LAB-508 standing offers, follow-up messages and reactions in chat apps. [commit](https://github.com/n8n-io/otto/commit/d679dedccb3860115b43d7bb4bd038a16b22acb7) (d679ded)
- **desktop:** Sign and notarize Mac builds with n8n's Developer ID. [#274](https://github.com/n8n-io/otto/pull/274) (ecfb68e)
- **tasks:** Add task sessions and chat status. [#272](https://github.com/n8n-io/otto/pull/272) (a8604f1)
- **analytics:** Measure opt-in tasks, services and friction. [commit](https://github.com/n8n-io/otto/commit/01d40ab7fa272d3c4b505e10b2456cbf138cb372) (01d40ab)
- **runtime:** Unify execution records and browser handoffs. [#270](https://github.com/n8n-io/otto/pull/270) (48434b1)
- **runtime:** Run every session in parallel with its own browser, plus a thin delegate tool. [#253](https://github.com/n8n-io/otto/pull/253) (022b996)
- **desktop:** Install and auto-update Otto on both Macs and Windows. [#240](https://github.com/n8n-io/otto/pull/240) (8e0d6be)
- **docs:** Add the Otto waitlist page. [commit](https://github.com/n8n-io/otto/commit/ea830d01d89c8f2cb022bb8c8e4b1e77a4a18143) (ea830d0)
- **trust:** One checker model decides every app action. [#237](https://github.com/n8n-io/otto/pull/237) (2761741)

### Fixes

- **release:** Wait up to ten minutes for Apple's staple ticket. [#280](https://github.com/n8n-io/otto/pull/280) (be32b49)
- **release:** Give notarized Mac builds time to finish. [#277](https://github.com/n8n-io/otto/pull/277) (fcacc67)
- Use model judgment for confirmations. [#273](https://github.com/n8n-io/otto/pull/273) (7124657)
- **web:** Stop the web extension from using the server's GitHub login. [#269](https://github.com/n8n-io/otto/pull/269) (6608682)
- **sandbox:** Run each connected CLI as its own Linux user. [#267](https://github.com/n8n-io/otto/pull/267) (4627506)
- Show every memory in full, use the full chat width and tighten digests. [#266](https://github.com/n8n-io/otto/pull/266) (635f1d5)
- Unstick waiting turns, onboarding Back, the feedback form and file sharing. [#264](https://github.com/n8n-io/otto/pull/264) (3cfcd37)
- **fonts:** Replace the Baumer fonts with Geist and Geist Mono. [#263](https://github.com/n8n-io/otto/pull/263) (df6d672)
- **apps:** Recover Composio onboarding connection failures. [#260](https://github.com/n8n-io/otto/pull/260) (42bf314)
- **evals:** Stop three checks from failing correct runs. [#259](https://github.com/n8n-io/otto/pull/259) (41e9f29)
- **browser:** Keep four live browsers so a scheduled run fits beside two subagents. [#258](https://github.com/n8n-io/otto/pull/258) (1fc822b)
- **release:** Return a release to draft when the update service cannot deliver it. [#239](https://github.com/n8n-io/otto/pull/239) (f6579f3)
- **browser:** Count a back or forward step when the document changed. [#236](https://github.com/n8n-io/otto/pull/236) (5af4833)

<details>
<summary>Maintenance (16 changes)</summary>

- **harness:** Remove caps that limit Otto and fix the ones that matter. [#271](https://github.com/n8n-io/otto/pull/271) (99810fd)
- **deps:** Bump posthog-js from 1.435.9 to 1.438.5. [#248](https://github.com/n8n-io/otto/pull/248) (9104e56)
- **deps:** Bump pdfjs-dist from 6.3.289 to 6.4.299. [#247](https://github.com/n8n-io/otto/pull/247) (a9a0a2e)
- **deps-dev:** Bump jsdom and @types/jsdom. [#241](https://github.com/n8n-io/otto/pull/241) (df3c191)
- Prune the machinery built around Pi and fix two session bugs. [#257](https://github.com/n8n-io/otto/pull/257) (e5bb508)
- Let Pi decide instead of side models and dead paths. [#255](https://github.com/n8n-io/otto/pull/255) (e723082)
- **trust:** Keep the structural guarantees and drop the heuristics. [#252](https://github.com/n8n-io/otto/pull/252) (f1364f8)
- **deps:** Bump tldts from 7.4.15 to 7.4.18. [#244](https://github.com/n8n-io/otto/pull/244) (4439295)
- **deps:** Bump pg-boss from 12.37.0 to 12.37.1. [#246](https://github.com/n8n-io/otto/pull/246) (1303bf8)
- **deps:** Bump posthog-node from 5.55.0 to 5.55.1. [#242](https://github.com/n8n-io/otto/pull/242) (7160a4f)
- **deps:** Bump emoji-picker-react from 4.22.2 to 4.22.3. [#250](https://github.com/n8n-io/otto/pull/250) (2fa69ff)
- **deps:** Bump @radix-ui/react-popover from 1.1.23 to 1.2.0. [#249](https://github.com/n8n-io/otto/pull/249) (18b813e)
- **deps:** Bump dotenv from 18.0.5 to 18.0.7. [#251](https://github.com/n8n-io/otto/pull/251) (fbc2192)
- **deps:** Bump @fastify/middie from 9.3.4 to 9.3.5. [#245](https://github.com/n8n-io/otto/pull/245) (8f954ad)
- **deps:** Bump @radix-ui/react-slot from 1.3.3 to 1.4.0. [#243](https://github.com/n8n-io/otto/pull/243) (0fb7317)
- **release:** Build desktop releases only from release PR merges. [#235](https://github.com/n8n-io/otto/pull/235) (f365885)

</details>

[Full changelog](https://github.com/n8n-io/otto/compare/desktop-v0.1.12...be32b497e1d5c86975e4096c8d6d082b5d71dc9f)

<details>
<summary>Build details</summary>

Source: `be32b497e1d5c86975e4096c8d6d082b5d71dc9f`
Previous release: `desktop-v0.1.12`

</details>

## 0.1.12 - 2026-10-11

### Features

- **vault:** Keep secret entry private and preserve browser tasks. [commit](https://github.com/n8n-io/otto/commit/0e46930fd07a6e32b74d2535960b26c823f5abba) (0e46930)

### Fixes

- **release:** Select fixture targets and correct setup steps. [#217](https://github.com/n8n-io/otto/pull/217) (0380c67)

### Documentation

- Add the Otto docs site and move the docs into it. [#219](https://github.com/n8n-io/otto/pull/219) (9be032b)

<details>
<summary>Maintenance (15 changes)</summary>

- **deps:** Bump rust in /. [#225](https://github.com/n8n-io/otto/pull/225) (00ef8d4)
- **deps:** Bump actions/github-script from 8.0.0 to 9.0.0. [#223](https://github.com/n8n-io/otto/pull/223) (0fc01e3)
- **deps:** Bump actions/setup-go from 6.5.0 to 7.0.0. [#222](https://github.com/n8n-io/otto/pull/222) (ba9c538)
- **deps:** Bump pnpm/action-setup from 4.3.0 to 6.1.0. [#224](https://github.com/n8n-io/otto/pull/224) (494b19e)
- **deps:** Bump the actions group with 3 updates. [#221](https://github.com/n8n-io/otto/pull/221) (01b0bad)
- **deps-dev:** Bump vite from 7.3.6 to 8.3.4. [#231](https://github.com/n8n-io/otto/pull/231) (f8d18a6)
- **deps-dev:** Bump @napi-rs/canvas from 1.0.9 to 1.0.10. [#230](https://github.com/n8n-io/otto/pull/230) (aea6715)
- **deps:** Bump @radix-ui/react-dialog from 1.1.23 to 1.2.0. [#228](https://github.com/n8n-io/otto/pull/228) (7b6c126)
- **deps:** Bump parse5 from 7.3.0 to 8.0.1. [#227](https://github.com/n8n-io/otto/pull/227) (3a57195)
- **deps:** Bump agent-browser from 0.38.1 to 0.38.2. [#233](https://github.com/n8n-io/otto/pull/233) (be5c553)
- **deps:** Bump @fastify/multipart from 9.4.0 to 10.1.3. [#226](https://github.com/n8n-io/otto/pull/226) (8ab91e9)
- **deps:** Bump better-auth from 1.7.6 to 1.7.7. [#232](https://github.com/n8n-io/otto/pull/232) (95ad6d1)
- **deps:** Bump pg-boss from 12.34.0 to 12.37.0. [#229](https://github.com/n8n-io/otto/pull/229) (9ec5740)
- **deps:** Bump the pi group across 1 directory with 2 updates. [#220](https://github.com/n8n-io/otto/pull/220) (07bf5a8)
- Cache Docker layers, add Git hooks and scope secret scanning in tests. [#213](https://github.com/n8n-io/otto/pull/213) (b397eef)

</details>

[Full changelog](https://github.com/n8n-io/otto/compare/desktop-v0.1.11...00ef8d4a6dc3fb2a4a61a26c8579e42d5a954fd2)

<details>
<summary>Build details</summary>

Source: `00ef8d4a6dc3fb2a4a61a26c8579e42d5a954fd2`
Previous release: `desktop-v0.1.11`

</details>

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
