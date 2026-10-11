# n8n workflows

This folder maintains three of Otto's workflows on the internal n8n instance. Each script here generates or embeds the exact workflow source, and each has synthetic contract tests.

| Workflow              | Source                 | What it does                                                                                      |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| Otto Desktop Releases | `desktop-releases.mjs` | Serves published desktop releases, runtime packs and update feeds without exposing a GitHub token |
| Otto Install          | `install-workflow.mjs` | Serves `install.sh`, the Terminal installer for Macs                                              |
| Otto Feedback         | `feedback.mjs`         | Turns in-app feedback into a Linear issue with its reports attached                               |

```sh
node --test deployment/n8n/*.test.mjs
```

- The release broker only serves published `desktop-v*` and runtime releases from this repository, pins each asset by release and asset ID, and never streams archives through n8n.
- The installer verifies the DMG's size, SHA-256 and code signature against the pinned certificate before it replaces `/Applications/Otto.app`, and keeps the old app until the new one is ready.
- Feedback requests are versioned in `src/ports/feedback.ts`. The workflow checks every hash before it touches Linear, and repeated submissions with the same ID can't create a second issue. Execution data retention stays off.
- Publish the broker before the installer. Before you replace a workflow, export its current version so you can roll back.

User-facing behaviour is documented in [Install the desktop app](../../docs/src/content/docs/get-started/install-desktop.mdx) and [Your data and privacy](../../docs/src/content/docs/trust/privacy.md).
