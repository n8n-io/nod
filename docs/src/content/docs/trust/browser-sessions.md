---
title: Saved browser sessions
description: Keep a website signed in inside Otto's private browser and reuse it in later tasks.
sidebar:
  order: 8
---

A saved browser session keeps a website signed in inside Otto's private browser, so later tasks can reuse it. Use one for sign-ins a saved login can't handle, such as a magic link or a code on your phone.

## Save a session

1. In **Trust**, select **New**, then **Website session**.
2. Enter the **Website address** and, if you like, an **Account name**. Select **Continue in chat**.
3. Otto opens the website in a new private browser profile. Sign in through the secure form, or take over the browser yourself.
4. Otto saves the session once it sees you're signed in.

You can also ask Otto in chat to connect to a website and save the session.

## Use a session

When a task needs the website, Otto opens the saved profile. It's the same permission check as a saved login: the server checks that your task needs this website and account, or Otto asks "Use your saved session on example.com?". The check also considers the website the saved session belongs to, not only the page being opened; if a task needs a different site but not the saved-session website, Otto asks you first and shows both.

Opening a profile doesn't prove it's still signed in, so Otto checks the page. If opening it lands on another website, such as a sign-in service, Vault shows **Sign-in needed** and a **Sign in again** button.

A session opens in one browser at a time. While you're still signing in to it in the chat, other tasks can't open it, and they visit public pages without it.

## When the browser stays signed in

| Situation                                      | What happens                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The chat                                       | Its browser stays signed in. Each new sign-in or saved-session use is checked again                                                                                          |
| A scheduled run, background work or a subagent | Starts in its own fresh browser, signed out. It signs in again with a saved login or session, checked as usual; background work is checked against your standing instruction |

## Sign out

Open the session in **Trust → Saved** and select **Sign out**. This deletes the saved profile. If a task is using it, stop the task first.

## Passkeys and manual sign-in

Passkeys are turned off in Otto's browser, because your passkeys live on your own devices. A passkey request fails right away, so use another sign-in method. For a magic link or any step Otto can't finish, Otto asks you to take over its browser. See [Otto's browser](/use/browser/).

## Saved session or saved login?

|                  | Saved login                                            | Saved session                                 |
| ---------------- | ------------------------------------------------------ | --------------------------------------------- |
| What's stored    | Username and password, encrypted by Vault              | The browser profile: cookies and site storage |
| How you add it   | **New login**, an import or the private form           | Sign in once in Otto's browser                |
| How Otto uses it | The server types the values into the fields Otto picks | Otto opens the signed-in profile              |
| Where it works   | Fields on the login's exact origin                     | Any public website, never your local network  |
| Best for         | Username and password sign-in                          | Sign-ins you do by hand, such as magic links  |

Like the rest of Otto's browser, a saved profile reaches only public addresses: never your computer, your local network or other containers.

:::caution
Once signed in, Otto can act anywhere on that website. Vault doesn't review each click. A saved session is browser data kept with Otto's other data, and Vault doesn't encrypt it, so protect your computer and backups.
:::

## Where this is enforced

[`src/server/browser-connections.ts`](https://github.com/n8n-io/otto/blob/main/src/server/browser-connections.ts) (sessions) · [`src/server/vault-access.ts`](https://github.com/n8n-io/otto/blob/main/src/server/vault-access.ts) (permission and sign-out for background work) · [`src/providers/agent-browser/network.ts`](https://github.com/n8n-io/otto/blob/main/src/providers/agent-browser/network.ts) (public addresses only)

## Related resources

- [Trust and Vault](/trust/)
- [Vault and saved logins](/trust/vault/)
- [Otto's browser](/use/browser/)
- [Security model and limits](/trust/security-model/)
