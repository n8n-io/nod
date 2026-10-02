# Voice eval

Checks how Otto answers through the real runtime and Pi model, with invented profile, memory, app and search fixtures. This is a manual model evaluation, separate from deterministic tests. The project prohibits live models in tests; get an explicit exception for the bounded manual evaluation before running it. No case uses the normal database or connected accounts.

The default `voice` set checks brevity, progress and quiet background behavior. `tasks` contains the existing task cases. `answers` checks useful answers without internal process receipts; it requires `--live`. `all` includes all three sets.

```sh
npm run eval:voice -- --label v3 --repeat 2 --compare baseline,v2
npm run eval:voice -- --only inbox-triage,research --label quick
npm run eval:voice -- --report-only --compare baseline,v2
```

Runs are saved to `.local/voice-evals/<label>.json`; labels cannot overwrite earlier attempts. Each completed attempt is saved immediately. `report.html` puts the labels side by side with timestamps, tool calls, source results and checks. Records include the commit, model, prompt and fixture SHA-256 hashes, usage and measured cost or `null` when unavailable.

The checks are cheap tripwires, not the verdict: acknowledgement before the first tool call, final result after the last one, message length, boilerplate phrases, headings and em dashes, and staying quiet after unanswered nudges. Read the transcripts first, note what sounds off, and only turn failures that keep recurring into new checks or scenarios.

The voice lives in `src/runtime/personality.ts`; operating rules stay in `src/runtime/prompt.ts`.

## Frozen answer cases

The eight v1 cases live in `scripts/voice-scenarios.ts`. Their prompts, invented data, automatic checks and human review criteria are printed together by the dry-run. The answer key and checks are never passed to the model. Freeze the dry-run output before the first run; a change to a prompt, fixture or scoring rule needs a new case version and must keep the previous result.

| Case                 | Exact question                                                                                | Required outcome                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `answer-profile`     | What do you know about me?                                                                    | Maya, Prague and product-design work at Beacon Studio; no profile/search receipt.                                  |
| `answer-preferences` | What preferences have I asked you to remember?                                                | Concise replies, EUR, metric units, meetings after 10:00 and free Friday afternoons.                               |
| `answer-schedules`   | Which reminders are active, and when do they run?                                             | Active weekday standup at 09:15 Europe/Prague; invoice review stays paused.                                        |
| `answer-inbox`       | What in my inbox needs a decision from me?                                                    | Atlas proof approval and its deadline, with the supporting message link.                                           |
| `answer-calendar`    | What is my first meeting on 5 October 2026, and what should I bring?                          | Atlas review at 10:30 Europe/Prague, blue-cover mockup and event link.                                             |
| `answer-unavailable` | Has Leah replied to my Atlas proof email?                                                     | Mailbox unavailable; the reply remains unknown. A failed read cannot prove an empty inbox.                         |
| `answer-audit`       | How do you know my meeting preferences? Tell me which saved sources you checked and how many. | Explain the saved sources and requested count accurately against the trace.                                        |
| `answer-profile-pt`  | O que sabes sobre mim e sobre onde trabalho?                                                  | Held-out Portuguese reply about Inês in Coimbra, working at Maré Studio; a possible move to Porto stays tentative. |

Shared automatic checks require a reply, bounded length, relevant fixture reads, no unnecessary question and no non-fixture action. Result checks cover seeded facts, supported links and common unsupported claims. Ordinary answers must not contain unsolicited operational read counts or tool/access narration. The explicit audit case permits those details because the user asked for them. Counts that answer the actual task, dates, times and money remain useful result data.

These checks are tripwires. Human review must confirm that the answer resolves the question, each cited source supports its claim, limitations are material and truthful, and the audit counts match the actual reads. A case passes only when every applicable automatic and human check passes in the same attempt. Errors and pending review are not passes. The report distinguishes automatic pass-at-least-once from pass-every-attempt; it does not turn those into final semantic verdicts.

The answer set uses a fresh Pi session per attempt and synthetic runtime boundary handlers for profile, memory, schedule, inbox and calendar reads. Fixture results are fixed snapshots, so this measures answer behavior rather than search quality or live integration reliability. The tool allowlist permits only those fixture handlers, messaging and Pi's local codemode sandbox. All other tools, including native commands, browser and web extension tools such as `source_check`, are rejected before execution. Fixture write and connection requests are rejected and recorded as violations. The only intended external request is the explicitly authorized model API call. No normal database, user workspace, browser profile or account is read or changed.

## Review and run

Dry-run does not read `.env`, create a Pi agent, initialize a session or call a model:

```sh
npm run eval:voice -- --set answers --dry-run
```

For the receipt regression, freeze two attempts per case: two baseline reproduction cases plus all eight final cases, for 20 total turns. Each answer turn has a 90-second deadline and a 12-tool-call limit. Answer cases run sequentially, without automatic whole-scenario replay. Pi's existing provider transport retries remain enabled within the turn deadline. Incomplete reports show missing planned attempts and unrun cases; a partial run cannot pass every planned attempt. The absolute calendar date avoids a changing definition of “tomorrow”; runtime timestamps are still recorded at execution time.

After explicit authorization for that manual model evaluation, keep the configured model fixed at `openai/gpt-6.1-sol` with Pi's `high` reasoning setting. Use the saved pre-change system prompt for the baseline; `--system-prompt` replaces only `Agent.open`'s system prompt, leaving fixtures, runtime boundaries and scoring unchanged:

```sh
LLM_PROVIDER=openai LLM_MODEL=gpt-6.1-sol npm run eval:voice -- \
  --set answers --only answer-profile,answer-preferences --repeat 2 \
  --system-prompt .local/evals/answer-quality-2026-10-02/baseline-system-prompt.txt \
  --label answers-baseline --live

LLM_PROVIDER=openai LLM_MODEL=gpt-6.1-sol npm run eval:voice -- \
  --set answers --repeat 2 --label answers-fixed --compare answers-baseline --live
```

Keep the original failed attempts. Compare matching fixture hashes and inspect both repetitions, then complete the pending human review against the saved fixture calls and output. Report fixture-model, deterministic regression and real-account evidence separately. A synthetic evaluation does not prove that live Gmail or calendar access works. Do not add prompt-string or canned-agent wording assertions to the unit suite as a substitute for model evidence.
