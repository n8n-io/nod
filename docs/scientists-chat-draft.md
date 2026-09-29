# Scientists-chat announcement

The original announcement was verified posted on 2026-09-25: https://n8nio.slack.com/archives/C0BT5S8CV42/p1790351646964669. A later TL;DR and theme clips were shared at https://n8nio.slack.com/archives/C0BT5S8CV42/p1790376954723799. The text below is a refreshed draft, not a record that the latest changes have been sent. Share later changes as a follow-up instead of posting the full introduction again.

---

TL;DR: Otto is a local assistant that can do work from one chat: use connected apps, browse websites in its own computer, create files, remember context, and follow goals and schedules. The basic flows are working, with recorded examples below. It is still a prototype; Google/X sign-in and live integration coverage need more work.

**How it works**

- React chat → Node/Fastify server → Pi model/tool loop. PostgreSQL keeps conversations, task state and scheduled jobs so a follow-up can continue the same work.
- Three Docker containers: database, Linux workspace and browser. The browser runs inside the workspace environment, not in your own Chrome. The shell and browser have internet access; browser profiles and server keys stay separate from the shell.
- Apps use Composio for account connections and actions. A clear request can authorize ordinary work. A request to draft does not authorize sending; destructive or unclear actions ask a question in chat.
- Website identifiers and passwords go through one private Vault form. For verification, Otto first tries a narrow lookup in the matching connected Gmail inbox; otherwise it asks for the code in chat. The trusted server replaces a matching code reply with a masked receipt before local history or model processing. You can take over the container browser and click, type, paste or scroll directly when a site needs human interaction.

**What you can try**

Public browsing and screenshots; file creation and attachment previews; named logins and cards in Vault; goals with active/completed views; one-off and recurring schedules; mobile navigation and light/dark themes; and Inspector for tool calls, activity and estimated costs. Vault has a Cmd/Ctrl+K shortcut outside editing. Production builds put Inspector in More; small screens show a chat-first top bar, and the avatar opens a sheet with the other sections and account controls. Gmail, Calendar, Drive, Docs, Sheets, Slack and Notion adapters are present, with optional Telegram/WhatsApp channels. Each provider still needs its own live validation.

**Run it**

The code is in https://github.com/n8n-io/otto, currently on branch `feat/otto-workspace` / PR https://github.com/n8n-io/otto/pull/1. Install Node 24.21+ and Docker Desktop, check out that branch and run `npm run dev`. Add an OpenAI or Anthropic key to the ignored `.env`; add a Composio key if you want Apps. The launcher prepares the three containers and opens localhost:4310. macOS uses Keychain for the Vault key; other hosts need `OTTO_VAULT_KEY`. The app and machine must stay running for schedules.

**Current state and next work**

The latest local chat, browser-input, sign-in and navigation gate passed 873 tests with no failures or skips, plus checks, build and secret scans. Check the PR and `docs/verification.md` for current-head CI status. CI repeats PostgreSQL tests, type/import checks, build and secret scans. The review fixed command cancellation, artifact boundaries, scheduled action authority, recovery races and slow Apps reads. Desktop/mobile themes have been visually checked and recorded.

The shared login and 2FA recordings use synthetic accounts. A later real TOConline password and emailed-code sign-in succeeded in the container browser and stopped at the success confirmation. That run used the earlier private OTP form; the newer chat-code path has since passed the actual app/model/container flow on a synthetic site, with masked persistence checked after reload. The automatic inbox path has fixture coverage but still needs a real mailbox check. Google/X account login remains unverified. The second-Gmail consent fix opens the real Google chooser, but a second grant has not been completed. Email and password are collected in one form across staged site pages, and sign-in method selection happens in chat.

Next priorities: reliable provider sign-in and recovery, live connection/message-delivery tests, review findings, and better coverage of task continuity, memory and cost reporting. This is a single-owner local app; public authentication, tenant isolation, operational recovery and hosting remain unfinished. Payment-card autofill and general desktop control are not implemented.

**Recordings:** https://n8nio.slack.com/archives/C0BT5S8CV42/p1790351018250929 — four playable examples plus the full gallery: 12 current clips and 17 earlier recordings, each with its result and limits.

Five additional polish recordings cover Inspector, mobile navigation, account controls, browser takeover and named login. They predate direct keyboard input and chat-code entry. The README and `docs/system-guide.md` cover setup and architecture. Feedback on the actual workflows and rough edges is welcome.
