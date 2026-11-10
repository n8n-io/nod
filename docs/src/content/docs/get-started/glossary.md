---
title: Key concepts
description: The words these docs use for Nod's parts, connections and safety controls, each in one or two plain sentences.
sidebar:
  order: 5
---

This page explains the words you'll meet in these docs. Select a term to read the page that covers it.

## Conversations and work

| Term                                     | What it means                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Conversation](/use/chat/)               | Your one ongoing chat with Nod. The app, Telegram and WhatsApp all show the same conversation, which engineering pages call the thread.                                                                                                        |
| [Task](/use/tasks/)                      | A piece of work Nod is doing for you. The **Tasks** page shows each one with its status, such as working or needs you.                                                                                                                         |
| [Turn](/how-it-works/threads-and-turns/) | One run of Nod's work, started by your message, a schedule, a background check or your answer to a question. Your chat runs one turn at a time, while scheduled runs and background checks run alongside it.                                   |
| [Schedule](/use/schedules/)              | Work that runs at a set time or on repeat, such as every Friday at 5 pm. You set one up by asking Nod in plain words.                                                                                                                          |
| [Background check](/use/schedules/)      | Work Nod starts on its own when something happens in a connected app, such as a new email. It reads every connected app and prepares private work with no setup, and does only what you told it to do on its own. Anything else waits for you. |
| [Nudge](/use/nudges/)                    | A message from Nod about something it noticed and already prepared, usually ending in one short question. You answer in words.                                                                                                                 |
| [Memory](/use/memory/)                   | What Nod remembers about you from what you tell it. You can see and edit it in **Settings → Memory**.                                                                                                                                          |
| [Skill](/how-it-works/skills/)           | A built-in guide for one kind of work, such as travel, research or spreadsheets, or a learned skill Nod wrote after doing a task. Nod reads the one that fits the task.                                                                        |

## Nod's computer

| Term                             | What it means                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [Workspace](/use/workspace/)     | Nod's private Linux computer, where it runs commands and keeps files. It never receives your model provider keys.              |
| [Browser](/use/browser/)         | Nod's own web browser, separate from yours and from the workspace.                                                             |
| [Browser handoff](/use/browser/) | When a website needs you, Nod opens a live browser view in chat. You take over, then select **Return to Nod** to hand it back. |

## Connections

| Term                                 | What it means                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Model connection](/connect/models/) | How Nod reaches a model: a supported provider's API key, a ChatGPT or OpenRouter sign-in, or an OpenAI-compatible server. A paid provider bills you for use. |
| [Connected app](/connect/apps/)      | An account Nod can use for you, such as Gmail, Calendar or Slack.                                                                                            |
| [Composio](/connect/apps/)           | The service Nod uses to connect many apps for you. You sign in to each app and choose what it can access.                                                    |
| [MCP](/connect/mcp-api-cli/)         | Model Context Protocol, a standard way for an app to offer tools to an assistant. Notion, Linear and n8n connect through their own MCP servers.              |
| [Channel](/use/channels/)            | Another place to chat with Nod besides the app: Telegram or WhatsApp.                                                                                        |

## Safety and control

| Term                                                            | What it means                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Trust check](/trust/approvals/)                                | The server check that runs before every connected app action. It decides whether the action runs now or waits for you.                                                                                                                        |
| [Approval](/trust/approvals/)                                   | Nod's yes or no question about one exact action. If you reply yes, the action runs once.                                                                                                                                                      |
| [Standing instruction](/trust/approvals/#standing-instructions) | What you told Nod to do on its own when something arrives, such as "whenever Ana sends an invoice, forward it to accounting". Background work does it without asking. Ask Nod in chat to see or change it.                                    |
| [Rules](/trust/approvals/#your-rules)                           | What you told Nod it may do without asking, or must always ask you about first, such as "always ask before you pay". The trust check holds every chat, task, scheduled run and background run to them. Ask Nod in chat to see or change them. |
| [Vault](/trust/vault/)                                          | Where Nod keeps your saved logins and cards, encrypted, and your saved browser sessions. The model never sees saved passwords, codes or card numbers.                                                                                         |
| [Saved login](/trust/vault/)                                    | A website username and password in Vault, with an optional authenticator key. Nod enters it privately, and only on that exact website.                                                                                                        |
| [Saved browser session](/trust/browser-sessions/)               | A signed-in browser profile that Nod can reuse on the websites you allow.                                                                                                                                                                     |
| [Private form](/trust/vault/)                                   | A secure form where you enter a password, code or card for a task. What you type goes to the website, not to the model.                                                                                                                       |
| [Uncertain outcome](/trust/outcomes/)                           | An approved action that was interrupted, so Nod can't tell if it happened. Nod checks the result instead of running it again.                                                                                                                 |

## Running Nod

| Term                                                  | What it means                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [Owner access key](/get-started/install-from-source/) | The secret that opens a local source install of Nod. The access link Nod prints when it starts saves it in your browser.         |
| [Server access token](/deploy/self-host/)             | The `NOD_AUTH_TOKEN` configured on a self-hosted server. Enter it in the web or desktop client to reach that server's assistant. |

## Related resources

- [What is Nod](/get-started/what-is-nod/)
- [Your first conversation](/get-started/first-conversation/)
- [Trust and Vault](/trust/)
- [How Nod works](/how-it-works/architecture/)
