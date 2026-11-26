# Desktop changelog

Releases from before the rename to Nod are the `desktop-v*` [GitHub releases](https://github.com/n8n-io/nod/releases).

## 0.9.9 - 2026-11-26

### Features

- **desktop:** Package Nod for Fedora as an RPM and download the Linux runtime on first launch. [#1515](https://github.com/n8n-io/nod/pull/1515) (544217b)
- **analytics:** Record engine stop and desktop launch context. [#1500](https://github.com/n8n-io/nod/pull/1500) (818fc9a)
- **traces:** Reset chat, readable messages and full screen in dev mode. [commit](https://github.com/n8n-io/nod/commit/13dc3819257763eadd1b1eb64d2d8d95350c2e57) (13dc381)
- **traces:** Show every model call, prompt and tool of a turn in dev mode. [commit](https://github.com/n8n-io/nod/commit/0ea0c72547c3751541a8f7c91189d2bd7bcb5a08) (0ea0c72)
- **analytics:** Record the setup failure code and step. [#1488](https://github.com/n8n-io/nod/pull/1488) (502baeb)

### Fixes

- **release:** Retry GitHub server errors without creating a second draft. [#1525](https://github.com/n8n-io/nod/pull/1525) (2d767e4)
- **channels:** Explain where the Telegram bot replies. [#1522](https://github.com/n8n-io/nod/pull/1522) (5b6d3df)
- **installer:** Check for Windows x64 before downloading Nod. [#1521](https://github.com/n8n-io/nod/pull/1521) (6aa519e)
- **traces:** Accept sessions without the turn trace flag and bound the trace resize. [commit](https://github.com/n8n-io/nod/commit/1cbddcb06bb8e9a3fc7d8989c2d06f34ba55f76e) (1cbddcb)
- **traces:** Address review on dev turn traces. [commit](https://github.com/n8n-io/nod/commit/b77992f81c25a64905ede251fbc6a8c9e3df79fa) (b77992f)
- **channels:** Prove the owner from their own chat and send Nod's messages where they last wrote. [#1493](https://github.com/n8n-io/nod/pull/1493) (b444e27)
- **traces:** Keep turn traces off the model path, on their own turn and dev-only. [commit](https://github.com/n8n-io/nod/commit/21fecfaf6faedd514c6edc4fa148bf2d7ca8ea9e) (21fecfa)
- **apps:** Tidy connect page. [#1491](https://github.com/n8n-io/nod/pull/1491) (b51f38d)
- **memory:** Save what the owner asks to remember, in any language. [#1490](https://github.com/n8n-io/nod/pull/1490) (1423455)

<details>
<summary>Maintenance (1 changes)</summary>

- **traces:** Check turn traces and forget-reset exist only in dev mode. [commit](https://github.com/n8n-io/nod/commit/a92c09ab676c503425b48b8e8367197f533ce61f) (a92c09a)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.9.7...2d767e4f61389d6e3b05fc66755aca9354ad9c3e)

<details>
<summary>Build details</summary>

Source: `2d767e4f61389d6e3b05fc66755aca9354ad9c3e`
Previous release: `nod-v0.9.7`

</details>

## 0.9.8 - 2026-11-25

### Features

- **analytics:** Record the setup failure code and step. [#1488](https://github.com/n8n-io/nod/pull/1488) (502baeb)

### Fixes

- **channels:** Prove the owner from their own chat and send Nod's messages where they last wrote. [#1493](https://github.com/n8n-io/nod/pull/1493) (b444e27)
- **apps:** Tidy connect page. [#1491](https://github.com/n8n-io/nod/pull/1491) (b51f38d)
- **memory:** Save what the owner asks to remember, in any language. [#1490](https://github.com/n8n-io/nod/pull/1490) (1423455)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.9.7...b444e276b36c8d213d4fdd3db47f90ec4f73b285)

<details>
<summary>Build details</summary>

Source: `b444e276b36c8d213d4fdd3db47f90ec4f73b285`
Previous release: `nod-v0.9.7`

</details>

## 0.9.7 - 2026-11-25

### Features

- **apps:** Add Qontext as a custom app. [#1473](https://github.com/n8n-io/nod/pull/1473) (08da5a7)

### Fixes

- Remove gates that hide tools and reject valid trust verdicts. [#1485](https://github.com/n8n-io/nod/pull/1485) (33136d5)
- **desktop:** Repair Windows startup instead of refusing, keep the first failure's code, download through the system proxy. [#1483](https://github.com/n8n-io/nod/pull/1483) (2c133bb)
- **feedback:** Create feedback issues as the Nod Feedback Linear app. [#1484](https://github.com/n8n-io/nod/pull/1484) (9e3e2d7)
- **chat:** Give the main chat the browser and computer use again. [#1482](https://github.com/n8n-io/nod/pull/1482) (31e8f63)
- **vault:** End a chat code request with the turn that asked for it. [#1469](https://github.com/n8n-io/nod/pull/1469) (40956c9)

<details>
<summary>Maintenance (2 changes)</summary>

- Identify n8n team PRs by write access to the repository. [#1470](https://github.com/n8n-io/nod/pull/1470) (cb4b58b)
- Label pull requests opened by the n8n team. [#1468](https://github.com/n8n-io/nod/pull/1468) (c96ae96)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.9.6...33136d52485c30ff6900c37f2f2b9c04df02c1c6)

<details>
<summary>Build details</summary>

Source: `33136d52485c30ff6900c37f2f2b9c04df02c1c6`
Previous release: `nod-v0.9.6`

</details>

## 0.9.6 - 2026-11-24

### Fixes

- **errors:** Name disk-full and local connection failures and keep startup error codes. [#1465](https://github.com/n8n-io/nod/pull/1465) (6670bc2)
- **trust:** Let one request cover every step and keep approvals answerable. [#1464](https://github.com/n8n-io/nod/pull/1464) (853d473)
- **models:** Preserve Mistral invalid-key discovery errors. [#1463](https://github.com/n8n-io/nod/pull/1463) (92987ee)
- **models:** Identify Nod to every model, speech and decision service. [#1462](https://github.com/n8n-io/nod/pull/1462) (ef9d789)
- **models:** Identify Nod's provider requests as nod instead of pi. [#1460](https://github.com/n8n-io/nod/pull/1460) (058889a)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.9.5...6670bc233b6b7dddaa75b25b89b4a89f0e92bcac)

<details>
<summary>Build details</summary>

Source: `6670bc233b6b7dddaa75b25b89b4a89f0e92bcac`
Previous release: `nod-v0.9.5`

</details>

## 0.9.5 - 2026-11-23

### Features

- **models:** Continue on the owner's backup models when a model request fails. [#1361](https://github.com/n8n-io/nod/pull/1361) (2118c35)

### Fixes

- **desktop:** Restore Windows install choices and recovery. [commit](https://github.com/n8n-io/nod/commit/0c3e0ff651d71cc6c4a6676b62ce2aa6ee938394) (0c3e0ff)
- **browser:** Let the sign-in method picker accept buttons under click-through layers. [#1453](https://github.com/n8n-io/nod/pull/1453) (dcf495e)
- **vault:** Refuse sign-in steps for controls that are not on the page, and click any sign-in button. [#1452](https://github.com/n8n-io/nod/pull/1452) (ee386a4)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.9.4...0c3e0ff651d71cc6c4a6676b62ce2aa6ee938394)

<details>
<summary>Build details</summary>

Source: `0c3e0ff651d71cc6c4a6676b62ce2aa6ee938394`
Previous release: `nod-v0.9.4`

</details>

## 0.9.4 - 2026-11-23

### Features

- **analytics:** Send a daily runtime\_active event while Nod runs. [#1448](https://github.com/n8n-io/nod/pull/1448) (9ed5562)
- **schedules:** Personal schedule ideas from your own messages. [#1444](https://github.com/n8n-io/nod/pull/1444) (fbd8bc3)

### Fixes

- **chat:** Keep the recovery notice when Try again or Use model fails. [#1213](https://github.com/n8n-io/nod/pull/1213) (f358bc7)
- **schedules:** Scheduled page review fixes from #1441. [#1447](https://github.com/n8n-io/nod/pull/1447) (571158b)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.9.3...f358bc7353e286c901bb82a9b91968149f301f56)

<details>
<summary>Build details</summary>

Source: `f358bc7353e286c901bb82a9b91968149f301f56`
Previous release: `nod-v0.9.3`

</details>

## 0.9.3 - 2026-11-23

### Features

- **schedules:** Choose each schedule's model on the Scheduled page, with compact rows and ideas. [#1441](https://github.com/n8n-io/nod/pull/1441) (3b20226)
- **approvals:** Bold the few values to check in approval questions. [#1432](https://github.com/n8n-io/nod/pull/1432) (a9c1c0f)
- **models:** Add Hostinger AI Router as a model provider. [commit](https://github.com/n8n-io/nod/commit/501d7a72158f2f3ce16e46c8ecb7c9c5ea503951) (501d7a7)
- **tasks:** Show running tasks on Nod's status line instead of task previews in chat. [#1430](https://github.com/n8n-io/nod/pull/1430) (c7b0951)
- **results:** Compact result cards with See details and a Check on site button. [#1431](https://github.com/n8n-io/nod/pull/1431) (638cf16)
- **apps:** List connected MCP tool names in the agent context. [#1367](https://github.com/n8n-io/nod/pull/1367) (73fde1f)

### Fixes

- **ci:** Install Nod in its usual folder in the Windows startup check. [#1445](https://github.com/n8n-io/nod/pull/1445) (552d017)
- **models:** Don't treat a busy model check as a connection problem. [#1374](https://github.com/n8n-io/nod/pull/1374) (aee91e8)
- **desktop:** Start reliably on Windows after an install, an update or a WSL failure. [#1440](https://github.com/n8n-io/nod/pull/1440) (812c047)
- **chat:** Open Nod's status line to read a long step in full. [#1442](https://github.com/n8n-io/nod/pull/1442) (a6ca9ab)
- **tasks:** Tasks line review fixes from #1430. [#1439](https://github.com/n8n-io/nod/pull/1439) (608e403)
- **results:** Result card review fixes from #1431. [#1433](https://github.com/n8n-io/nod/pull/1433) (fb00f1c)
- **desktop:** Read hidden, slow and large windows in computer use. [#1257](https://github.com/n8n-io/nod/pull/1257) (1631927)
- **schedules:** Keep skipped runs on rename and drop the watch on a change to one-time. [#1427](https://github.com/n8n-io/nod/pull/1427) (89e7e66)
- **schedules:** Show the finished reply and shared files in run history. [#1426](https://github.com/n8n-io/nod/pull/1426) (d3b43ba)
- **schedules:** Open Scheduled after an unconfirmed task save. [#1428](https://github.com/n8n-io/nod/pull/1428) (69105e9)
- **schedules:** Save observations after a run resumes. [#1425](https://github.com/n8n-io/nod/pull/1425) (e58d535)
- **browser:** Upgrade agent-browser to 0.43.0 so popup downloads stop hanging. [#1413](https://github.com/n8n-io/nod/pull/1413) (a7a6826)
- **tasks:** Name the interrupted task and send one notice after a hand-off. [#1411](https://github.com/n8n-io/nod/pull/1411) (6f02f2f)
- **privacy:** Redact secret fields across text and structured data. [#1296](https://github.com/n8n-io/nod/pull/1296) (fd7536a)
- **server:** Refuse text with a null character with a clear error. [#1339](https://github.com/n8n-io/nod/pull/1339) (940c88a)
- **models:** Say why model discovery failed. [#1336](https://github.com/n8n-io/nod/pull/1336) (3e467aa)
- **models:** Keep Bedrock, Vertex and Azure discovery reasons. [#1335](https://github.com/n8n-io/nod/pull/1335) (6d55136)
- **usage:** Count today's spend after a DST change. [#1316](https://github.com/n8n-io/nod/pull/1316) (b2f9d80)
- **account:** Keep the reason setup could not finish. [#1340](https://github.com/n8n-io/nod/pull/1340) (f4cc1e7)
- **web:** Keep the status and reason of API errors without a JSON error. [#1343](https://github.com/n8n-io/nod/pull/1343) (855d8a7)
- **desktop:** Trim the server token before checking it. [#1346](https://github.com/n8n-io/nod/pull/1346) (f508b12)
- **channels:** Decode an escaped backslash in shared contacts. [#1310](https://github.com/n8n-io/nod/pull/1310) (35bb6a9)
- **speech:** Keep voice preview audio attached to the document. [#1365](https://github.com/n8n-io/nod/pull/1365) (2e1c422)

### Performance

- **self-host:** Stop compressing the bundle archive a second time. [#1429](https://github.com/n8n-io/nod/pull/1429) (ee2768c)
- **ci:** Build self-host bundle images with the runner's local layer cache. [#1412](https://github.com/n8n-io/nod/pull/1412) (55718ee)
- **ci:** Stop tests sleeping through real-time windows and run more files at once. [#1379](https://github.com/n8n-io/nod/pull/1379) (94894af)
- **apps:** Load MCP tools with their guide in one step and fetch tool lists at startup. [#1370](https://github.com/n8n-io/nod/pull/1370) (24bd1b0)

### Documentation

- **readme:** Link section titles to their sections. [#1272](https://github.com/n8n-io/nod/pull/1272) (33c0b8e)
- **apps:** List every CLI environment name ending Nod accepts. [#1280](https://github.com/n8n-io/nod/pull/1280) (4ce8f23)

<details>
<summary>Maintenance (25 changes)</summary>

- **deps-dev:** Bump vitest from 5.1.0 to 5.1.1. [#1418](https://github.com/n8n-io/nod/pull/1418) (b180364)
- **deps:** Bump @fastify/rate-limit from 11.2.0 to 11.2.2. [#1423](https://github.com/n8n-io/nod/pull/1423) (e63bdf3)
- **deps:** Bump libphonenumber-js from 1.13.15 to 1.13.17. [#1422](https://github.com/n8n-io/nod/pull/1422) (6095ae9)
- **deps-dev:** Bump emoji-picker-react from 4.22.3 to 5.1.4. [#1415](https://github.com/n8n-io/nod/pull/1415) (2fd75e9)
- **deps:** Bump tldts from 7.4.24 to 7.5.5. [#1421](https://github.com/n8n-io/nod/pull/1421) (6eef391)
- **deps:** Bump @fastify/multipart from 10.1.7 to 10.1.9. [#1420](https://github.com/n8n-io/nod/pull/1420) (50f4550)
- **deps-dev:** Bump @vitejs/plugin-react from 6.1.2 to 6.3.0. [#1419](https://github.com/n8n-io/nod/pull/1419) (d4f61c1)
- **deps-dev:** Bump @napi-rs/canvas from 1.1.0 to 1.1.1. [#1417](https://github.com/n8n-io/nod/pull/1417) (479557e)
- **deps:** Bump jose from 6.2.17 to 6.2.18. [#1416](https://github.com/n8n-io/nod/pull/1416) (aa5a2d3)
- **deps:** Bump @fastify/static from 10.1.7 to 10.1.12. [#1414](https://github.com/n8n-io/nod/pull/1414) (fa9cc28)
- **deps:** Bump @composio/core to 0.30.0 and @composio/client to 2.1.33. [#1407](https://github.com/n8n-io/nod/pull/1407) (81139f0)
- **deps-dev:** Bump bun from 1.4.4 to 1.4.5. [#1406](https://github.com/n8n-io/nod/pull/1406) (d21e154)
- **deps-dev:** Bump jsdom from 30.1.3 to 31.0.1. [#1403](https://github.com/n8n-io/nod/pull/1403) (8f32101)
- **deps:** Bump pg-boss from 12.38.0 to 12.38.2. [#1402](https://github.com/n8n-io/nod/pull/1402) (99a3bb3)
- **deps-dev:** Bump posthog-js from 1.438.5 to 1.453.0. [#1401](https://github.com/n8n-io/nod/pull/1401) (ae18894)
- **deps:** Bump @pedrobef/vozz from 0.2.7 to 0.3.0. [#1400](https://github.com/n8n-io/nod/pull/1400) (091f49b)
- **deps:** Bump the chat-sdk group across 1 directory with 4 updates. [#1397](https://github.com/n8n-io/nod/pull/1397) (5347861)
- **deps:** Bump the docs group across 1 directory with 4 updates. [#1399](https://github.com/n8n-io/nod/pull/1399) (9856b0a)
- **deps:** Bump the actions group across 1 directory with 2 updates. [#1393](https://github.com/n8n-io/nod/pull/1393) (4224740)
- **deps:** Bump actions/cache/restore from 4.3.0 to 6.1.0. [#1395](https://github.com/n8n-io/nod/pull/1395) (4d7d080)
- **deps:** Bump actions/cache/save from 4.3.0 to 6.1.0. [#1394](https://github.com/n8n-io/nod/pull/1394) (5ef3d61)
- **deps:** Bump tar from 7.5.22 to 7.5.23. [#1405](https://github.com/n8n-io/nod/pull/1405) (b121646)
- **deps-dev:** Bump the tiptap group across 1 directory with 9 updates. [#1396](https://github.com/n8n-io/nod/pull/1396) (0ff9531)
- **url-guards:** Cover the browser proxy refusing a WebSocket upgrade to a private destination. [#1161](https://github.com/n8n-io/nod/pull/1161) (4f3f6ab)
- Bump tldts to 7.4.24 and preserve hostname redaction. [#1274](https://github.com/n8n-io/nod/pull/1274) (5567564)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.9.2...552d017fff511550f4b3a9f9151aa9ccc4d632c5)

<details>
<summary>Build details</summary>

Source: `552d017fff511550f4b3a9f9151aa9ccc4d632c5`
Previous release: `nod-v0.9.2`

</details>

## 0.9.2 - 2026-11-22

### Features

- **flights:** Find flights in seconds with a Google Flights tool. [#1304](https://github.com/n8n-io/nod/pull/1304) (3107b65)
- **clarity:** Always show what Nod is working on, so it feels faster. [#1264](https://github.com/n8n-io/nod/pull/1264) (6531747)

### Fixes

- **chat:** Just do short app work, run schedules when started and show approvals once. [#1362](https://github.com/n8n-io/nod/pull/1362) (5336545)
- **local-files:** Move folders across drives on Windows. [#1349](https://github.com/n8n-io/nod/pull/1349) (e702f98)
- **models:** Wrap a connection's buttons below its details when space runs out. [#1360](https://github.com/n8n-io/nod/pull/1360) (234ca01)
- **runtime:** Drop the leftover "No subagents." from the prompt. [commit](https://github.com/n8n-io/nod/commit/1b42e689a814a4acff13f0aff7d32070214f109a) (1b42e68)
- **tasks:** Keep each task on the request it serves, and fix four basics found under stress. [#1347](https://github.com/n8n-io/nod/pull/1347) (7a45f1c)
- **models:** Keep reasoning\_effort for Ollama boolean thinking. [commit](https://github.com/n8n-io/nod/commit/42adb858fd445378b3aaed64e8dfca857f320054) (42adb85)
- **cards:** Mark noted seats, clean chart labels and state the live check-in cost. [#1300](https://github.com/n8n-io/nod/pull/1300) (4a8e91b)
- **language:** Align the language rule, labels and docs after review. [#1299](https://github.com/n8n-io/nod/pull/1299) (e7f5519)
- **tasks:** Run outside work in its own task and close stale questions. [#1293](https://github.com/n8n-io/nod/pull/1293) (c7ff621)
- **chat:** Don't repeat a task's question or result on its chat line. [#1297](https://github.com/n8n-io/nod/pull/1297) (8673dfc)
- **language:** Keep everything Nod shows in the conversation's language. [#1295](https://github.com/n8n-io/nod/pull/1295) (3de25be)
- **chat:** Deliver results with their card and tidy result cards. [#1289](https://github.com/n8n-io/nod/pull/1289) (1cf59be)
- **runtime:** Act on stated choices instead of asking to confirm them. [#1287](https://github.com/n8n-io/nod/pull/1287) (a913aec)
- **approvals:** Name what a browser step commits to in its question. [#1286](https://github.com/n8n-io/nod/pull/1286) (73e2243)
- **web:** Show the HTTP status and reason when connecting to a server fails. [#1234](https://github.com/n8n-io/nod/pull/1234) (080d3d3)
- **desktop:** Keep the cause when the server connection check fails. [#1046](https://github.com/n8n-io/nod/pull/1046) (31b057e)
- **channels:** Keep the Telegram reply and show the reason when a file is refused. [#1045](https://github.com/n8n-io/nod/pull/1045) (d736bd9)
- **apps:** Record expired app sign-ins and name their step correctly. [#1128](https://github.com/n8n-io/nod/pull/1128) (c54f021)
- **memory:** Save standing rules in settings instead of memory notes. [#1275](https://github.com/n8n-io/nod/pull/1275) (1813519)
- **apps:** End only the stopped MCP call on a shared connection. [#1110](https://github.com/n8n-io/nod/pull/1110) (9e637e8)
- **chat:** Don't offer a bug report when a model reply is cut off. [#1071](https://github.com/n8n-io/nod/pull/1071) (59e0112)
- **feedback:** Let a bug report be sent again after a rejected attempt. [#1059](https://github.com/n8n-io/nod/pull/1059) (1fe476f)
- **channels:** Do not post an empty text body on WhatsApp Cloud before a reply with no text. [#1043](https://github.com/n8n-io/nod/pull/1043) (5420a4e)
- **chat:** Insert a new line on Return on touch keyboards. [#1248](https://github.com/n8n-io/nod/pull/1248) (c96630c)
- **apps:** Allow encoded slashes and percents in API paths without allowing traversal. [#1090](https://github.com/n8n-io/nod/pull/1090) (cb7929c)
- **apps:** Cap joined OAuth scopes at 500 characters in the app format. [#1088](https://github.com/n8n-io/nod/pull/1088) (05d160b)
- **server:** Run afterRollback callbacks when a transaction aborts before commit. [#1260](https://github.com/n8n-io/nod/pull/1260) (7a8d0d5)
- **workspace:** Name the time or output limit a command hit. [#1086](https://github.com/n8n-io/nod/pull/1086) (780ad49)
- **channels:** Send Telegram voice, contact and location replies with allow\_sending\_without\_reply. [#1042](https://github.com/n8n-io/nod/pull/1042) (a833e5c)
- **apps:** Discard an owned connected account when its sign-in check fails. [#1169](https://github.com/n8n-io/nod/pull/1169) (2ebe201)

### Performance

- **prompt:** Cut Nod's context by a third and stop resending it every turn. [#1353](https://github.com/n8n-io/nod/pull/1353) (d0e4d57)

### Documentation

- **agents:** Keep AGENTS.md to the rules every change follows. [#1279](https://github.com/n8n-io/nod/pull/1279) (3ae7479)
- **n8n:** Distinguish MCP tokens from REST API keys. [#1262](https://github.com/n8n-io/nod/pull/1262) (4522ab2)

<details>
<summary>Maintenance (1 changes)</summary>

- **e2e:** Run the real Nod with a scripted model on every change. [#1348](https://github.com/n8n-io/nod/pull/1348) (929f9d6)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.9.1...d0e4d57b29bb0eeeb720f443b8d48efadb0168ff)

<details>
<summary>Build details</summary>

Source: `d0e4d57b29bb0eeeb720f443b8d48efadb0168ff`
Previous release: `nod-v0.9.1`

</details>

## 0.9.1 - 2026-11-20

### Features

- **web:** Restyle the sidebars and replace collapse-to-icons with hide and resize. [#1206](https://github.com/n8n-io/nod/pull/1206) (517d7f5)
- **apps:** Rename custom MCP connections (LAB-1203). [commit](https://github.com/n8n-io/nod/commit/563ebc20d871f18cc849bb7afd6d097b6eb2bd48) (563ebc2)
- **schedules:** Show live activity for scheduled runs (LAB-1287). [commit](https://github.com/n8n-io/nod/commit/8d4881276c911d2b0f00fc604185117e62fc2f4a) (8d48812)
- **chat:** Link selected text when pasting a URL (LAB-1404). [#1196](https://github.com/n8n-io/nod/pull/1196) (2f744ab)

### Fixes

- **models:** Keep the HTTP status and reason when Google Vertex AI model discovery fails. [#1227](https://github.com/n8n-io/nod/pull/1227) (71a46bf)
- **apps:** Refuse control characters in app display names. [#1075](https://github.com/n8n-io/nod/pull/1075) (a85e234)
- **desktop:** Only update the title bar overlay on windows that have one. [#1158](https://github.com/n8n-io/nod/pull/1158) (edca30b)
- **trust:** Treat a saved sign-in use as never a read. [#1266](https://github.com/n8n-io/nod/pull/1266) (376cc1c)
- **schedules:** Reject time zones the rest of the app cannot format. [#1159](https://github.com/n8n-io/nod/pull/1159) (d9e73c7)
- **apps:** Name a missing MCP server instead of reporting a wrong type. [#1094](https://github.com/n8n-io/nod/pull/1094) (33c3014)
- **memory:** Keep notes that differ only in Devanagari vowel signs. [#1219](https://github.com/n8n-io/nod/pull/1219) (0b26ed0)
- **apps:** Refuse connected CLI arguments with a null byte. [#1082](https://github.com/n8n-io/nod/pull/1082) (62c0cd8)
- **trust:** Never treat opening a file or signing in as a read. [#1265](https://github.com/n8n-io/nod/pull/1265) (8ac789f)
- **docs:** Keep list items and quoted paragraphs apart in docs search. [#1173](https://github.com/n8n-io/nod/pull/1173) (f2fdefb)
- **onboarding:** Ignore the Enter that confirms an IME composition in Something else. [#1211](https://github.com/n8n-io/nod/pull/1211) (0e24a6e)
- **desktop:** Keep comparisons and underscored names in notification previews. [#1216](https://github.com/n8n-io/nod/pull/1216) (ca6278d)
- **desktop:** Pass AWS\_BEDROCK\_FORCE\_HTTP1 to the engine. [#1144](https://github.com/n8n-io/nod/pull/1144) (f11599a)
- **onboarding:** Keep the brief after a link when masking links. [#1212](https://github.com/n8n-io/nod/pull/1212) (9962948)
- **browser:** Ignore mouse side buttons in browser handoff. [#1214](https://github.com/n8n-io/nod/pull/1214) (d9dbaf0)
- **apps:** Send Content-Type on connected API requests only with a body. [#1080](https://github.com/n8n-io/nod/pull/1080) (9967b93)
- **local-files:** Keep a byte order mark when Nod edits a text file. [#1172](https://github.com/n8n-io/nod/pull/1172) (bd44ee8)
- **speech:** Show the ElevenLabs reason when voices fail to load. [#1160](https://github.com/n8n-io/nod/pull/1160) (fcaeb4e)
- **desktop:** Show the engine's status and reason when the Welcome choice is refused. [#1233](https://github.com/n8n-io/nod/pull/1233) (f37c323)
- **schedules:** Keep an emoji whole when a run track title is shortened. [#1097](https://github.com/n8n-io/nod/pull/1097) (7f99b2d)
- **apps:** Keep the connection service reason in the pause after a refused upload, enrollment or connect request. [#1221](https://github.com/n8n-io/nod/pull/1221) (1f4694a)
- **channels:** Keep the HTTP status when a Telegram attachment download is refused. [#1232](https://github.com/n8n-io/nod/pull/1232) (b4eefe6)
- **apps:** Keep the HTTP status when a connected app's file download is refused. [#1228](https://github.com/n8n-io/nod/pull/1228) (d3c449d)
- **apps:** Trim pasted connector tokens again. [#1073](https://github.com/n8n-io/nod/pull/1073) (f3411a9)
- **models:** Keep the service's reason when a model key's model list can't be loaded. [#1220](https://github.com/n8n-io/nod/pull/1220) (5795268)
- **evals:** Re-prove the gate and keep it from going stale. [#1255](https://github.com/n8n-io/nod/pull/1255) (8e5df67)
- **models:** Ask to reconnect when a provider rejects the key on a request. [#1250](https://github.com/n8n-io/nod/pull/1250) (8e8bbdf)
- **models:** Preserve compatible server discovery errors. [#1247](https://github.com/n8n-io/nod/pull/1247) (96c86cc)
- **desktop:** Preserve queued restart requests while installer runs. [commit](https://github.com/n8n-io/nod/commit/ba0700b708c2581e9ef41225a718940a2739791f) (ba0700b)
- **workspace:** Explain how to check a named script. [#1241](https://github.com/n8n-io/nod/pull/1241) (b8bbf38)
- **desktop:** Report startup failures without restarting the engine. [#1236](https://github.com/n8n-io/nod/pull/1236) (d7649a6)
- **privacy:** Mask feedback from original data. [#1244](https://github.com/n8n-io/nod/pull/1244) (09a2fad)
- **memory:** Accept a quote that differs only in curly or straight quote marks. [#1218](https://github.com/n8n-io/nod/pull/1218) (7713955)
- **browser:** Route private frame clicks and keep refusal causes. [#1237](https://github.com/n8n-io/nod/pull/1237) (7473a45)
- **vault:** Keep save and update failure reasons. [#1242](https://github.com/n8n-io/nod/pull/1242) (56ef6ed)
- **trust:** Do not log stopped reviews as failures. [#1243](https://github.com/n8n-io/nod/pull/1243) (8d1f37f)
- **trust:** Keep draft review after message edits. [#1235](https://github.com/n8n-io/nod/pull/1235) (7b6dfcb)
- **tools:** Include all action choices in validation errors. [#1240](https://github.com/n8n-io/nod/pull/1240) (0e2d9a9)
- **privacy:** Explain managed app data before sign-in. [#1230](https://github.com/n8n-io/nod/pull/1230) (d28d132)
- **models:** Use the loaded Ollama context limit. [#1238](https://github.com/n8n-io/nod/pull/1238) (0db6d58)
- **apps:** Close the connection browser attempt when an app sign-in is discarded. [#1168](https://github.com/n8n-io/nod/pull/1168) (fb8c0ce)
- **runtime:** Preserve completed calls after a script failure. [#1229](https://github.com/n8n-io/nod/pull/1229) (208cd49)
- **mail:** Keep bounded safety check failure details. [#1225](https://github.com/n8n-io/nod/pull/1225) (a182cdd)
- **chat:** Keep state reads moving during server updates. [#1226](https://github.com/n8n-io/nod/pull/1226) (2d4af19)
- **desktop:** Submit the Welcome choice once when the engine restarts during setup. [#1223](https://github.com/n8n-io/nod/pull/1223) (aa20ea4)
- **channels:** Show approval buttons in Telegram (LAB-1520). [commit](https://github.com/n8n-io/nod/commit/f3e752a67b77a79d0bd5f0c177589114700ffe14) (f3e752a)
- **chat:** Align the artifact file picker with its filename (LAB-1209). [commit](https://github.com/n8n-io/nod/commit/d0a8475d289b1df47215e06710ac2908feefc069) (d0a8475)
- **chat:** Space file previews below reply text (LAB-1206). [commit](https://github.com/n8n-io/nod/commit/1ad13860d28396361fa4ced4ef61b32012f1d551) (1ad1386)
- **models:** Forecast work at current model rates (LAB-1654). [commit](https://github.com/n8n-io/nod/commit/a9bf9adcf32632e2c1ec8d0b0f64cfb051974fae) (a9bf9ad)
- Correct confirmation and saved-work failures. [commit](https://github.com/n8n-io/nod/commit/fda6784191cba946e636f3e48db4fdbe3a1f986c) (fda6784)
- **traces:** Classify provider errors and preserve conversation IDs (LAB-1658). [#1199](https://github.com/n8n-io/nod/pull/1199) (83354df)
- **evals:** Budget for cancelled memory requests (LAB-1401). [#1195](https://github.com/n8n-io/nod/pull/1195) (e2bcced)
- **browser:** Explain invalid wait conditions (LAB-1500). [#1191](https://github.com/n8n-io/nod/pull/1191) (51a2ffe)
- **browser:** Explain rejected snapshot selectors (LAB-1656). [#1190](https://github.com/n8n-io/nod/pull/1190) (614d1ba)
- **traces:** Add usage joins, error types, and known costs (LAB-1658). [#1188](https://github.com/n8n-io/nod/pull/1188) (26fb141)
- **activity:** Show each completed progress step once (LAB-1639). [#1189](https://github.com/n8n-io/nod/pull/1189) (a13c94a)
- **pi:** Bound OpenRouter completion allowances (LAB-1607). [#1186](https://github.com/n8n-io/nod/pull/1186) (2ccf1ba)
- **browser:** Resolve scrolled sign-in and action targets (LAB-1559). [#1183](https://github.com/n8n-io/nod/pull/1183) (af52e57)
- **speech:** Report local pronunciation limits accurately (LAB-1547). [#1185](https://github.com/n8n-io/nod/pull/1185) (836d3ee)
- **models:** Offer account-listed GPT-6.2 models (LAB-1647). [#1184](https://github.com/n8n-io/nod/pull/1184) (8a70880)
- **desktop:** Keep WSL diagnostics out of runtime command results. [commit](https://github.com/n8n-io/nod/commit/0e1bf88d3b7cfbe34b7c4ef7f3eed741491aefbc) (0e1bf88)
- **apps:** Show where to find the n8n MCP token. [#1126](https://github.com/n8n-io/nod/pull/1126) (c8a220a)
- **desktop:** Gate update actions while Mac installer runs. [commit](https://github.com/n8n-io/nod/commit/b92d6d2e540b57a503552ef5819b96581ba22d3e) (b92d6d2)
- **desktop:** Defer Mac update checks while ShipIt is running. [commit](https://github.com/n8n-io/nod/commit/0d4685100fb8230a8bc8473013e46b7e68be3145) (0d46851)

### Documentation

- **deploy:** Clarify public server bundle availability. [#1254](https://github.com/n8n-io/nod/pull/1254) (54f55a1)
- Use the current names for renamed controls. [#1217](https://github.com/n8n-io/nod/pull/1217) (4ca90ba)
- **get-started:** List Windows for source installs. [#1174](https://github.com/n8n-io/nod/pull/1174) (e8baf47)
- Match release and CI facts to the code. [#1171](https://github.com/n8n-io/nod/pull/1171) (f8ed6f6)
- **use:** Say automatic preparation is off by default and other apps are not polled. [#1157](https://github.com/n8n-io/nod/pull/1157) (71d2ed6)
- **apps:** List OAuth sign-in for HTTP API access paths. [#1092](https://github.com/n8n-io/nod/pull/1092) (80bc626)
- **desktop:** State the conditional first update check delay. [commit](https://github.com/n8n-io/nod/commit/4f36298d8e78c466dbe8f1fb4177031cd0f4a524) (4f36298)
- **desktop:** Show where to switch servers (LAB-1414). [#1192](https://github.com/n8n-io/nod/pull/1192) (5c15757)

### Other changes

- Restyle the sidebars and replace collapse-to-icons with hide and resize. [#1267](https://github.com/n8n-io/nod/pull/1267) (554581e)

<details>
<summary>Maintenance (7 changes)</summary>

- **url-guards:** Refuse a name when any of its DNS answers is private. [#1035](https://github.com/n8n-io/nod/pull/1035) (ea79f1a)
- **trust:** Cut the trust layer to real commitments only. [#1251](https://github.com/n8n-io/nod/pull/1251) (74661c6)
- **desktop:** Cover shared installer waits and restart checks. [commit](https://github.com/n8n-io/nod/commit/e0dd545a6c4c8d468a488f7b3554ede684e39514) (e0dd545)
- **ci:** Record native app sign-in diagnostics. [#1245](https://github.com/n8n-io/nod/pull/1245) (b6686bb)
- **desktop:** Verify update waits through the startup path. [commit](https://github.com/n8n-io/nod/commit/ce2733f72a9c10bb9226d986df7536cae1e72be1) (ce2733f)
- Bump vite 8.3.5 → 8.3.7 (patch) in nod to clear 1 Aikido finding. [#1180](https://github.com/n8n-io/nod/pull/1180) (997adad)
- **desktop:** Cover startup ShipIt update gating. [commit](https://github.com/n8n-io/nod/commit/e393579ec1b500a777cdf0971a56328dd5940cd3) (e393579)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.9.0...71a46bf5499efd6e24a5a8d33dd2d4b8a92f3079)

<details>
<summary>Build details</summary>

Source: `71a46bf5499efd6e24a5a8d33dd2d4b8a92f3079`
Previous release: `nod-v0.9.0`

</details>

## 0.9.0 - 2026-11-19

### Features

- **schedules:** Stop the current run without pausing future runs. [commit](https://github.com/n8n-io/nod/commit/533dab26319ca40ee2f824056722fcc854d41bb1) (533dab2)
- Start a fresh chat with /clear (LAB-1360). [#1135](https://github.com/n8n-io/nod/pull/1135) (557a468)
- **desktop:** Resume Windows downloads and install updates on quit. [#1113](https://github.com/n8n-io/nod/pull/1113) (74b36bd)

### Fixes

- Bind browser confirmations to current selections. [#1166](https://github.com/n8n-io/nod/pull/1166) (09dfedc)
- **schedules:** Show complete checked instructions. [#1176](https://github.com/n8n-io/nod/pull/1176) (493c569)
- **calendar:** Identify events before approval. [#1175](https://github.com/n8n-io/nod/pull/1175) (23b3716)
- **desktop:** Keep password subtrees out of computer use focus and close review gaps. [commit](https://github.com/n8n-io/nod/commit/de4aa883afbaabf56232fc8692183581031c3e70) (de4aa88)
- **privacy:** Explain data sharing by service. [#1164](https://github.com/n8n-io/nod/pull/1164) (2201eee)
- **approvals:** Confirm explicit repeated actions. [#1152](https://github.com/n8n-io/nod/pull/1152) (30f7497)
- **browser:** Start sign-in receipt wait after dispatch. [commit](https://github.com/n8n-io/nod/commit/eed3de9cd05a7e12f9b190b5e391a435e7b808cf) (eed3de9)
- **files:** Fence unknown errors after a read starts. [commit](https://github.com/n8n-io/nod/commit/ed369d588205e985d08002f321d56737449410a9) (ed369d5)
- **browser:** Inspect the control that receives a click. [commit](https://github.com/n8n-io/nod/commit/a8078d9cb8a0a0d125479c443a923bcb080d4235) (a8078d9)
- **files:** Refuse stale read targets before opening. [commit](https://github.com/n8n-io/nod/commit/1c327a8cf231a0b2b869cd697e2399d83a012d5a) (1c327a8)
- **files:** Keep failed opens available for a fresh read. [commit](https://github.com/n8n-io/nod/commit/c83d661015c0bd1f72b7136fcfcc1fe077c305ac) (c83d661)
- **files:** Report a removed file during preparation. [commit](https://github.com/n8n-io/nod/commit/f8ac76f97642f481e0b381fe3865f055f67aa4ab) (f8ac76f)
- **files:** Check import version before its size limit. [commit](https://github.com/n8n-io/nod/commit/343789c470bdfb0dcb4803c40bd21a67b98af598) (343789c)
- **files:** Keep path check error details. [commit](https://github.com/n8n-io/nod/commit/cb166d7cc83a2aa4537a0b604fb5f6767ea23451) (cb166d7)
- **files:** Recheck the path after an open file read. [commit](https://github.com/n8n-io/nod/commit/a05fe65ae4021492ff6d1bf3e415571b2ea702b0) (a05fe65)
- **files:** Retain completed reads after stale questions expire. [commit](https://github.com/n8n-io/nod/commit/ec43a276ec15ef37a87944d2c53a8b2943bcd1e4) (ec43a27)
- **files:** Preserve safe read outcomes and replay fences. [commit](https://github.com/n8n-io/nod/commit/29f11fae655bb4698d2e478ac2b3ec7589c995a3) (29f11fa)
- **files:** Read the current file after an edit. [commit](https://github.com/n8n-io/nod/commit/479af449f3c086977dccabdefd4f09f1f8c760a3) (479af44)
- **browser:** Retain page changes during private submission. [commit](https://github.com/n8n-io/nod/commit/89d2f9f4174c06c21297435b67a15d6d84ff87a1) (89d2f9f)
- **browser:** Use the selected control name. [commit](https://github.com/n8n-io/nod/commit/0a3a377f9c633c24a43d2b9ba62b3ea42ebb5660) (0a3a377)
- **browser:** Refuse unnamed point approvals. [commit](https://github.com/n8n-io/nod/commit/e1deaabffa2f1a533d80be3187088f4195046ea4) (e1deaab)
- **browser:** Match native Enter key combinations. [commit](https://github.com/n8n-io/nod/commit/2f33476ce51ef990a1f0fc26fa5e9c717c6f950b) (2f33476)
- **browser:** Inspect unidentified steps before approval. [commit](https://github.com/n8n-io/nod/commit/646fb18d2efbad3da6766c3622163e9e5ab8fec8) (646fb18)
- **approvals:** Handle sentence marks and unmatched brackets. [commit](https://github.com/n8n-io/nod/commit/0c3054d74aaa970f4e34ca8a913e0950e7b63d14) (0c3054d)
- **approvals:** Keep URL boundaries in confirmation questions. [commit](https://github.com/n8n-io/nod/commit/1b172624e617bd68951c88b9f1658a709431bb6f) (1b17262)
- **approvals:** Review the visible confirmation text. [commit](https://github.com/n8n-io/nod/commit/477be9f275181ebdab0fd11461e93b8ed4727762) (477be9f)
- **ui:** Start task and activity details closed. [commit](https://github.com/n8n-io/nod/commit/05b9c37e8dcc8b10cc96eabc46fe3e087d59a13e) (05b9c37)
- **models:** Let cancellable reviews use provider deadlines. [commit](https://github.com/n8n-io/nod/commit/5312b884bb6d1943cb6b9fc00c52961bd41d9425) (5312b88)
- **schedules:** Keep confirmed stop state during refresh races. [commit](https://github.com/n8n-io/nod/commit/b322a69ec1ae51ee182f2053d633516ed45e9d0e) (b322a69)
- **usage:** Preserve completed results when usage writes fail. [commit](https://github.com/n8n-io/nod/commit/d062186885b15c1e5d2ce6e55ea2aed1c9bd517f) (d062186)
- **approvals:** Keep the HTTP account fixed during review. [commit](https://github.com/n8n-io/nod/commit/10c9895e7e761a268af3e42408f8f7f9231dd66c) (10c9895)
- **approvals:** Describe the exact HTTP request. [commit](https://github.com/n8n-io/nod/commit/4503cb5a621cffa4603702e7eb0e588a6b4c47d7) (4503cb5)
- **approvals:** Describe the selected MCP tool. [commit](https://github.com/n8n-io/nod/commit/5594ab0f487694e11ffea5559a667f76b9b9396b) (5594ab0)
- **browser:** Describe clicks without replay commands. [#1154](https://github.com/n8n-io/nod/pull/1154) (3ab125c)
- **workspace:** Check command effects before execution. [#1150](https://github.com/n8n-io/nod/pull/1150) (08a2098)
- **vault:** Match root and www login hosts (LAB-1579). [#1142](https://github.com/n8n-io/nod/pull/1142) (4c5a68d)
- **approvals:** Keep confirmed action failure reasons (LAB-1355). [#1141](https://github.com/n8n-io/nod/pull/1141) (0a4fc60)
- **desktop:** Show update failures and recovery controls (LAB-1570). [#1139](https://github.com/n8n-io/nod/pull/1139) (ea5a696)
- **browser:** Keep private submission cancellable during validation (LAB-1417). [#1138](https://github.com/n8n-io/nod/pull/1138) (650da94)
- **vault:** Keep safe browser reasons after private entry fails (LAB-1511). [#1133](https://github.com/n8n-io/nod/pull/1133) (b5f81d2)
- **tasks:** Exclude withdrawn requests from resume prompts (LAB-1399). [#1131](https://github.com/n8n-io/nod/pull/1131) (7f7e594)
- **vault:** Say why a control cannot be a sign-in choice (LAB-1510). [#1127](https://github.com/n8n-io/nod/pull/1127) (3030d9a)
- **apps:** Refuse app actions the connection service does not offer (LAB-1453). [#1121](https://github.com/n8n-io/nod/pull/1121) (0d4f768)
- **pi:** Keep send\_message loaded for small-context models (LAB-1394). [#1123](https://github.com/n8n-io/nod/pull/1123) (f8b7c29)
- **desktop:** Ignore empty groups when binding a computer use step to its window. [commit](https://github.com/n8n-io/nod/commit/ac444426d322347dc44ffb6b8b1d49ac9abbf69e) (ac44442)
- **desktop:** Trim only long lists in computer use checks and keep incomplete reads refused. [commit](https://github.com/n8n-io/nod/commit/11e6cf8c0dafa272f0a356fa21c821883d725190) (11e6cf8)
- **browser:** Bind sign-in controls in frames and under overlays (LAB-1513). [#1124](https://github.com/n8n-io/nod/pull/1124) (8937f98)
- **apps:** Keep one slow email check from stopping its read (LAB-1508). [#1125](https://github.com/n8n-io/nod/pull/1125) (40c7aa4)
- **desktop:** Check long app windows by the items a computer step needs. [commit](https://github.com/n8n-io/nod/commit/cca88809e2751bd041b06941fceb4b15f8b5ae60) (cca8880)
- Open waiting run questions in chat. [#904](https://github.com/n8n-io/nod/pull/904) (5a641cd)
- Keep the original request when retrying a task. [#1114](https://github.com/n8n-io/nod/pull/1114) (f9f0739)
- **models:** Show and change the current model in Manage. [#1117](https://github.com/n8n-io/nod/pull/1117) (4858b4c)
- **desktop:** Remove retired files on Windows upgrade and name duplicate skills (LAB-1490). [#1122](https://github.com/n8n-io/nod/pull/1122) (046e0c3)
- **desktop:** Check menu actions before the first window opens. [commit](https://github.com/n8n-io/nod/commit/ae7dbe4f3d68cdbef075c4327825c166a3734665) (ae7dbe4)
- **desktop:** Bind computer actions to current window state. [commit](https://github.com/n8n-io/nod/commit/09fcc097c889db6092c14309e5bcedb442c7e876) (09fcc09)
- **chat:** Keep strikethrough and bare addresses intact next to formatting (LAB-1509). [#1120](https://github.com/n8n-io/nod/pull/1120) (d5c99a9)
- **chat:** Stop plain delimiters pairing with composer formatting (LAB-1473). [#1115](https://github.com/n8n-io/nod/pull/1115) (5788051)
- **memory:** Say why a memory save kept nothing (LAB-1405). [#1107](https://github.com/n8n-io/nod/pull/1107) (897a140)
- **desktop:** Keep every typed field in computer use checks and close fence gaps. [commit](https://github.com/n8n-io/nod/commit/b79be918f9a570c7404193c195f32f0a1471ea1b) (b79be91)
- **desktop:** Check replaced text, typed sends and password fields in computer use. [commit](https://github.com/n8n-io/nod/commit/97a5670daa290a310d9db5acc4056335c0b886b6) (97a5670)
- **desktop:** Give focus back to the owner's window after Stop. [commit](https://github.com/n8n-io/nod/commit/d517748207a4815b1aa28d436c8484aecf1f6586) (d517748)
- **chat:** Keep formatting intact when plain text touches it (LAB-1406). [#1106](https://github.com/n8n-io/nod/pull/1106) (818d924)
- **pi:** Keep the apps tool loaded for small-context models (LAB-1302). [#1108](https://github.com/n8n-io/nod/pull/1108) (2b0c335)
- **apps:** Propose the regional MCP address for the owner's workspace (LAB-821). [#1112](https://github.com/n8n-io/nod/pull/1112) (dcf386b)
- **desktop:** Show Stop while opening an app and tighten the computer use evals. [commit](https://github.com/n8n-io/nod/commit/faf329716e611fc4ec2dd9c97bde4ea3ebbc4aa3) (faf3297)
- **apps:** Accept any MCP server name the server accepts (LAB-1196). [#1100](https://github.com/n8n-io/nod/pull/1100) (4c14dd7)
- **apps:** Keep long MCP calls open while the server reports progress (LAB-1192). [#1109](https://github.com/n8n-io/nod/pull/1109) (e6d1f3c)
- **desktop:** Stop running computer steps on Stop and address review feedback. [commit](https://github.com/n8n-io/nod/commit/a4518c95777f1b8cc7ee25d68ac2080a29eb5f4a) (a4518c9)
- **chat:** Stop fast typing from tripping React's update limit (LAB-900). [#1105](https://github.com/n8n-io/nod/pull/1105) (ecdc69c)
- **channels:** Reject reassigned WhatsApp sender IDs. [commit](https://github.com/n8n-io/nod/commit/219f97254425b0dbbead755814cff0fa941e6d72) (219f972)
- **apps:** Show the service's reason when Notion or Linear sign-in fails (LAB-1402). [#1102](https://github.com/n8n-io/nod/pull/1102) (c44ea1f)
- **desktop:** Ask the right permission question when opening apps and files. [commit](https://github.com/n8n-io/nod/commit/f2e38fa000b67797506733ffabb35eb8e6f54131) (f2e38fa)
- **onboarding:** Greet only a chat the owner hasn't written in (LAB-1461). [#1103](https://github.com/n8n-io/nod/pull/1103) (b3d3e82)
- **channels:** Use WhatsApp sender mapping updates (LAB-1437). [commit](https://github.com/n8n-io/nod/commit/9980ee3be3654879471cf46defc5baa3c784c3ad) (9980ee3)
- **desktop:** Place the computer use glow in scaled pixels on Windows. [commit](https://github.com/n8n-io/nod/commit/d8eb6a89faffa4c5846b443661760df0afcdaedb) (d8eb6a8)

### Performance

- **onboarding:** Check model connections in the background. [commit](https://github.com/n8n-io/nod/commit/249119bdff3c1c2828ad1690914541326ca2bf8c) (249119b)

### Documentation

- **files:** Include copies in file change checks. [commit](https://github.com/n8n-io/nod/commit/b84fb768f4afe727363a375bd536bebb7dd9e0e5) (b84fb76)
- **browser:** Name the steps that need an identified target. [commit](https://github.com/n8n-io/nod/commit/d841445faa9d9cbffa194ccc6848204df1f7d19a) (d841445)
- **tasks:** Match guidance to closed work details. [commit](https://github.com/n8n-io/nod/commit/c57f9d3e2f21b83d55f2a1d7dc1552c9ad19eafc) (c57f9d3)
- **approvals:** State which reviews use provider limits. [commit](https://github.com/n8n-io/nod/commit/a919c37b57ef83cf96c247812ffddd8fd7b68ae9) (a919c37)
- **usage:** Include voice results in usage recovery. [commit](https://github.com/n8n-io/nod/commit/9d09d62e273967a12b7e8775b9c025d00e769693) (9d09d62)
- **usage:** State the pending charge restart limit. [commit](https://github.com/n8n-io/nod/commit/e3105f952166d6708d5725d19c934c8fa1819a78) (e3105f9)
- **desktop:** Write release highlights in plain words. [#1134](https://github.com/n8n-io/nod/pull/1134) (30b5d11)
- Clarify documentation-only contribution workflow. [commit](https://github.com/n8n-io/nod/commit/6719c5379bdbea821bd73162524e3bd939f1e9b5) (6719c53)

<details>
<summary>Maintenance (13 changes)</summary>

- Isolate manual proactive reads. [commit](https://github.com/n8n-io/nod/commit/4bcd9d9e14084ab213e527d2f633aa072da80821) (4bcd9d9)
- **files:** Enable access in the read failure fixture. [commit](https://github.com/n8n-io/nod/commit/10af9137c08666d4d0ff7c13c9e359fa814f0a6a) (10af913)
- **files:** Keep read failures uncertain after an attempt. [commit](https://github.com/n8n-io/nod/commit/95cea5321c96b95d7f677ab72401ae7d1754a1bc) (95cea53)
- **files:** Use observed file revisions in race checks. [commit](https://github.com/n8n-io/nod/commit/11bc80c49c273fb97680750c91fbc5d28aa508b9) (11bc80c)
- **files:** Record metadata for the concurrent write check. [commit](https://github.com/n8n-io/nod/commit/2c67d565056e3ad86a12b0167fb0f29c7fc3ef73) (2c67d56)
- **browser:** Assert the exact confirmed command. [commit](https://github.com/n8n-io/nod/commit/76e8354e64bcfa1a1f135cd49bc8b6aedd9b6b1b) (76e8354)
- **pi:** Select the active restart fixture session. [commit](https://github.com/n8n-io/nod/commit/8da1a4412a6f5bf4ac36e2cf5fb8398e5e4fd0a4) (8da1a44)
- **approvals:** Require the exact MCP endpoint. [commit](https://github.com/n8n-io/nod/commit/3eac03a88e22cd96f03de79b46561a7dba2385f5) (3eac03a)
- **approvals:** Cover Markdown file names. [commit](https://github.com/n8n-io/nod/commit/f2375ef9934c933ea98a0a892fec31c12a0f7bd1) (f2375ef)
- **approvals:** Check rendered line and paragraph breaks. [commit](https://github.com/n8n-io/nod/commit/cd9710b3300e34fcdd2d5236adfc3a633932f76e) (cd9710b)
- **approvals:** Check a refused HTTP request directly. [commit](https://github.com/n8n-io/nod/commit/bb219ec0aa1aa053f688957fc05ac474f850dcfc) (bb219ec)
- **workspace:** Measure RTK at its protected path. [#1156](https://github.com/n8n-io/nod/pull/1156) (623eee9)
- **whatsapp:** Reproduce dropped bot-mode messages. [commit](https://github.com/n8n-io/nod/commit/85712d1ae22ce4c7c4fddb35c3a21965b8eba770) (85712d1)

</details>

More commits are included; review the full Git history.
[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.8.4...94fe4b57b42e3a046ac8c6514cab0aa423f95409)

<details>
<summary>Build details</summary>

Source: `94fe4b57b42e3a046ac8c6514cab0aa423f95409`
Previous release: `nod-v0.8.4`

</details>

## 0.8.4 - 2026-11-17

### Features

- **apps:** Support API and CLI community connectors. [#1034](https://github.com/n8n-io/nod/pull/1034) (cc81434)
- **desktop:** Open the file menu when right-clicking a file in the preview panel (LAB-1129). [#1023](https://github.com/n8n-io/nod/pull/1023) (8cbfd3f)
- **apps:** Add community connectors and contributor tools. [#1019](https://github.com/n8n-io/nod/pull/1019) (54a6b50)
- **feedback:** Rename the feedback button to Report bug and offer it when Nod fails (LAB-1344). [#1001](https://github.com/n8n-io/nod/pull/1001) (7c794d4)
- **apps:** Allow an owner-typed private MCP address in Connect MCP. [#911](https://github.com/n8n-io/nod/pull/911) (7f64c5f)
- **analytics:** Record whether a clicked task card was learned or common (LAB-1348). [#998](https://github.com/n8n-io/nod/pull/998) (b3d9777)
- **chat:** Show recent work in the activity line. [#994](https://github.com/n8n-io/nod/pull/994) (c025b64)

### Fixes

- **models:** Use another free port when ChatGPT sign-in can't open 1455 (LAB-1338). [#1020](https://github.com/n8n-io/nod/pull/1020) (71b98cd)
- **apps:** Close sign-in expiry races at the 10-minute boundary (LAB-1255). [#1027](https://github.com/n8n-io/nod/pull/1027) (242f7cf)
- **apps:** Show the service's reason when MCP sign-in can't start (LAB-1204). [#1026](https://github.com/n8n-io/nod/pull/1026) (b80d239)
- **memory:** Save details an explicit remember request points back to (LAB-1357). [#1025](https://github.com/n8n-io/nod/pull/1025) (3a47f4d)
- **apps:** Record where an expired app sign-in stopped (LAB-1255). [#1024](https://github.com/n8n-io/nod/pull/1024) (6d100a5)
- **apps:** Remove the ambiguous plus from connected app cards (LAB-1200). [#1022](https://github.com/n8n-io/nod/pull/1022) (7318f39)
- **apps:** Keep the connection service's reason and status when a file upload fails (LAB-1256). [#1012](https://github.com/n8n-io/nod/pull/1012) (9297b24)
- **runtime:** Remove set\_status and improve request diagnostics. [commit](https://github.com/n8n-io/nod/commit/156c32520b25162c87f125d7474a3a1d6ed95359) (156c325)
- **memory:** Keep line breaks in notes the owner writes (LAB-1301). [#1018](https://github.com/n8n-io/nod/pull/1018) (16f7d34)
- **account:** Accept every local address the access check allows (LAB-1248). [#1010](https://github.com/n8n-io/nod/pull/1010) (518b79e)
- **chat:** Save replies that name workspace paths Nod can't attach (LAB-1334). [#1015](https://github.com/n8n-io/nod/pull/1015) (ac08d71)
- **apps:** Send a User-Agent on every remote MCP and API request (LAB-997). [#1013](https://github.com/n8n-io/nod/pull/1013) (9f8c319)
- **activation:** Show setup failures and add Open chat after connection. [commit](https://github.com/n8n-io/nod/commit/93c7f96f5959cfc195d14fc58703d56bb9fb209c) (93c7f96)
- **chat:** Recover after terminal context errors. [#1009](https://github.com/n8n-io/nod/pull/1009) (c1e186e)
- **pi:** Read streamed content part arrays as answer text (LAB-968). [#1014](https://github.com/n8n-io/nod/pull/1014) (2bc0a9f)
- **chat:** Leave large earlier tool results out of a cold request (LAB-1211). [#995](https://github.com/n8n-io/nod/pull/995) (001b23f)
- Name Settings screens from the shared page list. [#962](https://github.com/n8n-io/nod/pull/962) (62a9a7f)
- **trust:** Match quotes that differ from the owner's words only in accents (LAB-1038). [#981](https://github.com/n8n-io/nod/pull/981) (3b4182f)
- **analytics:** Show each survey only once (LAB-1214). [#1000](https://github.com/n8n-io/nod/pull/1000) (6e57923)

### Performance

- **pi:** Keep tools loaded earlier in a session for later turns (LAB-1169). [#993](https://github.com/n8n-io/nod/pull/993) (a04a751)

<details>
<summary>Maintenance (2 changes)</summary>

- **desktop:** Remove the partial file when an artifact export fails. [#965](https://github.com/n8n-io/nod/pull/965) (dec58c7)
- **url-guards:** Prove the pinned transport stops reading at its byte limit. [#964](https://github.com/n8n-io/nod/pull/964) (0813f46)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.8.3...cc81434d87b2ad15f7c2d0934c4ac6824c4db0fb)

<details>
<summary>Build details</summary>

Source: `cc81434d87b2ad15f7c2d0934c4ac6824c4db0fb`
Previous release: `nod-v0.8.3`

</details>

## 0.8.3 - 2026-11-17

### Fixes

- **proactivity:** Don't start automatic preparation on a model without a price. [#990](https://github.com/n8n-io/nod/pull/990) (357f34d)
- **pi:** Remove duplicate context budgeting. [commit](https://github.com/n8n-io/nod/commit/3017a9448fc96cc1bf95f60eb370c143e79f53f6) (3017a94)
- **browser:** Pace handoff frames to display. [commit](https://github.com/n8n-io/nod/commit/6cebf4f0941cdae2f2f40f7cdbf61a4720944ec7) (6cebf4f)
- **apps:** Start the email check time limit when the check runs. [#976](https://github.com/n8n-io/nod/pull/976) (990285a)
- **agent:** Balance feedback during long tasks. [#975](https://github.com/n8n-io/nod/pull/975) (47cfee3)
- **workspace:** Recover after an uncertain command and keep long self-hosted commands open. [#972](https://github.com/n8n-io/nod/pull/972) (64dd140)
- **channels:** Accept the owner's WhatsApp messages sent from a private ID. [#974](https://github.com/n8n-io/nod/pull/974) (48970da)
- **browser:** Open a profile locked by a replaced browser container. [#973](https://github.com/n8n-io/nod/pull/973) (78d9fb6)
- **desktop:** Skip expired system certificates. [#971](https://github.com/n8n-io/nod/pull/971) (f43c22e)
- **desktop:** Restart from the update notice without asking again. [#970](https://github.com/n8n-io/nod/pull/970) (f89047f)
- **pi:** Send tool schemas that match JSON Schema draft 2020-12. [#968](https://github.com/n8n-io/nod/pull/968) (c892150)
- **apps:** Sign connection service requests again when the computer clock is off. [#967](https://github.com/n8n-io/nod/pull/967) (c4816b1)

### Performance

- **ci:** Share PR setup and stage platform release checks. [#980](https://github.com/n8n-io/nod/pull/980) (7c65518)

<details>
<summary>Maintenance (2 changes)</summary>

- **pi:** Pin that a long turn extends each request unchanged until Pi compacts. [#991](https://github.com/n8n-io/nod/pull/991) (adc3c06)
- **channels:** Pin the Telegram download size limits. [commit](https://github.com/n8n-io/nod/commit/f5e288ca0117276058329069714cec49a26319c6) (f5e288c)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.8.2...adc3c0603d4847603df3fe2c0b5e701af6a2c07c)

<details>
<summary>Build details</summary>

Source: `adc3c0603d4847603df3fe2c0b5e701af6a2c07c`
Previous release: `nod-v0.8.2`

</details>

## 0.8.2 - 2026-11-16

### Features

- **local-files:** Enable file access through chat approval. [#949](https://github.com/n8n-io/nod/pull/949) (d87da94)

### Fixes

- **desktop:** Install guest images atomically and recover first starts. [#913](https://github.com/n8n-io/nod/pull/913) (60598bd)
- **channels:** Parse quoted contact card parameters. [#915](https://github.com/n8n-io/nod/pull/915) (1201345)
- **desktop:** Separate account onboarding from device setup. [commit](https://github.com/n8n-io/nod/commit/bdec709de4698e9857946890b0a9bcb975728353) (bdec709)
- **apps:** Count one connection service refusal per wait step. [commit](https://github.com/n8n-io/nod/commit/9fc4cc9d5f946f89ec276648f40da73e21eb1cc3) (9fc4cc9)
- **models:** Recommend Gemini 4 Argon for Google. [#950](https://github.com/n8n-io/nod/pull/950) (866158b)
- **pi:** Fit requests before context overflow. [#946](https://github.com/n8n-io/nod/pull/946) (48e853c)

<details>
<summary>Maintenance (1 changes)</summary>

- **evals:** Add local files capability evals. [#941](https://github.com/n8n-io/nod/pull/941) (d4a1b6c)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.8.1...60598bd3cac73a5ea6bc3814cf28faf46e7aaf18)

<details>
<summary>Build details</summary>

Source: `60598bd3cac73a5ea6bc3814cf28faf46e7aaf18`
Previous release: `nod-v0.8.1`

</details>

## 0.8.1 - 2026-11-16

### Fixes

- **integrations:** Defer Gmail polling after proxy refusals. [#944](https://github.com/n8n-io/nod/pull/944) (b40b632)
- **apps:** Include Cloudflare Ray ID on HTML 403s. [#943](https://github.com/n8n-io/nod/pull/943) (13cda50)
- **schedules:** Skip watch polling for stale jobs. [#942](https://github.com/n8n-io/nod/pull/942) (7438960)
- **apps:** Keep the connection service's status and code when an app connection can't start. [#877](https://github.com/n8n-io/nod/pull/877) (67298e9)

<details>
<summary>Maintenance (13 changes)</summary>

- **deps:** Keep only the reviewed dependency changes. [commit](https://github.com/n8n-io/nod/commit/b72529fe8b78de0ef227c4bc0c8ca366100789aa) (b72529f)
- **deps-dev:** Bump the tiptap group across 1 directory with 9 updates. [commit](https://github.com/n8n-io/nod/commit/1912c3220591e4c3eddb68c4b75637935485bf6a) (1912c32)
- **deps:** Bump the docs group across 1 directory with 2 updates. [commit](https://github.com/n8n-io/nod/commit/c9dbec4c462966d93b09bfe91c8a448c7a09e1ac) (c9dbec4)
- **deps-dev:** Bump the tailwindcss group across 1 directory with 2 updates. [commit](https://github.com/n8n-io/nod/commit/74cf053714cf4d22cdd07173a460133971010b37) (74cf053)
- **deps:** Bump the pi group across 1 directory with 2 updates. [commit](https://github.com/n8n-io/nod/commit/bfe15cf06bc560c01a22d83754260f2cfa8df49e) (bfe15cf)
- **deps:** Bump posthog-node from 5.60.1 to 5.71.0. [commit](https://github.com/n8n-io/nod/commit/e27b383249d9fe87dc0f8b313cade6a4c2ec4a18) (e27b383)
- **deps:** Bump parse5 from 8.0.1 to 8.1.1. [commit](https://github.com/n8n-io/nod/commit/bbd9c57c51ea9dcd9f46ad62fc9612cb8b3683d9) (bbd9c57)
- **deps:** Bump dotenv from 18.0.9 to 18.0.10. [commit](https://github.com/n8n-io/nod/commit/e40879fef970804d481fdfb89ad2fd2f4f546850) (e40879f)
- **deps-dev:** Bump unist-util-visit from 5.1.0 to 5.2.0. [commit](https://github.com/n8n-io/nod/commit/5f78872989e2b581456ef8211191234e112e0da9) (5f78872)
- **deps-dev:** Bump lucide-react from 1.61.0 to 1.72.0. [commit](https://github.com/n8n-io/nod/commit/cb3e81569b7928c3f2e1dbbff4279e48a7024da5) (cb3e815)
- **deps:** Bump jose from 6.2.14 to 6.2.17. [commit](https://github.com/n8n-io/nod/commit/4ee956c645078241198f23a8f7796bab6a15d31f) (4ee956c)
- **deps:** Bump peter-evans/create-pull-request. [commit](https://github.com/n8n-io/nod/commit/8155369f177f02cb501c829a2c7acc9fb0b3a421) (8155369)
- **deps:** Bump rust in /. [commit](https://github.com/n8n-io/nod/commit/3def1e2bc084bd5210512716a22b3a5ff77e666c) (3def1e2)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.8.0...b40b6329e34a78f4f1628a741efb776950683fb1)

<details>
<summary>Build details</summary>

Source: `b40b6329e34a78f4f1628a741efb776950683fb1`
Previous release: `nod-v0.8.0`

</details>

## 0.8.0 - 2026-11-16

### Features

- **desktop:** Keep the computer awake while a local task runs. [commit](https://github.com/n8n-io/nod/commit/df4cd6015090b80f2970f2b00326b82a22222d7e) (df4cd60)
- **models:** Choose a model for schedules, Nod's own work and each task. [#910](https://github.com/n8n-io/nod/pull/910) (7635ffd)
- **chat:** Show which task or schedule a question belongs to and its progress. [#887](https://github.com/n8n-io/nod/pull/887) (49ac827)
- **evals:** Add a model capability matrix and computer-use cases. [commit](https://github.com/n8n-io/nod/commit/7c5fffa2c68a7de78648d71f4a172fac2d3cfcbc) (7c5fffa)

### Fixes

- **backend:** Correct the NOD\_PUBLIC\_URL host checks and document the error. [#893](https://github.com/n8n-io/nod/pull/893) (e1cf299)
- **models:** Recover from failing model connections without guessing at error text. [#912](https://github.com/n8n-io/nod/pull/912) (27f202c)
- **chat:** Guide users to a first useful task. [commit](https://github.com/n8n-io/nod/commit/cfa92109461c2efcc6aa12f1297f29f38b8b2abf) (cfa9210)
- **pi:** Use native context recovery. [commit](https://github.com/n8n-io/nod/commit/d40be9c247872f819da7d0b8152564ed58bfaa5c) (d40be9c)
- **apps:** Mark a write as not run when the connection service refuses session create. [#907](https://github.com/n8n-io/nod/pull/907) (15397ab)
- **models:** Handle partial metadata across compatible servers. [commit](https://github.com/n8n-io/nod/commit/f41c721e2c1a0b2a8d27779ae2727f3d30946cf9) (f41c721)
- **models:** Treat OpenAI-compatible servers as Ollama only when /api…. [commit](https://github.com/n8n-io/nod/commit/73f5b7eb0d94ae9693ffc0eefc43c6512228cc1f) (73f5b7e)
- **local-files:** Attach a local file when the owner asks to see it. [#901](https://github.com/n8n-io/nod/pull/901) (3813cd6)
- **deps:** Override vulnerable adm-zip to 0.6.1. [commit](https://github.com/n8n-io/nod/commit/ee7c178517cd8a846e2a266d8d73ee59d16bf921) (ee7c178)
- **trust:** Preserve owner instructions across schedule updates. [#888](https://github.com/n8n-io/nod/pull/888) (9be6b24)
- **deps:** Update vulnerable transitive dependencies. [commit](https://github.com/n8n-io/nod/commit/fb1cacd07cdb177be6783e561e48a6259aa7df72) (fb1cacd)
- **local-files:** Expand \~ to the home folder in file paths. [#889](https://github.com/n8n-io/nod/pull/889) (b2c6f5d)
- **deps:** Update HTTP dependencies for DEVP-1541. [commit](https://github.com/n8n-io/nod/commit/526ba31acbf6080dfafd9a6aa8a21de7d32fdb35) (526ba31)
- **desktop:** Move the preview note below the server link on the welcome screen. [#886](https://github.com/n8n-io/nod/pull/886) (f77f9b2)
- **apps:** Back off connection service reads after a rate limit. [commit](https://github.com/n8n-io/nod/commit/ac8854aceea1a7e1e5d6b14f5f8069a5750f50dd) (ac8854a)

<details>
<summary>Maintenance (1 changes)</summary>

- **deps:** Bump undici to 7.30.2. [commit](https://github.com/n8n-io/nod/commit/f6400141f7c00223d59bdcd3f042ec935530aa00) (f640014)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.7.6...e1cf299e14a83973ec665ead9404b99bf4ab969b)

<details>
<summary>Build details</summary>

Source: `e1cf299e14a83973ec665ead9404b99bf4ab969b`
Previous release: `nod-v0.7.6`

</details>

## 0.7.6 - 2026-11-13

### Features

- **desktop:** Add font size controls to appearance settings. [#868](https://github.com/n8n-io/nod/pull/868) (5b9e1b2)
- **tasks:** Show workspace commands in Usage and CSV exports. [#830](https://github.com/n8n-io/nod/pull/830) (d978807)
- **proactivity:** Skip idle work and batch changes through quiet hours. [commit](https://github.com/n8n-io/nod/commit/842becde0adeac0fcb3eabfb8b813deeb0efdffc) (842becd)

### Fixes

- **integrations:** Recover Gmail polling after transient proxy errors. [#875](https://github.com/n8n-io/nod/pull/875) (3ab2f07)
- **composio:** Preserve catalog proxy failures (LAB-983). [#874](https://github.com/n8n-io/nod/pull/874) (76ecbb2)
- Trust system certificates in desktop engine (LAB-983). [#873](https://github.com/n8n-io/nod/pull/873) (675886f)
- **approvals:** Restore clear questions and action labels. [#864](https://github.com/n8n-io/nod/pull/864) (9b82c5f)
- Fit onboarding window to screen and clean up chat UI. [#863](https://github.com/n8n-io/nod/pull/863) (a239b50)
- **sign-in:** Keep fresh method choices open for 30 minutes. [#869](https://github.com/n8n-io/nod/pull/869) (5ac5f3d)
- **proactivity:** Stagger periodic checks by installation. [#870](https://github.com/n8n-io/nod/pull/870) (3816f36)
- **payments:** Clarify web approval and unblock unrelated chat. [#796](https://github.com/n8n-io/nod/pull/796) (cf362e5)

### Documentation

- Keep the cover shadow inside its frame and let the results heading wrap on phones. [commit](https://github.com/n8n-io/nod/commit/0889cc0283203149d34670a559fd6c92b6ac868e) (0889cc0)
- Restore the results heading with the test run count. [commit](https://github.com/n8n-io/nod/commit/3f86e131519bee7ed1644e6d302adcc1fc756a0b) (3f86e13)
- Match the README roadmap to the landing page. [commit](https://github.com/n8n-io/nod/commit/63ebe1b38166c5daeebab90e66e79f37b1d7090f) (63ebe1b)
- Use the new hero collage, add a shadow to the video cover and expand the video on play. [commit](https://github.com/n8n-io/nod/commit/742c08ca0d418789dbbfc0c56cbea7beb34b2c8c) (742c08c)
- Keep the video poster visible while loading and honour reduced motion in the FAQ. [commit](https://github.com/n8n-io/nod/commit/d076b181451308149338520e59e5cd4a9a56e871) (d076b18)
- Tighten the landing page hero and give the video cover more room. [commit](https://github.com/n8n-io/nod/commit/360e59719c2fb9986bd8dc163de53ea09d33e90e) (360e597)
- Centre the memory and results sections, reorder the landing page and tighten the hero. [commit](https://github.com/n8n-io/nod/commit/2a7f152a900a7a1c5ac6e34c51b090f2f49e99f1) (2a7f152)
- Rework the landing page footer and hero tag, and shrink the headline. [commit](https://github.com/n8n-io/nod/commit/212ca0d00516aef0482a327ddcf914843a7cfefe) (212ca0d)
- Restyle the landing page header, use an app screenshot as the video cover and move the closing button onto the dot grid. [commit](https://github.com/n8n-io/nod/commit/555ad4a3cfa224c7a3aab12dacc98a12bdeef1e6) (555ad4a)
- Self-host the landing page demo video and rework the memory, stats and roadmap sections. [commit](https://github.com/n8n-io/nod/commit/cd9045f1c9660f33cf15b7e46b3c1db07a4f2727) (cd9045f)
- Polish the landing page stats, roadmap icons, links and FAQ. [commit](https://github.com/n8n-io/nod/commit/b1bd0ff3fa960e6ef7c2dec47df35be40d0e6420) (b1bd0ff)
- Rework the landing page stats, headings and hero spacing. [commit](https://github.com/n8n-io/nod/commit/3abe57ff88ca84f403779a2dfe3d9d706630adbe) (3abe57f)
- Rework the landing page header, hero and section order. [commit](https://github.com/n8n-io/nod/commit/cd83994564948a413a0563fbbb1d5ed0389e5315) (cd83994)
- Simplify the landing page and add platform icons. [commit](https://github.com/n8n-io/nod/commit/e5d801b96f2b93e06f28a878075460d6fa6149d5) (e5d801b)
- Match the landing page dot grid to the n8n site. [commit](https://github.com/n8n-io/nod/commit/52a323fd58abec0799669ab27fee8f0c66149538) (52a323f)
- Polish the landing page FAQ. [commit](https://github.com/n8n-io/nod/commit/5d95a5ce11b392a8c4f30e40128061999c2731c0) (5d95a5c)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.7.5...3ab2f076766bff409567ce850a2cb18bc5628dbf)

<details>
<summary>Build details</summary>

Source: `3ab2f076766bff409567ce850a2cb18bc5628dbf`
Previous release: `nod-v0.7.5`

</details>

## 0.7.5 - 2026-11-13

### Features

- **analytics:** Separate execution results from model failures. [#852](https://github.com/n8n-io/nod/pull/852) (66b5420)
- **docs:** Add an About n8n labs box to the landing page. [#844](https://github.com/n8n-io/nod/pull/844) (770a7d4)
- **desktop:** Use Nod's own title bar on Windows. [commit](https://github.com/n8n-io/nod/commit/a521e8a6e67df7b03999dd2a896eff30f8726f96) (a521e8a)

### Fixes

- **pi:** Recover context overflows across models. [#843](https://github.com/n8n-io/nod/pull/843) (8c86251)
- Configure e2e approval curators (LAB-899). [#791](https://github.com/n8n-io/nod/pull/791) (593b2b6)
- **models:** Rewrite another model's tool call ids for OpenAI-compatible servers. [commit](https://github.com/n8n-io/nod/commit/847e3bbd1db93b1739feb71cdf8feae6419876db) (847e3bb)
- **usage:** Show activity in computer time zone. [#801](https://github.com/n8n-io/nod/pull/801) (9346ce1)
- **gmail:** Identify draft in cleanup approval (LAB-762). [#810](https://github.com/n8n-io/nod/pull/810) (02b2483)
- **docs:** Add site security headers and disclosure file. [commit](https://github.com/n8n-io/nod/commit/d6207ed48d8b9f6dc4e7ab46297d1700ff59e2db) (d6207ed)

### Performance

- **memory:** Bound recall selection input. [#800](https://github.com/n8n-io/nod/pull/800) (5448656)

<details>
<summary>Maintenance (1 changes)</summary>

- Add a feature video skill for pull requests and releases. [#853](https://github.com/n8n-io/nod/pull/853) (f193a06)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.7.4...3d4a3588fad454ed01ad620274f3a744ed8eb06b)

<details>
<summary>Build details</summary>

Source: `3d4a3588fad454ed01ad620274f3a744ed8eb06b`
Previous release: `nod-v0.7.4`

</details>

## 0.7.4 - 2026-11-13

### Features

- **usage:** Record everything Nod did, export it as CSV and answer from it. [#840](https://github.com/n8n-io/nod/pull/840) (1dcec5f)
- **agent:** Answer any Nod question from bundled docs. [#839](https://github.com/n8n-io/nod/pull/839) (094f67a)
- **schedules:** Add Run now. [#838](https://github.com/n8n-io/nod/pull/838) (440d204)

### Fixes

- **vault:** Clarify unknown sign-in recovery. [#804](https://github.com/n8n-io/nod/pull/804) (6f1cd18)
- **trust:** Bind approval questions to exact actions. [#799](https://github.com/n8n-io/nod/pull/799) (9c87975)
- **sign-in:** Surface expired form status to next turn. [#788](https://github.com/n8n-io/nod/pull/788) (95231b7)
- **chat:** Explain overlong pasted messages. [#789](https://github.com/n8n-io/nod/pull/789) (af89389)
- **tasks:** Avoid duplicate acknowledgements. [#790](https://github.com/n8n-io/nod/pull/790) (73007ed)
- Cache stable scheduled request prefixes. [#786](https://github.com/n8n-io/nod/pull/786) (bc121f3)
- **channels:** Clarify desktop WhatsApp availability. [#785](https://github.com/n8n-io/nod/pull/785) (fd63563)
- **runtime:** Stop repeated failures and keep recovery causes. [#836](https://github.com/n8n-io/nod/pull/836) (a0c029d)
- **channels:** Recover Telegram and WhatsApp connections. [commit](https://github.com/n8n-io/nod/commit/956ebb1a60374dc4f2041d13759a06fd13e2450d) (956ebb1)
- **desktop:** Quote the Windows uninstall command correctly. [#834](https://github.com/n8n-io/nod/pull/834) (52947da)
- **web:** Remove fixed from onboarding data sharing text. [#835](https://github.com/n8n-io/nod/pull/835) (6afb888)
- **models:** Recover from request, access and quota failures. [#811](https://github.com/n8n-io/nod/pull/811) (65132ee)
- **models:** Let local models answer after Pi's 5-minute request timeout. [#808](https://github.com/n8n-io/nod/pull/808) (e9d5813)
- **chat:** Show what Nod is doing instead of filler words. [#802](https://github.com/n8n-io/nod/pull/802) (ecbb6cc)

### Documentation

- Say the computer restarted in the Keep Nod running table. [commit](https://github.com/n8n-io/nod/commit/78b299a51ce76c92d38cc8cbc483d2889950831e) (78b299a)
- **setup:** List the Docker Buildx plugin as a source-install requirement. [#812](https://github.com/n8n-io/nod/pull/812) (915e4f1)
- Explain that schedules wait for sign-in after a restart. [commit](https://github.com/n8n-io/nod/commit/0dd6f1c004ccadfc39694dcf33fceabf0d01df2e) (0dd6f1c)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.7.3...6f1cd18a14128e296b9982da2eccdf69e40cf6f0)

<details>
<summary>Build details</summary>

Source: `6f1cd18a14128e296b9982da2eccdf69e40cf6f0`
Previous release: `nod-v0.7.3`

</details>

## 0.7.3 - 2026-11-12

### Features

- **desktop:** Link update notices to release notes. [#784](https://github.com/n8n-io/nod/pull/784) (ad45a5e)

### Fixes

- **release:** Wait up to five minutes for GitHub to list a published release. [#806](https://github.com/n8n-io/nod/pull/806) (8bb2d56)
- **chat:** Give useful ideas before app setup. [commit](https://github.com/n8n-io/nod/commit/2746e8e30d6fecb184d1b3ab5f5273f742beae33) (2746e8e)
- **backend:** Stop memory treating long link IDs as card numbers. [#764](https://github.com/n8n-io/nod/pull/764) (9ee5770)
- **traces:** Include the Nod version in trace metadata. [#798](https://github.com/n8n-io/nod/pull/798) (3eef252)
- **approvals:** Preserve task continuation after non-answer. [#787](https://github.com/n8n-io/nod/pull/787) (08ca218)
- **chat:** Keep Stop separate from Send. [#781](https://github.com/n8n-io/nod/pull/781) (67dd237)
- **onboarding:** Skip work-use follow-up for personal scope. [#780](https://github.com/n8n-io/nod/pull/780) (2f2f014)
- Honor clock preference in quiet hours. [#778](https://github.com/n8n-io/nod/pull/778) (1039be5)
- Fit source containers to Docker CPU allocation. [#776](https://github.com/n8n-io/nod/pull/776) (970060f)
- **feedback:** Separate notice from diagnostic scroll area. [#777](https://github.com/n8n-io/nod/pull/777) (aebc9d8)
- **desktop:** Clarify local setup heading. [#775](https://github.com/n8n-io/nod/pull/775) (9423daa)
- **approvals:** Give confirmation repair specific feedback. [#782](https://github.com/n8n-io/nod/pull/782) (9acf7e1)
- **history:** Open turn references returned by search. [#783](https://github.com/n8n-io/nod/pull/783) (1b17108)

<details>
<summary>Maintenance (1 changes)</summary>

- Stabilize scheduled task integration fixtures. [#773](https://github.com/n8n-io/nod/pull/773) (19fe8cf)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.7.2...8bb2d5672f89e2a2ddcca45fdbc8fb726c0cd8ec)

<details>
<summary>Build details</summary>

Source: `8bb2d5672f89e2a2ddcca45fdbc8fb726c0cd8ec`
Previous release: `nod-v0.7.2`

</details>

## 0.7.2 - 2026-11-12

### Features

- **chat:** Answer questions and approvals on inline cards. [commit](https://github.com/n8n-io/nod/commit/b5ca2291efd8f6fa46104dd2817c6ed5aed79a0a) (b5ca229)

### Fixes

- Keep Windows workspace paths and observer inputs valid. [#774](https://github.com/n8n-io/nod/pull/774) (3e7cb1c)
- **backend:** Guard missing token and text values. [commit](https://github.com/n8n-io/nod/commit/1de94edc35974975ac11dd7cb3c3e944666b4c26) (1de94ed)
- Address recent desktop feedback. [#771](https://github.com/n8n-io/nod/pull/771) (d6581fb)
- **desktop:** Show the Nod icon in the Windows app. [#770](https://github.com/n8n-io/nod/pull/770) (7c442fe)
- **desktop:** Log when the background service health wait times out. [#769](https://github.com/n8n-io/nod/pull/769) (6919de1)
- **backend:** Tell a late scheduled run it is late. [#766](https://github.com/n8n-io/nod/pull/766) (6e37fbc)
- **backend:** Log why a trust check answer was unusable. [#768](https://github.com/n8n-io/nod/pull/768) (37a1fe3)
- **backend:** Keep the Gmail check moving past an oversized message. [#767](https://github.com/n8n-io/nod/pull/767) (cdc1050)
- **backend:** Keep owner-edited learned skills from agent overwrites. [#765](https://github.com/n8n-io/nod/pull/765) (b9b6840)
- Unblock model requests and narrow Linux CI. [#757](https://github.com/n8n-io/nod/pull/757) (8af6bdb)
- **scripts:** Run pnpm start on Windows. [#751](https://github.com/n8n-io/nod/pull/751) (cff2409)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.7.1...3e7cb1c40c1bf588c662df77a8c196270651a500)

<details>
<summary>Build details</summary>

Source: `3e7cb1c40c1bf588c662df77a8c196270651a500`
Previous release: `nod-v0.7.1`

</details>

## 0.7.1 - 2026-11-12

### Features

- **release:** Publish reviewed product highlights. [commit](https://github.com/n8n-io/nod/commit/ceed72d2c31b1eec83833ed2ee1489ad28d8d160) (ceed72d)

### Fixes

- **release:** Keep the GitHub CLI's reason when a release call fails. [#756](https://github.com/n8n-io/nod/pull/756) (e28a6e9)
- **models:** Support OpenAI project regions. [#753](https://github.com/n8n-io/nod/pull/753) (ad8f416)
- Explain provider failures after model changes. [#728](https://github.com/n8n-io/nod/pull/728) (29fe7f9)
- **activity:** Start core service status updates with a verb. [#724](https://github.com/n8n-io/nod/pull/724) (e5f77b3)
- **web:** Allow section shortcuts from chat composer. [#726](https://github.com/n8n-io/nod/pull/726) (54f832e)
- **apps:** Show one return action after sign-in. [commit](https://github.com/n8n-io/nod/commit/c0c15236e3311c8900f67561fd7b06890075eef0) (c0c1523)
- **pi:** Repair assistant blocks before model requests. [commit](https://github.com/n8n-io/nod/commit/dbef2b3a3d8a48494315fc817b644367cd9e4053) (dbef2b3)

<details>
<summary>Maintenance (2 changes)</summary>

- Select checks by changed files and run jobs in parallel. [#755](https://github.com/n8n-io/nod/pull/755) (ec30cb9)
- **landing:** Remove the Product Hunt launch banner. [#754](https://github.com/n8n-io/nod/pull/754) (4aba997)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.7.0...e28a6e9fac34f9f352a48c4ad39ee2ccf8d5d4ca)

<details>
<summary>Build details</summary>

Source: `e28a6e9fac34f9f352a48c4ad39ee2ccf8d5d4ca`
Previous release: `nod-v0.7.0`

</details>

## 0.7.0 - 2026-11-12

### Features

- **desktop:** Add Linux Flatpak builds to desktop releases. [commit](https://github.com/n8n-io/nod/commit/a9b054be54c26042f482a8037d04224adc6e1676) (a9b054b)
- **traces:** Group traces into conversations cut after 30 idle minutes. [#746](https://github.com/n8n-io/nod/pull/746) (8f3ccd8)
- **desktop:** Package Nod for Linux as a Flatpak. [#721](https://github.com/n8n-io/nod/pull/721) (f63cc2f)
- **trust:** Let owners change a reached spending limit from any channel. [#703](https://github.com/n8n-io/nod/pull/703) (ac2d13a)
- **analytics:** Measure verified desktop server connections. [#702](https://github.com/n8n-io/nod/pull/702) (8551a11)
- **trust:** Add a default monthly spending cap for safety. [#691](https://github.com/n8n-io/nod/pull/691) (0e1d6e5)
- **landing:** Add a Product Hunt launch banner. [#690](https://github.com/n8n-io/nod/pull/690) (1ed16f6)
- **landing:** Animate the On your machine panels. [#687](https://github.com/n8n-io/nod/pull/687) (126358d)
- Open local files by who started the work instead of a folder list. [commit](https://github.com/n8n-io/nod/commit/7e9123c9681f50c6b1d131424e64b728a7142fb6) (7e9123c)
- Show Handling local files while a local file action runs. [commit](https://github.com/n8n-io/nod/commit/f10653bcd76c28c74de322ae2eebb1c8b55a78b7) (f10653b)
- **web:** Show Local files among connected or available apps. [commit](https://github.com/n8n-io/nod/commit/027c7b2742d1b027ac82a53b5aa67837e6825233) (027c7b2)
- Make local files production-ready. [commit](https://github.com/n8n-io/nod/commit/fdbffd7c3fd1c9184d257dfeccc50fea168548d1) (fdbffd7)
- Share local folders with Nod (spike). [commit](https://github.com/n8n-io/nod/commit/ffdb2025e1c3af6abddc6f35dc6b9b9113c7c2ee) (ffdb202)

### Fixes

- **tasks:** Dispatch planned checks under the thread lock. [#745](https://github.com/n8n-io/nod/pull/745) (f4fe0e3)
- **tasks:** Start a task's planned check after an answered question. [#736](https://github.com/n8n-io/nod/pull/736) (8609e5f)
- **models:** Preserve provider error details. [commit](https://github.com/n8n-io/nod/commit/ea44d88caf35d8e208048f94fd58644984f299b2) (ea44d88)
- **desktop:** Trust operating system certificates for server connections. [commit](https://github.com/n8n-io/nod/commit/33a7f99b3c85307ccaa83545608deaff7c940918) (33a7f99)
- **backend:** Add OpenCode curator session IDs. [#740](https://github.com/n8n-io/nod/pull/740) (d1e4e35)
- **chat:** Interpret reactions and answer each follow-up. [#730](https://github.com/n8n-io/nod/pull/730) (079f534)
- **thread:** Keep a stopped or provider-failed request out of later model input. [#729](https://github.com/n8n-io/nod/pull/729) (736bef1)
- **apps:** Keep sign-in links available through browser previews. [#727](https://github.com/n8n-io/nod/pull/727) (dd21029)
- **desktop:** Rename startup server link. [#725](https://github.com/n8n-io/nod/pull/725) (22de1a9)
- **approvals:** Answer only the confirmation a reply was read against. [#723](https://github.com/n8n-io/nod/pull/723) (d1461f4)
- **setup:** Point the database password hint at pnpm start. [commit](https://github.com/n8n-io/nod/commit/6c56a0c7f7101fa05f9a4b91a2c3a3d29fa71f0d) (6c56a0c)
- **pi:** Keep a failed request's input out of later turns. [#714](https://github.com/n8n-io/nod/pull/714) (520c742)
- **approvals:** Tell the session a confirmed action's outcome after Stop. [#712](https://github.com/n8n-io/nod/pull/712) (7cf3856)
- **thread:** Order messages in flight before a later Stop. [#715](https://github.com/n8n-io/nod/pull/715) (0f7a605)
- **vault:** Submit a chat sign-in code only when it is sent by itself. [#711](https://github.com/n8n-io/nod/pull/711) (ec4fd19)
- **channels:** Send every Telegram text message with link previews off. [#709](https://github.com/n8n-io/nod/pull/709) (0d9ac34)
- **landing:** Load the hero video on click and fix audit findings. [#708](https://github.com/n8n-io/nod/pull/708) (ed50741)
- **runtime:** Refine workspace networking. [#707](https://github.com/n8n-io/nod/pull/707) (837d3f7)
- **desktop:** Make Windows updates install. [#704](https://github.com/n8n-io/nod/pull/704) (a472ecc)
- **apps:** Keep Gmail inbox polling going past a message with no labels. [commit](https://github.com/n8n-io/nod/commit/8cb9efc2ac9556197fb025a7c435825ad409ece6) (8cb9efc)
- **landing:** Point the help FAQ to the n8n community forum. [#700](https://github.com/n8n-io/nod/pull/700) (35447b5)
- **landing:** Use Legal's wording for where usage data goes. [#689](https://github.com/n8n-io/nod/pull/689) (dc6438e)
- **desktop:** Read the release redirect in Windows PowerShell 5.1. [commit](https://github.com/n8n-io/nod/commit/d2fb868bf6d6cdb402d3f1cc66c046d0fd00cf26) (d2fb868)
- **landing:** Name the ChatGPT plans that work in the models FAQ. [commit](https://github.com/n8n-io/nod/commit/daab586c261bca5bcd17b14e9783092a211bbd0f) (daab586)
- **landing:** Tone down claims, clarify the benchmarks and rebalance the Nod wordmark. [commit](https://github.com/n8n-io/nod/commit/8b03180df8051d32f8b59f315c51dc9df7170bf5) (8b03180)
- Export local files after approval validation. [commit](https://github.com/n8n-io/nod/commit/4aa1c5e3858de80f95b7ff8f465da5e93240023b) (4aa1c5e)
- Refuse Windows short names for local items Nod changes. [commit](https://github.com/n8n-io/nod/commit/2c23a2cc802ca3cff496a8181aa4c55e8c98288c) (2c23a2c)
- **docs:** Follow GitHub theme for README images. [#688](https://github.com/n8n-io/nod/pull/688) (2ff45ec)
- Address self-review on local files gating, moves, Trash and keep-out. [commit](https://github.com/n8n-io/nod/commit/2542ecb87d0e095aaa949e328de8cfb876029ac3) (2542ecb)
- Confirm the opened local file is the checked one and keep card errors readable. [commit](https://github.com/n8n-io/nod/commit/52149e11e0016d8abf5fe571a974d582d47a5f83) (52149e1)
- Address review on local files moves, limits, search and docs. [commit](https://github.com/n8n-io/nod/commit/0cf5190632345891f7546ce4cea43c331e9aabc9) (0cf5190)
- Check local paths as text first, trash old versions in place and fix workspace copies. [commit](https://github.com/n8n-io/nod/commit/570da84d6385888fa97454f3621991765477151b) (570da84)
- **web:** Keep the Local files card in the apps grid. [commit](https://github.com/n8n-io/nod/commit/e8627a7799c86895a84200bb902d0a55bb71b1e1) (e8627a7)
- Refuse program names, bind approved paths and keep imports to owner work. [commit](https://github.com/n8n-io/nod/commit/8d93bde9a8ce5bddd79647fe029e52f1222af228) (8d93bde)

### Documentation

- Add a community deployment guide for boxd. [#733](https://github.com/n8n-io/nod/pull/733) (90f6114)
- Count four local containers and note the dev port clash. [#734](https://github.com/n8n-io/nod/pull/734) (5c6db55)
- Point Settings paths at the current sections. [#696](https://github.com/n8n-io/nod/pull/696) (5751454)

<details>
<summary>Maintenance (1 changes)</summary>

- **apps:** Verify previewed sign-in in Windows Edge. [#732](https://github.com/n8n-io/nod/pull/732) (d82e06e)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.6.2...a9b054be54c26042f482a8037d04224adc6e1676)

<details>
<summary>Build details</summary>

Source: `a9b054be54c26042f482a8037d04224adc6e1676`
Previous release: `nod-v0.6.2`

</details>

## 0.6.2 - 2026-11-11

### Features

- **analytics:** Measure onboarding and first-week use. [#664](https://github.com/n8n-io/nod/pull/664) (b3c7db9)
- Capture consented Nod onboarding profiles in Customer.io. [#667](https://github.com/n8n-io/nod/pull/667) (776ddbe)
- **onboarding:** Separate unsubscribing from unlinking the email. [#680](https://github.com/n8n-io/nod/pull/680) (67f4090)
- **chat:** Hand the thinking line straight to the reply. [#675](https://github.com/n8n-io/nod/pull/675) (9e569d1)
- **desktop:** Use GitHub Releases for public upgrades. [commit](https://github.com/n8n-io/nod/commit/9ee0e17772a59cc339687cbc893caba99735d215) (9ee0e17)
- **privacy:** Apply Legal's compromise consent wording. [#670](https://github.com/n8n-io/nod/pull/670) (83141a3)
- **legal:** Link the Nod Terms of Use and save the exact consent wording. [#666](https://github.com/n8n-io/nod/pull/666) (f7e50c8)
- **landing:** Render text with antialiased font smoothing. [#669](https://github.com/n8n-io/nod/pull/669) (8b9fb85)
- **landing:** Make header labels plain text and let the unmute button fade. [#668](https://github.com/n8n-io/nod/pull/668) (e138f1c)

### Fixes

- **proactivity:** Keep app changes visible to screening. [#681](https://github.com/n8n-io/nod/pull/681) (f5c63e1)
- **landing:** Restore brand pink and simplify benchmark cards. [#684](https://github.com/n8n-io/nod/pull/684) (cece17f)
- **chat:** Preserve pasted text before Nod sees it (LAB-886). [#674](https://github.com/n8n-io/nod/pull/674) (ec9ee60)
- **schedules:** Describe stopped schedules as paused. [#673](https://github.com/n8n-io/nod/pull/673) (2baf9b8)
- Keep question choices visible after absorbed follow-ups (LAB-913). [#671](https://github.com/n8n-io/nod/pull/671) (fc33735)
- **landing:** Tidy the page on phones and match the social image to the tagline. [#672](https://github.com/n8n-io/nod/pull/672) (711b4b7)

### Performance

- Stream memory replies and cut reminder and calendar round trips. [#655](https://github.com/n8n-io/nod/pull/655) (d5e7ae2)

### Documentation

- Simplify the README into one story. [#685](https://github.com/n8n-io/nod/pull/685) (fe9faf8)
- Explain benchmark results and evaluation methods. [#683](https://github.com/n8n-io/nod/pull/683) (ffbc936)
- Turn the README into a launch page with every benchmark. [#678](https://github.com/n8n-io/nod/pull/678) (b6c5f17)
- Refresh README and scope checks to each change. [#677](https://github.com/n8n-io/nod/pull/677) (70c11ad)

<details>
<summary>Maintenance (1 changes)</summary>

- Allow the public PostHog token in posthog-host.json. [#679](https://github.com/n8n-io/nod/pull/679) (e91aea2)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.6.1...b3c7db9f23800e8a8e2cdbff8cb2fa76bd568ec7)

<details>
<summary>Build details</summary>

Source: `b3c7db9f23800e8a8e2cdbff8cb2fa76bd568ec7`
Previous release: `nod-v0.6.1`

</details>

## 0.6.1 - 2026-11-10

### Features

- **landing:** Load Google Tag Manager on nod.n8n.io. [#662](https://github.com/n8n-io/nod/pull/662) (ac9a1f3)
- **landing:** Match the social image to the new headline. [#663](https://github.com/n8n-io/nod/pull/663) (44d780f)
- **landing:** Put Nod in the headline and polish the page. [#661](https://github.com/n8n-io/nod/pull/661) (c1e3f0b)
- **landing:** Pick each visitor's installer and refresh the social image. [#660](https://github.com/n8n-io/nod/pull/660) (4ce2c1e)
- **landing:** Ship the new nod.n8n.io landing page. [#659](https://github.com/n8n-io/nod/pull/659) (0790b6a)
- **onboarding:** Put the usage data note in About you's opening message. [commit](https://github.com/n8n-io/nod/commit/5140548e4c8086d43d4a50c6fb47f068a6668e9b) (5140548)
- **privacy:** Apply Legal's in-app data texts for launch. [commit](https://github.com/n8n-io/nod/commit/ee4bdca74666edefdd8c6438398e42f0fc0ae147) (ee4bdca)
- **chat:** Make the live line clearer while Nod works. [commit](https://github.com/n8n-io/nod/commit/755189b90c45ee99b03d109a541f167085db8ba0) (755189b)

### Fixes

- Cap automatic selection latency. [#640](https://github.com/n8n-io/nod/pull/640) (0bf56a2)
- **feedback:** Reconcile uncertain submissions. [#643](https://github.com/n8n-io/nod/pull/643) (339e908)
- Clarify model quota and rate limit failures. [#641](https://github.com/n8n-io/nod/pull/641) (3d6aa64)
- Preserve null diagnostic report fields. [#652](https://github.com/n8n-io/nod/pull/652) (807be28)
- **runtime:** Deliver long research results as Markdown files. [#645](https://github.com/n8n-io/nod/pull/645) (a482e99)
- Retire stale schedule confirmations (LAB-795). [#647](https://github.com/n8n-io/nod/pull/647) (ca4c240)
- **apps:** Route Notion MCP to its official connection. [#644](https://github.com/n8n-io/nod/pull/644) (3e9b25e)
- **browser:** Copy selected text from handoff (LAB-855). [#649](https://github.com/n8n-io/nod/pull/649) (4322530)
- **pi:** Recover incomplete assistant blocks. [#646](https://github.com/n8n-io/nod/pull/646) (a6235a2)
- Point task rules to Chat. [#648](https://github.com/n8n-io/nod/pull/648) (ccc23eb)
- **chat:** Address review on the live line and task dots. [commit](https://github.com/n8n-io/nod/commit/229a62451216e7213808ae984d37856d9fbdda05) (229a624)

### Performance

- Cut background model spend and show it in Usage. [#656](https://github.com/n8n-io/nod/pull/656) (f9808ea)
- **integrations:** Narrow connected app discovery. [#651](https://github.com/n8n-io/nod/pull/651) (828a73e)

### Documentation

- Show the OpenSSF Best Practices badge. [#658](https://github.com/n8n-io/nod/pull/658) (26eb290)
- Point every link at nod.n8n.io. [#653](https://github.com/n8n-io/nod/pull/653) (9f3de9f)

<details>
<summary>Maintenance (1 changes)</summary>

- Add OpenSSF Best Practices answers. [#657](https://github.com/n8n-io/nod/pull/657) (18851d6)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.6.0...f9808ea0a6276a7f84157bf78ad22bb62d9de621)

<details>
<summary>Build details</summary>

Source: `f9808ea0a6276a7f84157bf78ad22bb62d9de621`
Previous release: `nod-v0.6.0`

</details>

## 0.6.0 - 2026-11-09

### Features

- **onboarding:** Add About you and Join us steps. [#596](https://github.com/n8n-io/nod/pull/596) (94fee2e)
- Show that Nod is working at every moment. [#630](https://github.com/n8n-io/nod/pull/630) (78fa31c)
- **onboarding:** Explain how Nod uses your data. [#629](https://github.com/n8n-io/nod/pull/629) (7fcb5de)

### Fixes

- Require owner-stated names in replies. [#634](https://github.com/n8n-io/nod/pull/634) (1da121a)
- **desktop:** Keep Nod on screen through an update and reopen it as it was. [#637](https://github.com/n8n-io/nod/pull/637) (d4ab29c)
- **pi:** Distinguish full-context cutoffs. [commit](https://github.com/n8n-io/nod/commit/3d053c4ceeb587f9d1085af309cb1b710ce30b4e) (3d053c4)
- **browser:** Make task browser handoffs easy to find. [#632](https://github.com/n8n-io/nod/pull/632) (ba940dc)
- Answer before compacting and say what questions are for. [#631](https://github.com/n8n-io/nod/pull/631) (3642fe2)
- **ci:** Verify Mac fixtures with pinned Electron checksums. [commit](https://github.com/n8n-io/nod/commit/cca91048e8bc36cfd8ecfb32fddf1b2508b3ff14) (cca9104)
- **deps:** Adapt schema and speech APIs for dependency updates. [commit](https://github.com/n8n-io/nod/commit/36ea031e36de78428120d1c6d914cae9550e5267) (36ea031)
- **runtime:** Keep browser and tool state consistent. [commit](https://github.com/n8n-io/nod/commit/3fae2e06ad5b0565677983de13f645db28bfebdf) (3fae2e0)

### Documentation

- Lead the privacy page with an example of what Nod shares. [#633](https://github.com/n8n-io/nod/pull/633) (eaf8590)

<details>
<summary>Maintenance (12 changes)</summary>

- **pi:** Reproduce full-context continue loop. [commit](https://github.com/n8n-io/nod/commit/d232ac36dd4053e756c45c30ef4e5c56c4934aa4) (d232ac3)
- **deps:** Bump typebox from 1.3.27 to 1.4.4. [commit](https://github.com/n8n-io/nod/commit/29241c5e25010a3e2a0ca737885728d2236be50b) (29241c5)
- **deps:** Bump @fastify/multipart from 10.1.4 to 10.1.7. [commit](https://github.com/n8n-io/nod/commit/9360edbd92a449cec2c652b0ca86cf8f6d8aa1eb) (9360edb)
- **deps-dev:** Bump the tailwindcss group across 1 directory with 2 updates. [commit](https://github.com/n8n-io/nod/commit/8ccd8827a0201c60a4d8f85a0e5b266abbc528ec) (8ccd882)
- **deps:** Bump the chat-sdk group across 1 directory with 4 updates. [commit](https://github.com/n8n-io/nod/commit/5e742f16e8939a6057f91b13a83cde2b92949df4) (5e742f1)
- **deps-dev:** Bump the tiptap group across 1 directory with 9 updates. [commit](https://github.com/n8n-io/nod/commit/235fa186e2ddec340bb8f611fb503a5e8d551547) (235fa18)
- **deps:** Bump the pi group across 1 directory with 2 updates. [commit](https://github.com/n8n-io/nod/commit/d89e4aa8e344cc1824971c44a26f190550f7fa2b) (d89e4aa)
- **deps:** Bump the actions group with 4 updates. [commit](https://github.com/n8n-io/nod/commit/3082d09819a8c6e24b12c9540b0f20fcad2acd2d) (3082d09)
- **deps-dev:** Bump @napi-rs/canvas from 1.0.10 to 1.1.0. [commit](https://github.com/n8n-io/nod/commit/d76a65b0c57969a0373e89148d5f65c83365668f) (d76a65b)
- **deps:** Bump @audio/decode-webm from 1.4.1 to 1.6.1. [commit](https://github.com/n8n-io/nod/commit/0042c4304695850d16c8766e7443447eda197ef8) (0042c43)
- **deps:** Bump @huggingface/transformers from 3.8.1 to 4.3.2. [commit](https://github.com/n8n-io/nod/commit/62c850ae60e8508055c062ac0b3246ba68eccc78) (62c850a)
- **deps:** Bump jose from 6.2.13 to 6.2.14. [commit](https://github.com/n8n-io/nod/commit/7cd90439e83f12245115077d7ff61c07512919c7) (7cd9043)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.5.2...94fee2e6a7dfdf6b278f1573f382a09eb5ac2e24)

<details>
<summary>Build details</summary>

Source: `94fee2e6a7dfdf6b278f1573f382a09eb5ac2e24`
Previous release: `nod-v0.5.2`

</details>

## 0.5.2 - 2026-11-08

### Features

- **desktop:** Show runtime download progress and resume interrupted downloads. [#602](https://github.com/n8n-io/nod/pull/602) (9b4ed70)
- **trust:** Add a decision safety gate with Jev. [commit](https://github.com/n8n-io/nod/commit/bf04eb70fcf06e44934262040f2803d2305af010) (bf04eb7)

### Fixes

- **apps:** Show reconnect for connected accounts. [#618](https://github.com/n8n-io/nod/pull/618) (80df5d9)
- **desktop:** Stop the VM before updating the runtime mount. [#617](https://github.com/n8n-io/nod/pull/617) (b5bdf35)
- **chat:** Show activity before the first model step. [#616](https://github.com/n8n-io/nod/pull/616) (3b96b32)
- **apps:** Bind sign-in restarts to their callback attempt. [#615](https://github.com/n8n-io/nod/pull/615) (04361eb)
- **integrations:** Keep request limits through response bodies. [#614](https://github.com/n8n-io/nod/pull/614) (cbe0522)
- **models:** Use the target model output limit. [#613](https://github.com/n8n-io/nod/pull/613) (0091bc8)
- **desktop:** Retry complete Mac runtime downloads offline. [#612](https://github.com/n8n-io/nod/pull/612) (901c6c3)
- **runtime:** Stop turns with blocked file publication. [#611](https://github.com/n8n-io/nod/pull/611) (ec8423c)
- **channels:** Hide an accepted WhatsApp QR code. [#610](https://github.com/n8n-io/nod/pull/610) (acc4fb1)
- **desktop:** Keep verified runtime files through failed downloads. [commit](https://github.com/n8n-io/nod/commit/b9c42b9abadb645808a26673786dd06cb6302bd4) (b9c42b9)
- **desktop:** Keep runtime download failure causes. [commit](https://github.com/n8n-io/nod/commit/f435ddd638aba5493507a199551e971e1781dd37) (f435ddd)
- **web:** Block HTML preview navigation before network access. [#607](https://github.com/n8n-io/nod/pull/607) (da1601d)
- **desktop:** Prevent PostgreSQL hangs after VM kernel updates. [commit](https://github.com/n8n-io/nod/commit/6e165e7d05f47c31b0e93b6dcd9dd7b6e9060210) (6e165e7)
- **trust:** Check actions with the selected model by default again. [#605](https://github.com/n8n-io/nod/pull/605) (525680c)
- Task completion and handoff, memory replies, settings links and eval grading. [#599](https://github.com/n8n-io/nod/pull/599) (c9ce11f)
- **web:** Always open chat after onboarding. [#600](https://github.com/n8n-io/nod/pull/600) (0a30c48)

### Documentation

- **desktop:** Say interrupted downloads resume in the tester help table. [#603](https://github.com/n8n-io/nod/pull/603) (8a3170a)

<details>
<summary>Maintenance (1 changes)</summary>

- Authenticate verified build downloads. [#620](https://github.com/n8n-io/nod/pull/620) (c66ca9f)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.5.0...c66ca9f2e5a0f31fb2b8bac3f0c2b57647d19b59)

<details>
<summary>Build details</summary>

Source: `c66ca9f2e5a0f31fb2b8bac3f0c2b57647d19b59`
Previous release: `nod-v0.5.0`

</details>

## 0.5.1 - 2026-11-04

### Features

- **desktop:** Show runtime download progress and resume interrupted downloads. [#602](https://github.com/n8n-io/nod/pull/602) (9b4ed70)
- **trust:** Add a decision safety gate with Jev. [commit](https://github.com/n8n-io/nod/commit/bf04eb70fcf06e44934262040f2803d2305af010) (bf04eb7)

### Fixes

- **trust:** Check actions with the selected model by default again. [#605](https://github.com/n8n-io/nod/pull/605) (525680c)
- Task completion and handoff, memory replies, settings links and eval grading. [#599](https://github.com/n8n-io/nod/pull/599) (c9ce11f)
- **web:** Always open chat after onboarding. [#600](https://github.com/n8n-io/nod/pull/600) (0a30c48)

### Documentation

- **desktop:** Say interrupted downloads resume in the tester help table. [#603](https://github.com/n8n-io/nod/pull/603) (8a3170a)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.5.0...525680cb9d925f19ba07f07165b152314437e28e)

<details>
<summary>Build details</summary>

Source: `525680cb9d925f19ba07f07165b152314437e28e`
Previous release: `nod-v0.5.0`

</details>

## 0.5.0 - 2026-11-02

### Features

- **analytics:** Show a Nod-styled NPS survey after 3 days of use. [#597](https://github.com/n8n-io/nod/pull/597) (0fd30e8)
- **analytics:** Measure activation, retention and pre-mortem signals. [#577](https://github.com/n8n-io/nod/pull/577) (a569791)
- **ui:** Unify chat, native answers, and Settings. [#578](https://github.com/n8n-io/nod/pull/578) (05fb1c9)

### Fixes

- **onboarding:** Keep setup usable while services start. [#595](https://github.com/n8n-io/nod/pull/595) (c783116)
- **desktop:** Quit a running Nod before reinstalling on Windows. [#594](https://github.com/n8n-io/nod/pull/594) (0ab4fdd)
- **schedules:** Stop recurring runs from asking the same question again. [#593](https://github.com/n8n-io/nod/pull/593) (d5df72e)
- **usage:** Explain costs for every kind of model pricing. [#592](https://github.com/n8n-io/nod/pull/592) (6971c7c)
- **security:** Prepare Nod for public source access. [#581](https://github.com/n8n-io/nod/pull/581) (b2dcc73)
- **security:** Close nine audited boundary gaps and start tasks for substantial work. [#579](https://github.com/n8n-io/nod/pull/579) (b8e836b)
- **apps:** Use the server origin for hosted sign-in. [#576](https://github.com/n8n-io/nod/pull/576) (e6090e0)

### Performance

- Cut agent round trips and show live status sooner. [#580](https://github.com/n8n-io/nod/pull/580) (8fb9319)

<details>
<summary>Maintenance (4 changes)</summary>

- **deps-dev:** Bump vite from 8.3.4 to 8.3.5. [#587](https://github.com/n8n-io/nod/pull/587) (0316c5a)
- **deps:** Bump posthog-node from 5.57.0 to 5.60.1. [#586](https://github.com/n8n-io/nod/pull/586) (662c0d2)
- **deps:** Bump the docs group across 1 directory with 5 updates. [#584](https://github.com/n8n-io/nod/pull/584) (96125c7)
- **deps-dev:** Bump the tiptap group across 1 directory with 9 updates. [#582](https://github.com/n8n-io/nod/pull/582) (1509caf)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.4.2...0fd30e8ab0fd565e8f462d21dc48a24c58694a13)

<details>
<summary>Build details</summary>

Source: `0fd30e8ab0fd565e8f462d21dc48a24c58694a13`
Previous release: `nod-v0.4.2`

</details>

## 0.4.2 - 2026-10-30

### Features

- **memory:** Select source facts and check personal answers. [#574](https://github.com/n8n-io/nod/pull/574) (84a0c1b)
- **web:** Use n8n icons for navigation, search, mic and import. [commit](https://github.com/n8n-io/nod/commit/81443dab048e26a223ad0dc7536016e366aa2c81) (81443da)
- **onboarding:** Redesign onboarding. [#562](https://github.com/n8n-io/nod/pull/562) (65aad82)
- **docs:** Add the Nod landing page with a platform-aware download button. [#396](https://github.com/n8n-io/nod/pull/396) (8774a82)

### Fixes

- **runtime:** Preserve task facts, local times and action terms. [#565](https://github.com/n8n-io/nod/pull/565) (5c8e50e)
- **traces:** Drop memory lookup arguments and clarify trace scope. [#564](https://github.com/n8n-io/nod/pull/564) (bf91d4b)
- **traces:** Hash IDs in trace content and keep memory out of traces. [#563](https://github.com/n8n-io/nod/pull/563) (8c15f31)
- **harness:** Stop observer check-in loops and accept refs for sign-in methods. [#561](https://github.com/n8n-io/nod/pull/561) (763afb4)
- **desktop:** Keep staged updates current and allow manual checks. [#560](https://github.com/n8n-io/nod/pull/560) (c93abb9)

### Documentation

- **readme:** Point the Discord badge at the public invite. [#573](https://github.com/n8n-io/nod/pull/573) (6c947ba)
- **readme:** Add Discord and forum badges. [#571](https://github.com/n8n-io/nod/pull/571) (83b24a8)
- **n8n:** The release broker serves only nod-v\* releases. [#570](https://github.com/n8n-io/nod/pull/570) (16e1453)

<details>
<summary>Maintenance (3 changes)</summary>

- Prune dead code, retired features and pre-Nod compatibility code. [#569](https://github.com/n8n-io/nod/pull/569) (2833ef6)
- **desktop:** Drop the last Windows preview names. [#568](https://github.com/n8n-io/nod/pull/568) (2ba8c34)
- **docs:** Deploy the landing page and docs to nod.n8n.io from main. [#566](https://github.com/n8n-io/nod/pull/566) (504d5fb)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.4.1...84a0c1b209c4627c98bbc51682259e2ea39c476c)

<details>
<summary>Build details</summary>

Source: `84a0c1b209c4627c98bbc51682259e2ea39c476c`
Previous release: `nod-v0.4.1`

</details>

## 0.4.1 - 2026-10-29

### Features

- **models:** Show OpenRouter prices in the model picker. [commit](https://github.com/n8n-io/nod/commit/24147ee4b5f4bfe146ceba26b8eb0f7d351131b0) (24147ee)

### Fixes

- **desktop:** Preserve Mac keys and recover failed updates. [#557](https://github.com/n8n-io/nod/pull/557) (fa98cc8)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.4.0...fa98cc8fb619e02c83fb194ac968542db54d5f2b)

<details>
<summary>Build details</summary>

Source: `fa98cc8fb619e02c83fb194ac968542db54d5f2b`
Previous release: `nod-v0.4.0`

</details>

## 0.4.0 - 2026-10-29

### Fixes

- **harness:** Keep background work relevant and record model costs. [commit](https://github.com/n8n-io/nod/commit/edf2ab9d956a2e776c69f0f6cb2fe3cad8f868d5) (edf2ab9)
- Open Chat after app sign-in and retain onboarding deep links. [#540](https://github.com/n8n-io/nod/pull/540) (b722edb)
- Show full chat activity titles and steps. [#543](https://github.com/n8n-io/nod/pull/543) (a7a3ba8)
- Keep desktop error banners below the toolbar. [#547](https://github.com/n8n-io/nod/pull/547) (7c56926)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.3.9...edf2ab9d956a2e776c69f0f6cb2fe3cad8f868d5)

<details>
<summary>Build details</summary>

Source: `edf2ab9d956a2e776c69f0f6cb2fe3cad8f868d5`
Previous release: `nod-v0.3.9`

</details>

## 0.3.5 - 2026-10-27

### Fixes

- **ui:** Improve chat status, spacing and onboarding. [commit](https://github.com/n8n-io/nod/commit/b7a36629e131017c42d27718251a70ac049c3978) (b7a3662)
- **channels:** Soften the WhatsApp account risk note. [#520](https://github.com/n8n-io/nod/pull/520) (43d5694)
- **desktop:** Keep unread replies visible in the macOS Dock. [#519](https://github.com/n8n-io/nod/pull/519) (91e5c46)
- **models:** Validate API key providers and show inline feedback. [#517](https://github.com/n8n-io/nod/pull/517) (5c28532)
- **agent:** Clarify consent and keep Telegram conversations responsive. [#493](https://github.com/n8n-io/nod/pull/493) (d98342d)
- **desktop:** Make the app icon distinct and visible in dark style. [#518](https://github.com/n8n-io/nod/pull/518) (901dc72)
- **desktop:** Keep PowerShell's module cache path in Windows commands. [#515](https://github.com/n8n-io/nod/pull/515) (0012d46)

<details>
<summary>Maintenance (1 changes)</summary>

- **apps:** Prevent regressions in GitHub sign-in completion. [#516](https://github.com/n8n-io/nod/pull/516) (cc2c3eb)

</details>

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.3.4...b7a36629e131017c42d27718251a70ac049c3978)

<details>
<summary>Build details</summary>

Source: `b7a36629e131017c42d27718251a70ac049c3978`
Previous release: `nod-v0.3.4`

</details>

## 0.3.4 - 2026-10-27

### Fixes

- **maps:** Show a marked map link for every suggested location. [#511](https://github.com/n8n-io/nod/pull/511) (60bb66c)
- **apps:** Accept any browser's sign-in key and keep validation errors in diagnostics. [#512](https://github.com/n8n-io/nod/pull/512) (6fa9fdd)
- **proactivity:** Make progress useful and saved results inspectable. [#510](https://github.com/n8n-io/nod/pull/510) (97215a2)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.3.3...60bb66cd6fc9ff84a384c4878bfa1b468f7941db)

<details>
<summary>Build details</summary>

Source: `60bb66cd6fc9ff84a384c4878bfa1b468f7941db`
Previous release: `nod-v0.3.3`

</details>

## 0.3.3 - 2026-10-27

### Fixes

- **desktop:** Rebuild the runtime less often and show update progress. [#508](https://github.com/n8n-io/nod/pull/508) (54ee04e)
- **proactivity:** Keep quiet hours quiet for work Nod starts. [#507](https://github.com/n8n-io/nod/pull/507) (8e147f5)
- **evals:** Attribute background messages and tools by observer work. [#504](https://github.com/n8n-io/nod/pull/504) (5e6e7d6)
- **apps:** Word connection links as an invitation to sign in. [#502](https://github.com/n8n-io/nod/pull/502) (37d7d62)
- **proactivity:** Act on a yes to a nudge in chat even when its task waits. [#505](https://github.com/n8n-io/nod/pull/505) (b31069b)
- **vault:** Use the saved login's password method instead of asking. [#503](https://github.com/n8n-io/nod/pull/503) (a63f097)
- **vault:** Scroll the submit control into view before private entry clicks. [#501](https://github.com/n8n-io/nod/pull/501) (faffa63)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.3.2...54ee04e7790367004ef6c24b4a64d668057b7c26)

<details>
<summary>Build details</summary>

Source: `54ee04e7790367004ef6c24b4a64d668057b7c26`
Previous release: `nod-v0.3.2`

</details>

## 0.3.2 - 2026-10-26

### Features

- **audio:** Add voice messages and customizable spoken replies. [#465](https://github.com/n8n-io/nod/pull/465) (b538af4)

### Fixes

- **channels:** Format Telegram and WhatsApp replies readably. [#495](https://github.com/n8n-io/nod/pull/495) (49a1211)
- **proactivity:** Use one persistent observer. [#499](https://github.com/n8n-io/nod/pull/499) (db6b9e2)
- **apps:** End abandoned app sign-ins and retry malformed message drafts. [#497](https://github.com/n8n-io/nod/pull/497) (168a042)
- **desktop:** Show original Windows startup errors. [#498](https://github.com/n8n-io/nod/pull/498) (7fc8955)
- **feedback:** Remember diagnostics and restore screenshots. [#496](https://github.com/n8n-io/nod/pull/496) (4aed2b5)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.3.1...49a1211cbf42f9718407be1664739d8e44030077)

<details>
<summary>Build details</summary>

Source: `49a1211cbf42f9718407be1664739d8e44030077`
Previous release: `nod-v0.3.1`

</details>

## 0.3.1 - 2026-10-26

### Fixes

- **runtime:** Fit small models and OpenRouter routers. [#491](https://github.com/n8n-io/nod/pull/491) (1a46880)
- **desktop:** Explain data removal and return to setup. [#492](https://github.com/n8n-io/nod/pull/492) (93620dd)
- **apps:** Make account recovery prompts actionable. [#489](https://github.com/n8n-io/nod/pull/489) (060a60e)
- **files:** Attach workspace file references in replies. [#490](https://github.com/n8n-io/nod/pull/490) (8bf542f)

[Full changelog](https://github.com/n8n-io/nod/compare/nod-v0.3.0...1a468808b34a820db256c4c3736ee7171e8362f7)

<details>
<summary>Build details</summary>

Source: `1a468808b34a820db256c4c3736ee7171e8362f7`
Previous release: `nod-v0.3.0`

</details>

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
