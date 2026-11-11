# Desktop changelog

Releases from before the rename to Nod are the `desktop-v*` [GitHub releases](https://github.com/n8n-io/nod/releases).

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
