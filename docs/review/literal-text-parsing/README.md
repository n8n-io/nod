# Text, links and conversation review

Chat and feedback now use one CommonMark parser and serializer. A pasted or typed URL keeps its destination after send and draft recovery.

## What failed

The Tiptap Markdown serializer escaped punctuation inside plain URLs. Its parser and the message renderer did not read those escapes in the same way. Code fences could also close too early when the code contained backticks.

A separate defect affected IPv6 links. Markdown-to-HTML conversion encoded the host brackets. The URL guard then refused the changed host. Bare IPv6 URLs could also lose underscores during paste, because GFM did not recognize the whole URL.

## What changed

- Chat and feedback use `remark-parse`, `remark-gfm` and `remark-stringify` for Markdown. The adapter maps the editor's document tree to the Markdown tree.
- `linkify-it` finds bare URLs. Before paste parsing, URL spans outside code, HTML and existing links use CommonMark autolink syntax. A complete URL stays complete.
- Chat and Markdown file previews pass the parsed link destination through the documented `hProperties` field. The sanitizer and URL guard still check it.
- Failed sends restore the same document meaning. Reference links, formatting, lists, tasks, tables, code and underline use the same conversion.
- Replies and confirmation text share a friendly writing rule. Paragraphs have blank lines. Message breaks follow the task and conversation. There is no fixed message count or special schedule format.
- The activity view stays available. A useful, verified partial result gets a normal chat message with what is complete and what remains. Routine steps do not each need a new status or message.
- Chat paragraphs have a 12-pixel gap.

Markdown source can contain valid escapes. The contract is unchanged text, formatting and link meaning after parsing. The server does not decode Markdown again.

## Scan scope

| Area                                       | Result                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Chat and feedback editors                  | Both used the same affected extension. Both now use the shared adapter.                     |
| Send failure and draft restore             | Both use the shared parser. Browser checks cover restore and a second send.                 |
| Backend message route, storage and runtime | An integration check confirms that the same text reaches all three.                         |
| Chat links and setup actions               | Link destinations stay intact. Existing path and scheme guards still apply.                 |
| Markdown file previews                     | Use the same destination handling as chat. External images remain disabled.                 |
| Task labels and conversation previews      | Render text only. They do not open source links.                                            |
| Artifact URLs and active file previews     | Existing owner checks and sandbox rules remain in place. Their regression tests pass.       |
| Telegram and WhatsApp delivery             | No editor serializer is used there. Existing channel delivery checks cover those contracts. |

## Checks

The full integration suite passes all 623 tests, with no skips. Type checks, formatting, the app build and the docs build pass. The docs build checks all 54 pages and their internal links.

The focused URL suite passes all 18 tests. It includes 150 generated strings with punctuation and Unicode. It checks repeated recovery, query strings, IPv6, artifact paths, reference links, code fences and safe rendering.

Browser checks use the real `Composer`, `FeedbackEditor` and `MessageText` components in [the fixture](fixture.tsx). Its API replies and confirmation copy are synthetic. It makes no model request and uses no connected account.

The browser checks cover plain and rich paste, a failed send, recovery, a second send, Shift+Enter, the feedback limit and link targets. They also check paragraph gaps and no horizontal overflow at 1080 pixels in light mode and 390 pixels in dark mode.

- [Light layout](light.png)
- [Narrow dark layout](dark-narrow.png)

The screenshots show frontend layout. The sample confirmation is example text, not output from a live model. Prompt quality still needs a manual model review.

## Demo

[Watch the 29-second cadence and parsing demo](cadence-demo.mp4). A copy is on the Desktop as `nod-cadence-and-parsing-demo.mp4`.

This recording uses the real Chat page, its activity indicator and the Markdown file preview. It shows an opening message, a useful partial result while activity continues, and a finished plan. A routine check changes activity without adding a message. The URL and literal code stay intact in chat and in the file preview.

Assistant replies and API responses are scripted. The recording illustrates the intended cadence. It does not measure live model behavior or perceived speed. The short scene timings do not set a production message interval.

Product components came from `976963f1`. The [capture fixture](cadence.tsx) is included with the video. Its hash and export checks are in [the manifest](checks.json).

The [earlier 25-second parsing demo](demo.mp4) also shows failed-send recovery and rich feedback paste. It was recorded after [PR #445](https://github.com/n8n-io/nod/pull/445) opened, from source commit `b3d6377f`.

## Design sources

[remark-stringify](https://github.com/remarkjs/remark/tree/main/packages/remark-stringify) owns Markdown escaping and code fences. [mdast-util-to-hast](https://github.com/syntax-tree/mdast-util-to-hast#fields-on-nodes) documents the destination override. [linkify-it](https://github.com/markdown-it/linkify-it) owns bare URL recognition.

[Hermes](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/src/components/assistant-ui/markdown-text.tsx) uses a Markdown renderer with plugins. [OpenCode](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/prompt/codec.ts) uses structured prompt parts. These are useful examples of using libraries and document structure. They do not use this same editor adapter.

[Microsoft's writing guidance](https://learn.microsoft.com/en-us/windows/apps/design/style/writing-style) supports clear, useful and friendly text. [COLING 2025 research](https://aclanthology.org/2025.coling-main.410/) supports adapting dialog style to the user and task.

[Research on notification timing](https://interruptions.net/literature/Iqbal-CHI08.pdf) supports breaks in a task as useful times to interrupt. [A field study on grouped notifications](https://doi.org/10.1016/j.chb.2019.07.016) supports limiting interruptions. These findings guide message breaks. They do not establish an ideal number of messages for a chat reply.

[Research on conversational style and trust](https://arxiv.org/abs/2502.10844) supports care with praise and changes of stance. The writing rule asks for practical help and honest disagreement.

### Progress and perceived waiting

A [2021 study with 360 participants](https://doi.org/10.1145/3472307.3484181) found that contextual conversational feedback improved ratings of response time. It did not improve agent likeability. [CUI 2025 research](https://arxiv.org/abs/2507.22352) found that natural cues improved perceived response time during longer waits. That study used voice and VR, so it does not directly test nod's chat.

[Sidekick](https://arxiv.org/abs/2607.17527) studied 30 users of computer use agents. It found benefits from combining quiet background cues with summaries of completed actions. Its combined design performed better than text feedback in chat or an ambient display. This supports keeping activity visible while choosing useful moments to deliver results.

The evidence does not show that all activity indicators make an agent feel slower. [A CHI 2026 study](https://arxiv.org/abs/2602.04138) found that hiding time feedback made waits feel longer and less clear. [Operational transparency research](https://www.hbs.edu/faculty/Pages/item.aspx?num=40158) also found that visible work could increase perceived value. That is a different measure from perceived speed.

nod's design choice is to deliver meaningful, verified partial results in chat while keeping routine activity available. Each result states what is complete and what remains. These studies do not prove that this message design improves nod's perceived speed, and they do not measure a dopamine effect. That needs a user study.

## Prompt consistency review

The writing style and delivery rules now have separate scopes. The runtime receives both. The confirmation and notice writer receives only the writing style, because it returns one text value for one purpose.

| Surface                          | Result                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared writing style             | One source for voice, paragraph breaks and readable detail. It contains no instruction to send another message.                                              |
| Runtime personality and prompt   | One cadence rule for useful milestones. The runtime prompt explains how to send them. The fixed word target and forced status before every step are removed. |
| Message tool                     | Delivers a verified partial result, important change or needed decision. Routine narration stays in activity.                                                |
| Unsolicited updates              | The rule to reduce unanswered updates applies only to work nod starts on its own. It does not suppress requested results.                                    |
| Confirmation and channel notices | Keep their one-message JSON contract. The action review still checks the frozen facts.                                                                       |
| Background schedules and events  | Keep routine progress private. Their standing instruction controls delivery.                                                                                 |
| Setup interview                  | Keeps its own short welcome and question flow, its one-question rule and its bounded message array. It does not receive the long-task cadence rule.          |
| Task and file skills             | Their final-delivery rules do not forbid useful milestones during the work. Writing on the user's behalf follows the recipient's style.                      |
| Runtime docs                     | The Message cadence section now includes milestones and removes the requirement for a status before every step.                                              |

Cubic also flagged the old `++text++` underline paste shortcut. Its removal is intentional under CommonMark. The old editor already saved underline as `<u>text</u>`. That form and the formatting toolbar still work. The chat guide now states this behavior.

## Saved task visibility

The task API has no minimum duration or severity gate. Starting a task saves its record and start message in one transaction. State reads include completed tasks, and chat uses the saved message ID to show the task card.

The old coordinator prompt told the model to keep work in chat even when it took several steps or minutes. Its tool description also limited saved tasks to work that outlived the reply. Both now use one `taskRouting` value. Substantial multi-step work gets a saved task even when it can finish in one sitting. Quick answers, single lookups, brief summaries of supplied content and simple actions stay in chat. One coherent job stays in one task.

The start message provides the task's acknowledgement. The coordinator does not send a second opening or execute the same work again. This review establishes the former routing rule; it does not include the affected user's conversation from that day.

## Validation note

One full rerun failed during concurrent private-storage initialization. The storage adapter and lock code are unchanged by this PR. The same existing test passed 12 focused runs against a disposable PostgreSQL instance. After the task changes and the merge from main, the final full run passed all 623 tests, with no failures or skips.
