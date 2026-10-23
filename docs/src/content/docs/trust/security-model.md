---
title: Security model and limits
description: Who nod trusts with what, the rules its server enforces, the limits of those rules, and how to report a vulnerability.
sidebar:
  order: 13
---

This page sets out who nod trusts with what, which rules the server enforces, and what those rules don't cover. It's written for security reviewers. For data flows and threats, see the [Security review guide](/trust/security-review/).

## Who holds what authority

| Part             | What it can do                                                                                     | What it's trusted with                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| You              | Ask for work, approve actions, choose accounts, change permissions                                 | Everything                                                                                                                                                                                                                                                                |
| nod server       | Hold keys, check policy, decrypt values, record every use                                          | Keys and secret values                                                                                                                                                                                                                                                    |
| Browser provider | Check field origins and pages, enter values, submit                                                | Secret values during entry                                                                                                                                                                                                                                                |
| 1Password helper | Read the logins 1Password would fill on the website in front of you, and copy the one you pick     | Your 1Password account, from your approval until it is idle for 10 minutes                                                                                                                                                                                                |
| Model            | Plan, choose accounts, fields and buttons                                                          | Account names, statuses and website results                                                                                                                                                                                                                               |
| Checker          | Decide each app action and browser step from your messages or a schedule's or standing instruction | Your recent messages, a schedule's instruction or your standing instruction, your rules, and the action. For a browser step: the website, page address, control label, the form a click or Enter sends, dialog text or file, what nod typed or set; never the page's text |
| Website          | Receive what's submitted to its origin                                                             | The values entered on it                                                                                                                                                                                                                                                  |

## Trust boundaries

```mermaid
flowchart LR
  you([You]):::accent --> server[nod server<br/>keys and policy]:::accent
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

- Only your messages, a schedule's instruction, your standing instruction, your rules and your approvals carry authority. Pages, emails, files and tool results can't create permission.
- To run an action, the checker must quote the words that allow it. The server checks those words are in what the checker was shown, and asks you when they aren't. Usage shows them next to the action.
- App actions beyond reads and drafts need a review match against your request or your yes. See [Approvals](/trust/approvals/).
- A confirmation is bound to the exact action and arguments, and runs once.
- Background work nod starts itself reads and drafts, and does only what your [standing instruction](/trust/approvals/#standing-instructions) asks. Anything else waits for your yes unless one of your [rules](/trust/approvals/#your-rules) allows it, a rule to ask first makes nod ask even when the instruction covers the action, and a payment always needs your approval.

### Secrets

- No tool returns a saved password, code or card to the model.
- nod is told never to ask for a password, code, card or API key in chat; it opens private entry instead. While a verification code is pending in the conversation that asked for it, a message that ends with its only 4–8 digit number (digits 0–9) is taken as the code, whatever the wording around it, and a message with a code-length number anywhere else is refused. While a card's security code is pending, only a code sent by itself or labeled CVV, CVC or security code, as in "my CVC is 123", is taken, and any other message with a 3- or 4-digit number is refused. A code sent as a reply to a closed request, or by itself until 10 minutes after nod starts on a newer message, is refused too. None of these reach the model. Digits in other scripts and any other secret you type into chat reach the model.
- Known secret values are removed from tool output and masked in screenshots.
- Provider keys never enter the workspace, the browser or a prompt.

### Browser

- A login is entered only into a field whose real frame origin matches the login's exact origin. Card fields must match the approved destinations.
- Entry and submission happen in one step that the model can't observe or act during. Scripts on the destination page can read the entered values, as with any form.
- A page changed by the model's own JavaScript must reload before entry. After a failed entry, the model's view stays locked until the filled page changes.
- After nod fills a private value on a page, the model's page scripts stay paused on that page until it reloads or moves on, so a script can't read the value back even once the field is gone.
- The browser and the web tools reach only public addresses, never the host, the local network or other containers. The address is checked when each connection opens, so a name can't switch to a private address after the check. nod drops any proxy for a web tool, whether the model names it or the web extension's settings set it.

### One use

- Every private entry and payment is claimed once before browser work starts. It never runs twice, and an interrupted one becomes uncertain. See [One use, one result](/trust/outcomes/).

### Isolation

- The workspace runs as an unprivileged user with no host home folder, Docker socket, provider keys, access key or browser profiles.
- A connected command-line tool's token reaches only a sealed install of its declared source, run as its own user with a clean environment, apart from other tools.
- Every query and route is scoped to one owner.
- File previews never run a file in nod's own page. An HTML file runs in a sandbox with an empty origin and no network, forms or pop-ups, and its preview closes if it tries to open a website. Other formats are read as data. Files that can run code get no local preview before they upload.

### Local access

- Loopback isn't treated as identity. Every local `/api` request needs the owner key from `NOD_DATA_ROOT/access-key`, or the desktop app's per-launch token. Only verified webhooks, OAuth callbacks, the key exchange and the privacy notice go without it.

## Limits

:::caution[What these rules don't cover]

- The server and browser provider can read secret values. There's no isolated key service or hardware-backed key release.
- The website receives what's submitted, and can store, encode or show it again. Masking replaces only the exact known values.
- The model can type any value it knows into a page, including a secret you typed into chat.
- nod checks each email in app results and connected-app events on its own, with a decision model or the connection's smaller model, and hides any that gives access to an account: codes, sign-in and reset links, temporary passwords, recovery codes and keys sent by email. The check reads the sender, subject and up to 8,000 characters of text (the start and end of a longer email), so it can miss access in the middle of a very long message, and an email downloaded as a file isn't checked. A failed check hides the email.
- Once signed in, nod can act anywhere on that website. Vault doesn't review each click. The trust check judges a browser step from what it does (a click, a key press or a script), the website and page, the control's label when there is one, the method and address of a form it sends, any dialog text or file name, and what nod typed. It never sees the page's text. A deceptive site can still mislabel a control that acts through page scripts, or send a form to an address that doesn't say what it does. A request to buy or book covers the steps it needs on the website it names, including a control without a label when even the worst it could do there stays within the request.
- A login with an authenticator key keeps both sign-in steps in Vault, so anyone who can open your Vault can complete that two-step sign-in. Add a key only where you want nod to sign in on its own.
- 1Password's approval isn't narrower than your account: until it's idle for 10 minutes or you lock 1Password, nod's helper could read any item. nod's code asks it only for the logins for the website in front of you and the one you pick.
- The checker can be wrong, and the model isn't immune to prompt injection.
- nod writes [learned skills](/how-it-works/memory/#learned-skills) from what it did and read, so a page or an email can shape one, and a skill can steer later tasks. A skill never grants permission, and the trust check never sees it.
- A standing instruction runs for any new email or update that matches it, including one that only claims to come from the sender you named. Your rules apply in every kind of work, so background work started by such an email can do what a rule to go ahead covers.
- The checker quotes your words, or says "read", to run an action. The server verifies that the words exist, not that they really ask for the action; that judgment is still the checker's.
- Reads, drafts and links nod opens or fetches aren't checked. In a source install the workspace has no outbound firewall; the desktop app blocks private and reserved addresses.
- A saved card can't make the issuer enforce the amount, and card support isn't a PCI DSS compliance claim.
- A script in an HTML preview can still navigate its own frame to a website and take that page's contents with it, as it could if you opened the downloaded file in a browser. It can't read anything from nod, and the preview closes when it navigates.
- Tests cover known failure cases. They don't prove that every injection or browser exploit is blocked.

:::

## Report a vulnerability

Report it privately through [GitHub private vulnerability reporting](https://github.com/n8n-io/nod/security/advisories/new), or through [n8n's Vulnerability Disclosure Program](https://n8n.io/report-a-vulnerability/). Don't open a public issue, and never include real passwords, keys or other people's data.

The team aims to acknowledge your report within 3 business days and to share a first assessment within 10 business days. Confirmed issues get a GitHub security advisory. Read the full [security policy](https://github.com/n8n-io/nod/blob/main/SECURITY.md) for scope and research rules.

## Where this is enforced

| Area                        | Source                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority and confirmations | [`trust.ts`](https://github.com/n8n-io/nod/blob/main/src/server/trust.ts), [`approvals.ts`](https://github.com/n8n-io/nod/blob/main/src/server/approvals.ts)                                              |
| Vault and one use           | [`vault-access.ts`](https://github.com/n8n-io/nod/blob/main/src/server/vault-access.ts), [`vault-use.ts`](https://github.com/n8n-io/nod/blob/main/src/server/vault-use.ts)                                |
| Browser entry and proxy     | [`agent-browser`](https://github.com/n8n-io/nod/tree/main/src/providers/agent-browser)                                                                                                                    |
| Local access                | [`access.ts`](https://github.com/n8n-io/nod/blob/main/src/server/access.ts)                                                                                                                               |
| File previews               | [`attachment-frame.tsx`](https://github.com/n8n-io/nod/blob/main/src/web/components/attachment-frame.tsx), [`attachment-kind.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/attachment-kind.ts) |

## Related resources

- [Trust and Vault](/trust/)
- [Security review guide](/trust/security-review/)
- [Our trust principles](/trust/principles/)
- [Your data and privacy](/trust/privacy/)
