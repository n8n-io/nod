---
title: Key concepts
description: The words these docs use for nod's parts, connections and safety controls, each in one or two plain sentences.
sidebar:
  order: 5
---

This page explains the words you'll meet in these docs. Select a term to read the page that covers it.

## Conversations and work

| Term                                     | What it means                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Conversation](/use/chat/)               | Your one ongoing chat with nod. The app, Telegram and WhatsApp all show the same conversation, which engineering pages call the thread.                                                                                                                                          |
| [Task](/use/tasks/)                      | A piece of work nod is doing for you. The **Tasks** page shows each one with its status, such as working or needs you.                                                                                                                                                           |
| [Turn](/how-it-works/threads-and-turns/) | One run of nod's work, started by your message, a schedule, a background check or your answer to a question. Your chat runs one turn at a time, while scheduled runs and background checks run alongside it.                                                                     |
| [Schedule](/use/schedules/)              | Work that runs at a set time or on repeat, such as every Friday at 5 pm. You set one up by asking nod in plain words.                                                                                                                                                            |
| [Background check](/use/schedules/)      | Work nod starts on its own when something happens in a connected app, such as a new email, once you've told nod what's worth interrupting you for. Until then, nod starts no run. It reads, drafts and does only what you told it to do on its own. Anything else waits for you. |
| [Memory](/use/memory/)                   | What nod remembers about you from what you tell it. You can see and edit it in **Settings → Memory**.                                                                                                                                                                            |
| [Skill](/how-it-works/skills/)           | A built-in guide for one kind of work, such as travel, research or spreadsheets, or a learned skill nod wrote after doing a task. nod reads the one that fits the task.                                                                                                          |

## nod's computer

| Term                             | What it means                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [Workspace](/use/workspace/)     | nod's private Linux computer, where it runs commands and keeps files. It never receives your model provider keys.              |
| [Browser](/use/browser/)         | nod's own web browser, separate from yours and from the workspace.                                                             |
| [Browser handoff](/use/browser/) | When a website needs you, nod opens a live browser view in chat. You take over, then select **Return to nod** to hand it back. |

## Connections

| Term                                 | What it means                                                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Model connection](/connect/models/) | How nod reaches a model: an OpenAI, Anthropic, OpenRouter, Amazon Bedrock, Google Vertex AI or Azure OpenAI API key, a ChatGPT or OpenRouter account, or a local model server. A paid provider bills you for use. |
| [Connected app](/connect/apps/)      | An account nod can use for you, such as Gmail, Calendar or Slack.                                                                                                                                                 |
| [Composio](/connect/apps/)           | The service nod uses to connect many apps for you. You sign in to each app and choose what it can access.                                                                                                         |
| [MCP](/connect/mcp-api-cli/)         | Model Context Protocol, a standard way for an app to offer tools to an assistant. Notion, Linear and n8n connect through their own MCP servers.                                                                   |
| [Channel](/use/channels/)            | Another place to chat with nod besides the app: Telegram or WhatsApp.                                                                                                                                             |

## Safety and control

| Term                                                            | What it means                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Trust check](/trust/approvals/)                                | The server check that runs before every connected app action. It decides whether the action runs now or waits for you.                                                                                                                       |
| [Approval](/trust/approvals/)                                   | nod's yes or no question about one exact action. If you reply yes, the action runs once.                                                                                                                                                     |
| [Standing instruction](/trust/approvals/#standing-instructions) | What you told nod to do on its own when something arrives, such as "whenever Ana sends an invoice, forward it to accounting". Background work does it without asking. You see and change it in **Usage**.                                    |
| [Rules](/trust/approvals/#your-rules)                           | What you told nod it may do without asking, or must always ask you about first, such as "always ask before you pay". The trust check holds every chat, task, scheduled run and background run to them. You see and change them in **Usage**. |
| [Vault](/trust/vault/)                                          | Where nod keeps your saved logins and cards, encrypted, and your saved browser sessions. The model never sees saved passwords, codes or card numbers.                                                                                        |
| [Saved login](/trust/vault/)                                    | A website username and password in Vault, with an optional authenticator key. nod enters it privately, and only on that exact website.                                                                                                       |
| [Saved browser session](/trust/browser-sessions/)               | A signed-in browser profile that nod can reuse on the websites you allow.                                                                                                                                                                    |
| [Private form](/trust/vault/)                                   | A secure form where you enter a password, code or card for a task. What you type goes to the website, not to the model.                                                                                                                      |
| [Uncertain outcome](/trust/outcomes/)                           | An approved action that was interrupted, so nod can't tell if it happened. nod checks the result instead of running it again.                                                                                                                |

## Running nod

| Term                                                  | What it means                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [Owner access key](/get-started/install-from-source/) | The secret that opens a source install of nod. The access link nod prints when it starts saves it in your browser. |

## Related resources

- [What is nod](/get-started/what-is-nod/)
- [Your first conversation](/get-started/first-conversation/)
- [Trust and Vault](/trust/)
- [How nod works](/how-it-works/architecture/)
