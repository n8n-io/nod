---
title: Saved browser sessions
description: Keep a website signed in inside Nod's private browser and reuse it in later tasks.
sidebar:
  order: 8
---

A saved browser session keeps a website signed in inside Nod's private browser, so later tasks can reuse it. Use one for sign-ins a saved login can't handle, such as a magic link or a code on your phone.

## Save a session

1. Ask Nod in chat to connect to a website and save the session. Include the website address and which account to use.
2. Nod opens the website in a new private browser profile. Sign in through the secure form, or take over the browser yourself.
3. Nod saves the session once it sees you're signed in. You can manage it in **Vault**.

## Use a session

When a task needs the website, Nod opens the saved profile. It's the same permission check as a saved login: the server checks that your task needs this website and account, or Nod asks "Use your saved session on example.com?". The check also considers the website the saved session belongs to, not only the page being opened; if a task needs a different site but not the saved-session website, Nod asks you first and shows both.

Opening a profile doesn't prove it's still signed in, so Nod checks the page. If opening it lands on another website, such as a sign-in service, Vault shows **Sign-in needed** and a **Sign in again** button.

A session opens in one browser at a time. While you're still signing in to it in the chat, other tasks can't open it, and they visit public pages without it.

## When the browser stays signed in

| Situation                                      | What happens                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The chat                                       | Its browser stays signed in. Each new sign-in or saved-session use is checked again                                                                                          |
| A scheduled run, background work or a subagent | Starts in its own fresh browser, signed out. It signs in again with a saved login or session, checked as usual; background work is checked against your standing instruction |

## Sign out

Open the session in **Vault** and select **Sign out**. This deletes the saved profile. If a task is using it, stop the task first.

Deleting a saved login keeps its browser session. The session remains in **Vault** so you can sign out separately.

## Passkeys and manual sign-in

Passkeys are turned off in Nod's browser, because your passkeys live on your own devices. A passkey request fails right away, so use another sign-in method. For a magic link or any step Nod can't finish, Nod asks you to take over its browser. See [Nod's browser](/use/browser/).

## Saved session or saved login?

|                 | Saved login                                           | Saved session                                 |
| --------------- | ----------------------------------------------------- | --------------------------------------------- |
| What's stored   | Username and password, encrypted by Vault             | The browser profile: cookies and site storage |
| How you add it  | **Add → Login**, an import or the private form        | Sign in once in Nod's browser                 |
| How Nod uses it | The server types the values into the fields Nod picks | Nod opens the signed-in profile               |
| Where it works  | Fields on the login's exact origin                    | Any public website, never your local network  |
| Best for        | Username and password sign-in                         | Sign-ins you do by hand, such as magic links  |

Like the rest of Nod's browser, a saved profile reaches only public addresses: never your computer, your local network or other containers.

:::caution
Once signed in, Nod can act anywhere on that website. Vault doesn't review each click. A saved session is browser data kept with Nod's other data, and Vault doesn't encrypt it, so protect the machine running Nod and its backups.
:::

## Where this is enforced

[`src/server/browser-connections.ts`](https://github.com/n8n-io/nod/blob/main/src/server/browser-connections.ts) (sessions) · [`src/server/vault-access.ts`](https://github.com/n8n-io/nod/blob/main/src/server/vault-access.ts) (permission and sign-out for background work) · [`src/providers/agent-browser/network.ts`](https://github.com/n8n-io/nod/blob/main/src/providers/agent-browser/network.ts) (public addresses only)

## Related resources

- [Trust and Vault](/trust/)
- [Vault and saved logins](/trust/vault/)
- [Nod's browser](/use/browser/)
- [Security model and limits](/trust/security-model/)
