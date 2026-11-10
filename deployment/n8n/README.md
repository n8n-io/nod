# n8n workflows

This folder maintains four of Nod's workflows on the internal n8n instance. Each script here generates or embeds the exact workflow source, and each has synthetic contract tests.

| Workflow             | Source                 | What it does                                                                                      |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| Nod Desktop Releases | `desktop-releases.mjs` | Serves published desktop releases, runtime packs and update feeds without exposing a GitHub token |
| Nod Install          | `install-workflow.mjs` | Serves `install.sh` for Mac Terminal and `install.ps1` for Windows PowerShell                     |
| Nod Feedback         | `feedback.mjs`         | Turns in-app feedback into a Linear issue with its reports attached                               |
| Nod Traces           | `traces.mjs`           | Forwards opted-in, scrubbed conversation traces to the `nod` LangSmith project in the EU          |

```sh
node --test deployment/n8n/*.test.mjs
```

- The release broker only serves published `nod-v*` releases from this repository, pins each asset by release and asset ID, and never streams archives through n8n.
- The traces broker refuses requests without the `x-nod-traces-token` header from the n8n credential `nod traces webhook`, answers the rest with 202, validates each trace, forwards about 600 per clock minute in total (a best-effort cost cap: a burst across a minute boundary or simultaneous runs can pass a few more), pins each to that project by its ID as one `llm` run and keeps no execution data. Official desktop builds get the token from the `NOD_TRACES_TOKEN` release secret; anyone who unpacks the app can read it, so it keeps out scanners, not a determined sender. Its LangSmith service key lives only in the n8n credential `nod LangSmith traces`, never in Nod.
- Feedback requests are versioned in `src/ports/feedback.ts`. The workflow checks every hash before it touches Linear, and repeated submissions with the same ID can't create a second issue. Execution data retention stays off.
- Publish the broker before the installer. Before you replace a workflow, export its current version so you can roll back.
- Every published release is fetched through the live broker with the desktop update code. If an installer, runtime pack or update for either Mac or Windows doesn't resolve, the release goes back to draft, so publish broker changes before the release that needs them.

User-facing behaviour is documented in [Install the desktop app](../../docs/src/content/docs/get-started/install-desktop.mdx) and [Your data and privacy](../../docs/src/content/docs/trust/privacy.md).
