# n8n workflows

This folder maintains five of Nod's workflows on the internal n8n instance. Each script here generates or embeds the exact workflow source, and each has synthetic contract tests.

| Workflow               | Source                           | What it does                                                                                       |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Nod Desktop Releases   | `desktop-releases.mjs`           | Serves published desktop releases, runtime packs and update feeds without exposing a GitHub token  |
| Nod Install            | `install-workflow.mjs`           | Serves `install.sh` for Mac Terminal and `install.ps1` for Windows PowerShell                      |
| Nod Feedback           | `feedback.mjs`                   | Turns in-app feedback into a Linear issue with its reports attached                                |
| Nod Traces             | `traces.mjs`                     | Forwards opted-in, scrubbed conversation traces to the `nod` LangSmith project in the EU           |
| Nod onboarding updates | `onboarding-updates.workflow.ts` | Records an unverified email signup and fixed About you choices in Customer.io Labs; sends no email |

```sh
node --test deployment/n8n/*.test.mjs
```

- The release broker only serves published `nod-v*` releases from this repository, pins each asset by release and asset ID, and never streams archives through n8n.
- The traces broker refuses requests without the `x-nod-traces-token` header from the n8n credential `nod traces webhook`, answers the rest with 202, validates each trace, forwards about 600 per clock minute in total (a best-effort cost cap: a burst across a minute boundary or simultaneous runs can pass a few more), pins each to that project by its ID as one `llm` run and keeps no execution data. Official desktop builds get the token from the `NOD_TRACES_TOKEN` release secret; anyone who unpacks the app can read it, so it keeps out scanners, not a determined sender. Its LangSmith service key lives only in the n8n credential `nod LangSmith traces`, never in Nod.
- The onboarding updates workflow exposes a public n8n webhook, accepts only versioned email submissions with a consent-checkbox claim and fixed About you choices, and rejects bodies over 2 KB after n8n parses them. Anyone can call the webhook, so the claim does not verify control of the address. The workflow stamps the receipt time on the server and identifies the person by normalized email in Customer.io Labs, where email is enabled as an identifier. Customer.io updates the existing profile or creates one if the address is new. Keep email identification enabled in Labs; otherwise the address can become a separate ID. The workflow uses the same Track API credential as Nod Waitlist, preserves unsubscribe state, and sends no message. Apply the retention settings in `onboarding-updates.settings.json` before publication. Do not send update emails until the double opt-in confirmation flow is ready.
- Feedback requests are versioned in `src/ports/feedback.ts`. The workflow checks every hash before it touches Linear, and repeated submissions with the same ID can't create a second issue. Execution data retention stays off.
- Older private builds use the release broker. Publish it before an installer that depends on it, and export the current workflow version before replacing it so you can roll back.
- Public builds and installers fetch GitHub Releases directly. Check that their installer, runtime pack, and update assets resolve before publishing a release. The n8n broker remains available for older private builds.

User-facing behaviour is documented in [Install the desktop app](../../docs/src/content/docs/get-started/install-desktop.mdx) and [Your data and privacy](../../docs/src/content/docs/trust/privacy.md).
