# Voice eval

Checks how Otto sounds: how fast it shows direction, how short its messages are, and whether it backs off when ignored. It runs the real agent loop and the live model from `.env` against scripted apps and search (`scripts/voice-scenarios.ts`); nothing touches real accounts or the local database.

```sh
npm run eval:voice -- --label v3 --repeat 2 --compare baseline,v2
npm run eval:voice -- --only inbox-triage,research --label quick
npm run eval:voice -- --report-only --compare baseline,v2
```

Runs are saved to `.local/voice-evals/<label>.json`; `report.html` puts the labels side by side with timestamps, tool calls and checks.

The checks are cheap tripwires, not the verdict: acknowledgement before the first tool call, final result after the last one, message length, boilerplate phrases, headings and em dashes, and staying quiet after unanswered nudges. Read the transcripts first, note what sounds off, and only turn failures that keep recurring into new checks or scenarios.

The voice lives in `src/runtime/personality.ts`; operating rules stay in `src/runtime/prompt.ts`.
