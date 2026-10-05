# Skill library

Otto uses progressive disclosure: metadata at session start, instructions when a skill applies, and references when needed. This follows the [Agent Skills integration guide](https://agentskills.io/client-implementation/adding-skills-support) and [Anthropic loading guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview).

Otto loads task guidance when the model needs it. The system prompt contains the task skill names and descriptions. It also contains the core guides for connected apps, schedules, artifacts and video links. The research guide is now a task skill.

The model selects a guide by the task, constraints and required result. The model calls `skills` with `action: "read"` and the skill name. It reads a linked reference only when the guide says that reference applies. It can read the guide again after compaction. `action: "list"` returns names and descriptions.

## Included guides

The library has 25 task guides:

- Business finance
- Calendar
- Customer support
- Data and spreadsheets
- Documents and forms
- Ecommerce operations
- Events and leisure
- Family administration
- Files and knowledge
- Food and groceries
- Health administration
- Hiring and career
- Home services
- Inbox
- Learning and study
- Personal finance
- Privacy and accounts
- Project operations
- Research
- Sales and CRM
- Shopping
- Software and websites
- Subscriptions and bills
- Travel
- Writing and content

Seven guides have a reference for a specific condition: recurring meetings, data imports, government forms, catalog synchronization, corpus research, purchase claims and existing travel bookings.

## Add or change a guide

Create `src/runtime/skills/<name>/SKILL.md`. Use a lowercase name with hyphens. The front matter must have `name` and `description`; the name must match the folder. Describe when the model must use the guide. In the body, give the task decisions, failure cases and evidence needed to check the result.

Use `references/<name>.md` for a longer procedure that applies only under a stated condition. Link it from the guide and state that condition. Keep each file at or below 64 KiB. Restart Otto after a change to the catalog or metadata. Guide bodies and references are read from disk on each call.

The loader uses Pi's metadata parser. Invalid metadata or a missing guide stops application setup. No new package, database table, network request or user setup is required.

## File and permission limits

Composition selects the library in the server source tree. Default Pi discovery is disabled. The library does not search the workspace, home directory, `.pi` folders or connected accounts. It ignores hidden folders and folder symlinks. Skills with `disable-model-invocation: true` cannot be listed or read by the model. Each read must stay inside the selected skill folder after path resolution. Only `SKILL.md` and named Markdown files directly inside `references` are allowed. Each file must be a regular file at or below the size limit.

Skill content is trusted server guidance. Reading it does not expose the model to outside content or change the memory trust state. Read-only turns can load guides. Activity checks cannot load them; their existing app-only tool limit still applies.

Guides do not supply tools, change account access, grant permission or override the user's choices. Booking approval and spending limits in a guide are model instructions. They do not add server enforcement for connected app actions. An interrupted action must retain its uncertain state; a guide does not authorize a repeat.

## Evidence limits

A saved evaluation of an earlier source version compared 300 attempts without task skills with 300 attempts with task skills. The primary judge reported task completion of 71.0% and 76.7%. It also found two unsafe attempts without skills and four with skills. An independent judge found no gain in the full-case pass rate. The recorded skill reads covered 16 of the 25 task guides.

These results do not establish a general quality or safety gain. This PR updates the booking, budget and task completion instructions in response to the recorded failures and keeps the newer research guide from main. Those changes have not had a new live evaluation. The PR does not include private research records, raw model traces or the local research database.
