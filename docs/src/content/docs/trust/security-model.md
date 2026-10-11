---
title: Security model and limits
description: Who Otto trusts with what, the rules its server enforces, the limits of those rules, and how to report a vulnerability.
sidebar:
  order: 12
---

This page sets out who Otto trusts with what, which rules the server enforces, and what those rules don't cover. It's written for security reviewers. For data flows and threats, see the [Security review guide](/trust/security-review/).

## Who holds what authority

| Part             | What it can do                                                     | What it's trusted with                            |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| You              | Ask for work, approve actions, choose accounts, change permissions | Everything                                        |
| Otto server      | Hold keys, check policy, decrypt values, record every use          | Keys and secret values                            |
| Browser provider | Check field origins and pages, enter values, submit                | Secret values during entry                        |
| Model            | Plan, choose accounts, fields and buttons                          | Account names, statuses and website results       |
| Review model     | Match an action to your messages or a schedule's instruction       | Your recent messages and the action, nothing else |
| Website          | Receive what's submitted to its origin                             | The values entered on it                          |

## Trust boundaries

```mermaid
flowchart LR
  you([You]):::accent --> server[Otto server<br/>keys and policy]:::accent
  server <--> model[Model provider]
  server --> sandbox[Workspace<br/>no keys]:::muted
  server --> browser[Browser<br/>private entry]
  server --> db[(Database<br/>encrypted Vault)]
  browser --> sites[Websites]
  server --> apps[Connected apps]
```

Only the server holds keys and decides what runs. The model, the workspace and anything the browser loads are on the other side of that line.

## Rules the server enforces

### Authority

- Only your messages, a schedule's instruction and your approvals carry authority. Pages, emails, files and tool results can't create permission.
- App actions that reach other people, delete data or can't be classified need known recipients, a review match or your yes. See [Approvals](/trust/approvals/).
- A confirmation is bound to the exact action and arguments, and runs once.
- Background work Otto starts itself only reads and drafts on its own, and never signs in or pays. Read-only and onboarding work refuses classified writes, and never signs in or pays.

### Secrets

- No tool returns a saved password, code or card to the model.
- If the model writes a message asking you for a password, code, card or API key, Otto withholds it and points the model to private entry.
- Known secret values are removed from tool output and masked in screenshots.
- Provider keys never enter the workspace, the browser or a prompt.

### Browser

- A login is entered only into a field whose real frame origin matches the login's exact origin. Card fields must match the approved destinations.
- Entry and submission happen in one step that the model can't observe or act during. Scripts on the destination page can read the entered values, as with any form.
- A page changed by the model's own JavaScript must reload before entry. After a failed entry, the model's view stays locked until the filled page changes.
- A saved browser profile can reach only the exact origins permitted for the task.

### One use

- Every private entry and payment is claimed once before browser work starts. It never runs twice, and an interrupted one becomes uncertain. See [One use, one result](/trust/outcomes/).

### Isolation

- The workspace runs as an unprivileged user with no host home folder, Docker socket, provider keys, access key or browser profiles.
- A connected command-line tool's token reaches only a sealed install of its declared source, run as a separate user with a clean environment.
- Every query and route is scoped to one owner.

### Local access and hosted mode

- Loopback isn't treated as identity. Every local `/api` request needs the owner key from `OTTO_DATA_ROOT/access-key`, or the desktop app's per-launch token. Only verified webhooks, OAuth callbacks, the key exchange and the privacy notice go without it.
- Hosted mode runs one runtime per user with a fixed owner, its own database role and schemas. The gateway signs each request with an HMAC envelope bound to owner, environment, generation, method, target, body, nonce and expiry, and rejects replays.
- The hosted master key stays in the gateway. Each runtime gets only keys derived for its own user.

## Limits

:::caution[What these rules don't cover]

- The server and browser provider can read secret values. There's no isolated key service or hardware-backed key release.
- The website receives what's submitted, and can store, encode or show it again. Masking replaces only the exact known values.
- Once signed in, Otto can act anywhere on that website. Vault doesn't review each click, and the trust check covers app actions only.
- The review model can be wrong, and the model isn't immune to prompt injection.
- Changes to your own data, data sent to recipients you already trust, and links Otto opens or fetches aren't checked. In a source install the workspace has no outbound firewall; the desktop app blocks private and reserved addresses.
- A saved card can't make the issuer enforce the amount, and card support isn't a PCI DSS compliance claim.
- In hosted mode, the operator can decrypt stored data.
- Tests cover known failure cases. They don't prove that every injection or browser exploit is blocked.

:::

## Report a vulnerability

Report it privately through [GitHub private vulnerability reporting](https://github.com/n8n-io/otto/security/advisories/new), or through [n8n's Vulnerability Disclosure Program](https://n8n.io/report-a-vulnerability/). Don't open a public issue, and never include real passwords, keys or other people's data.

The team aims to acknowledge your report within 3 business days and to share a first assessment within 10 business days. Confirmed issues get a GitHub security advisory. Read the full [security policy](https://github.com/n8n-io/otto/blob/main/SECURITY.md) for scope and research rules.

## Where this is enforced

| Area                        | Source                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority and confirmations | [`trust.ts`](https://github.com/n8n-io/otto/blob/main/src/server/trust.ts), [`approvals.ts`](https://github.com/n8n-io/otto/blob/main/src/server/approvals.ts)               |
| Vault and one use           | [`vault-access.ts`](https://github.com/n8n-io/otto/blob/main/src/server/vault-access.ts), [`vault-use.ts`](https://github.com/n8n-io/otto/blob/main/src/server/vault-use.ts) |
| Browser entry and proxy     | [`agent-browser`](https://github.com/n8n-io/otto/tree/main/src/providers/agent-browser)                                                                                      |
| Credential guard            | [`communication.ts`](https://github.com/n8n-io/otto/blob/main/src/runtime/communication.ts)                                                                                  |
| Local access and hosting    | [`access.ts`](https://github.com/n8n-io/otto/blob/main/src/server/access.ts), [`gateway.ts`](https://github.com/n8n-io/otto/blob/main/src/server/gateway.ts)                 |

## Related resources

- [Trust and Vault](/trust/)
- [Security review guide](/trust/security-review/)
- [Our trust principles](/trust/principles/)
- [Your data and privacy](/trust/privacy/)
