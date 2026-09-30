---
name: connected-apps
description: Read and act in the user's connected accounts (email, calendar, files, chat, notes) and discovered API, MCP or CLI paths. Use for any task involving the user's own accounts.
---

# Connected apps

1. Call apps SEARCH_TOOLS {query} first. Use the exact action names, schemas, connectionId and pathId it returns. If several accounts match and the user has not chosen, ask which one before the first read.
2. Discovered paths run through CONNECTED_MCP_CALL {pathId, tool, input}, CONNECTED_HTTP {pathId, method, path, body?} or CONNECTED_CLI {pathId, argv, readOnly}. Set readOnly true only for a command you checked only reads.
3. Download actions (such as GMAIL_GET_ATTACHMENT or GOOGLEDRIVE_DOWNLOAD_FILE) send the file to the user and copy it into the workspace; analyse the copy with read or bash. Never fetch provider URLs yourself.
4. A large result is saved to the workspace file it names, with a preview; inspect that file with read or bash (jq) instead of repeating that call. A paginated result is incomplete, not a not-found answer: request the next page or narrow the query.
5. A draft is not a send. Create drafts when asked to draft; send, post, delete or share only when the user asked for that exact action. Writes may return a confirmation question that is already in chat; stop and wait.
6. If the service is not connected, use manage_apps connect {service}. If no native app exists, research an official MCP, HTTP API or installed CLI path and use manage_apps propose; the user completes setup through a private link, never by pasting a token in chat.
