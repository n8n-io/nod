---
title: Key concepts
description: The words these docs use for Otto's parts, connections and safety controls, each in one or two plain sentences.
sidebar:
  order: 5
---

This page explains the words you'll meet in these docs. Select a term to read the page that covers it.

## Conversations and work

| Term                                     | What it means                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Conversation](/use/chat/)               | Your one ongoing chat with Otto. The app, Telegram and WhatsApp all show the same conversation, which engineering pages call the thread.                                                                                                                                            |
| [Task](/use/tasks/)                      | A piece of work Otto is doing for you. The **Tasks** page shows each one with its status, such as working or needs you.                                                                                                                                                             |
| [Turn](/how-it-works/threads-and-turns/) | One run of Otto's work, started by your message, a schedule, a background check or your answer to a question. Your chat runs one turn at a time, while scheduled runs and background checks run alongside it.                                                                       |
| [Schedule](/use/schedules/)              | Work that runs at a set time or on repeat, such as every Friday at 5 pm. You set one up by asking Otto in plain words.                                                                                                                                                              |
| [Background check](/use/schedules/)      | Work Otto starts on its own when something happens in a connected app, such as a new email, once you've told Otto what's worth interrupting you for. Until then, Otto starts no run. It reads, drafts and does only what you told it to do on its own. Anything else waits for you. |
| [Memory](/use/memory/)                   | What Otto remembers about you from what you tell it. You can see and edit it in **Settings → Memory**.                                                                                                                                                                              |
| [Skill](/how-it-works/skills/)           | A built-in guide for one kind of work, such as travel, research or spreadsheets, or a learned skill Otto wrote after doing a task. Otto reads the one that fits the task.                                                                                                           |

## Otto's computer

| Term                             | What it means                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Workspace](/use/workspace/)     | Otto's private Linux computer, where it runs commands and keeps files. It never receives your model provider keys.                                |
| [Browser](/use/browser/)         | Otto's own web browser, separate from yours and from the workspace.                                                                               |
| [Browser handoff](/use/browser/) | When a website needs you, Otto sends an **Open browser** link to a live view of its browser. You take over, then select **Done** to hand it back. |

## Connections

| Term                                 | What it means                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Model connection](/connect/models/) | How Otto reaches a model: an OpenAI, Anthropic or OpenRouter API key, a ChatGPT or OpenRouter account, or a local model server. A paid provider bills you for use. |
| [Connected app](/connect/apps/)      | An account Otto can use for you, such as Gmail, Calendar or Slack.                                                                                                 |
| [Composio](/connect/apps/)           | The service Otto uses to connect many apps for you. Managed connections use an allowed Google account; you can also use a personal key.                            |
| [MCP](/connect/mcp-api-cli/)         | Model Context Protocol, a standard way for an app to offer tools to an assistant. Notion and Linear connect through their own MCP servers.                         |
| [Channel](/use/channels/)            | Another place to chat with Otto besides the app: Telegram or WhatsApp.                                                                                             |

## Safety and control

| Term                                                            | What it means                                                                                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Trust check](/trust/approvals/)                                | The server check that runs before every connected app action. It decides whether the action runs now or waits for you.                                                                                     |
| [Approval](/trust/approvals/)                                   | Otto's yes or no question about one exact action. If you reply yes, the action runs once.                                                                                                                  |
| [Standing instruction](/trust/approvals/#standing-instructions) | What you told Otto to do on its own when something arrives, such as "whenever Ana sends an invoice, forward it to accounting". Background work does it without asking. You see and change it in **Trust**. |
| [Vault](/trust/vault/)                                          | Otto's encrypted store for your saved logins, cards and browser sessions. The model never sees the saved values.                                                                                           |
| [Saved login](/trust/vault/)                                    | A website username and password in Vault. Otto enters it privately, and only on that exact website.                                                                                                        |
| [Saved browser session](/trust/browser-sessions/)               | A signed-in browser profile that Otto can reuse on the websites you allow.                                                                                                                                 |
| [Private form](/trust/vault/)                                   | A secure form where you enter a password, code or card for a task. What you type goes to the website, not to the model.                                                                                    |
| [Uncertain outcome](/trust/outcomes/)                           | An approved action that was interrupted, so Otto can't tell if it happened. Otto checks the result instead of running it again.                                                                            |

## Running Otto

| Term                                                  | What it means                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Owner access key](/get-started/install-from-source/) | The secret that opens a source install of Otto. The access link Otto prints when it starts saves it in your browser. |

## Related resources

- [What is Otto](/get-started/what-is-otto/)
- [Your first conversation](/get-started/first-conversation/)
- [Trust and Vault](/trust/)
- [How Otto works](/how-it-works/architecture/)
