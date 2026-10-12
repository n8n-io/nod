# n8n workflows

This folder maintains three of Otto's workflows on the internal n8n instance. Each script here generates or embeds the exact workflow source, and each has synthetic contract tests.

| Workflow              | Source                 | What it does                                                                                      |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| Otto Desktop Releases | `desktop-releases.mjs` | Serves published desktop releases, runtime packs and update feeds without exposing a GitHub token |
| Otto Install          | `install-workflow.mjs` | Serves `install.sh` for Mac Terminal and `install.ps1` for Windows PowerShell                     |
| Otto Feedback         | `feedback.mjs`         | Turns in-app feedback into a Linear issue with its reports attached                               |

```sh
node --test deployment/n8n/*.test.mjs
```

- The release broker only serves published `desktop-v*` and runtime releases from this repository, pins each asset by release and asset ID, and never streams archives through n8n.
- The Mac installer verifies the DMG's size, SHA-256 and code signature against the pinned certificate before it replaces `/Applications/Otto.app`, and keeps the old app until the new one is ready. The Windows installer is unsigned, so `install.ps1` checks the installer and runtime pack against the release's sizes, SHA-256 digests and manifest before it runs the installer silently.
- Feedback requests are versioned in `src/ports/feedback.ts`. The workflow checks every hash before it touches Linear, and repeated submissions with the same ID can't create a second issue. Execution data retention stays off.
- Publish the broker before the installer. Before you replace a workflow, export its current version so you can roll back.
- Every published release is fetched through the live broker with the desktop update code. If an installer, runtime pack or update for either Mac or Windows doesn't resolve, the release goes back to draft, so publish broker changes before the release that needs them.

User-facing behaviour is documented in [Install the desktop app](../../docs/src/content/docs/get-started/install-desktop.mdx) and [Your data and privacy](../../docs/src/content/docs/trust/privacy.md).
