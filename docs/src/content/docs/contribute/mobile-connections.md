---
title: Manage mobile connections
description: Manage connected accounts and private app and channel configuration in the Flutter evaluation client.
---

The native connections panel manages saved app accounts, MCP setup, n8n setup, Telegram, and linked-device or Cloud API WhatsApp configuration through your paired Nod server.

This is part of the [Flutter evaluation client](/contribute/mobile-evaluation/), not a supported mobile release. The server still decides account ownership, connection availability, and permissions.

## Manage an account

Open **Manage connections** from the app's connections entry. Search for an app to see its saved accounts.

- Select **Reconnect** beside the account you intend to reconnect. The request names that saved account, not just the app.
- Select **Add account** to request another connection. It does not remove the existing account.
- Select **Disconnect**, review the named account, and confirm. Nod removes that connection and its source-linked private work. Other accounts stay connected.
- Pull to refresh after a network interruption. A failed removal is not treated as successful or retried automatically.

You can also revoke access in the service's own settings. Removing a connection does not erase your conversation.

## Connect an MCP server or n8n

1. Select **Connect MCP**.
2. Enter its name and public HTTPS server URL.
3. Choose **Browser sign-in**, **Access token**, or **API key**. If required, enable **Server requires a client ID**.
4. Select **Continue**, review the connection details, and finish authentication.

For n8n, select **Connect** on its app entry. Enter the instance address as reached by your Nod server. Use its browser consent screen or enter an access token in the private form. A prefilled local address does not connect until you select **Connect n8n**.

Tokens go in authenticated request bodies to your Nod server. They do not enter chat or launch URLs. Private token fields clear after each submission and when the panel closes. The server verifies the access path before saving it.

Existing HTTP API connections use the same private setup panel when reconnecting. Their details include the endpoint, authentication method, and read check. Creating a new HTTP access path still starts with Nod's discovery flow in chat; the server has no manual HTTP creation route.

## Finish browser sign-in

Select **Open sign-in**, review the service's permissions, then return to Nod. Polling pauses while the app is backgrounded and checks again when you return. Only the server's completion result marks an account connected.

Select **Cancel** to abandon the exact sign-in link. If cancellation cannot be confirmed, the panel stays open so you can retry. An expired or replaced link does not count as success. Start again when offered, or close the setup and connect again. Starting again uses the server's current attempt binding.

External sign-in addresses must use HTTPS, without embedded credentials or token query parameters. An HTTP n8n consent address is allowed only for the instance host and port you explicitly entered. This does not relax the paired server's certificate or origin checks.

## Set up Telegram

1. Open **Telegram**.
2. Enter your BotFather token in the private field, then select **Connect bot**.
3. Select **Open Telegram pairing** and send Start in Telegram.
4. Return to Nod, review the candidate's name and ID, then select **Confirm my account**.

Use **Start pairing again** when the pairing expires. **Use this user ID** is the alternative to the pairing link. No account is confirmed from a locally selected label alone. A bot using a webhook needs the matching server setup; polling is the default.

## Link WhatsApp with a QR code

1. Open **WhatsApp** and choose **Separate bot number** or **Use my own number**.
2. For a bot number, register a second WhatsApp account. Enter your personal number with the country code, using digits only.
3. Read the account restriction warning and **Read WhatsApp terms**, then select the policy checkbox.
4. Select **Show QR code**. In WhatsApp, open **Settings → Linked Devices → Link a Device** and scan the code from another screen.
5. Wait for the server to confirm the connection. For your own number, use **Message yourself**. For a bot, message its linked number from your personal account.

The QR code is rendered locally, without a third-party image service. Its payload stays in the private panel, not chat, logs, launch URLs, or shared files. Codes hide when they expire, when a status check fails, while the app is backgrounded, and after scanning. Returning to Nod refreshes the server status before showing another code.

The setup lasts five minutes. Select **Start again** after expiry, a failure, or a sign-out. Renewal uses the current pairing ID; an old status response cannot restore its code. Closing an unfinished setup cancels that exact pairing. If cancellation fails, the panel stays open for a retry. Closing a connected panel keeps the account connected.

Select **Disconnect**, then confirm, to remove the linked device. You can also remove Nod in WhatsApp's **Linked Devices** settings. A server-managed link allows scanning and renewal, but not editing or removal here.

## Set up WhatsApp Cloud API

Select **Use Meta Cloud API instead** before starting QR setup. Enter the business phone number ID, your personal number, access token, Meta app secret, and webhook verification token. Read and accept the policy statement, then select **Save Cloud API setup**. Configure the matching callback and verification token in Meta and subscribe to messages.

Cloud API mode needs a public HTTPS callback. It replies only within 24 hours of your last message and is not the linked-device QR connection.

Select **Use linked-device QR instead** to return to linked-device setup. Changing modes is a new explicit setup, not an automatic fallback.

Server-managed channels show their status but cannot be edited or disconnected here. Change their environment configuration on the server.

:::caution[Remaining evaluation limits]
QR rendering and lifecycle checks use synthetic data. Scanning on physical devices, browser sign-in on a phone, and real app or channel delivery still need separate runtime validation.
:::

## Check the native contracts

From `clients/flutter`, run:

```sh
flutter test test/api/connections_management_repository_test.dart
flutter analyze lib/core/connections_management.dart lib/api/connections_management_repository.dart lib/features/connections test/api/connections_management_repository_test.dart
```

These synthetic checks cover paired bearer requests, exact-account removal and reconnect, private configuration bodies, hashed cancellation, and foreground completion, expiry, and cancellation. Linked WhatsApp checks cover policy consent, both modes, QR expiry and hiding, exact-pairing renewal and cancellation, stale responses, managed channels, and confirmed disconnect. They do not call a connected account, run the full server, or prove native browser callbacks or real channel delivery.

## Related resources

- [Try the Flutter client](/contribute/mobile-evaluation/)
- [Connect apps](/connect/apps/)
- [MCP servers, APIs and CLIs](/connect/mcp-api-cli/)
- [Telegram and WhatsApp](/use/channels/)
