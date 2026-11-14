---
title: Mobile Vault
description: Manage your server's saved logins, cards, and browser sessions from the Flutter evaluation client.
sidebar:
  order: 24
---

Mobile Vault manages the saved logins, cards, and browser sessions on your connected Nod server.

This is part of the [Flutter mobile evaluation](/contribute/mobile-evaluation/), not a separate password manager or a phone-hosted Vault. Your server keeps its existing encryption key, access checks, and activity records.

## Manage saved items

1. Open **Vault**.
2. Open an item to see its website, account, card metadata, or session status.
3. Select **Edit** to change a login or card. Leave replacement fields blank to keep saved secrets.
4. Select **Save**. If saving isn't confirmed, refresh Vault before trying again.

A login's website can't be changed by editing. Add a new login for a different website. To remove an authenticator key, select **Remove saved authenticator key** while editing.

**Show saved value privately** reveals a password or card number to you through the existing authenticated owner route. It never sends that value to chat or the model. The server records reveals. Select **Hide saved value** when finished.

Use **Copy username**, **Copy cardholder**, **Copy password**, or **Copy card number** to copy one field after a fresh item check. Copying a password or card number uses the same audited reveal route as the web app. Its activity record is a reveal, not a separate copy event. Copy doesn't display the secret in the page or send it through chat.

:::caution[The clipboard belongs to your operating system]
Copied values can be available to other apps, clipboard history, or cross-device sync. Nod doesn't read, automatically clear, or guarantee erasure of the system clipboard; once a write reaches the platform, closing or backgrounding Nod can't retract it.
:::

**Delete login** and **Delete card** ask you to confirm removal. An unreadable login can still be deleted without opening its secrets. **Sign out** removes a saved browser session, not its saved login.

When a session needs sign-in or hasn't finished signing in, select **Sign in again**. Nod checks the current session and sends your request through normal chat with that session's ID and website address. It opens chat without signing in automatically or skipping the normal private-entry and Trust checks. If the session changed, reopen it before continuing. A send that can't be confirmed leaves a notice in chat and is never retried automatically. Check the conversation before sending the request again.

## Add or import logins

Use **Add to Vault → Add login** or **Add card**. These private forms send values directly to the server's existing Vault routes. They don't send chat messages. Cards have no security-code field: payment approval is a separate private step.

To import passwords:

1. Select **Add to Vault → Import passwords**.
2. Select **Choose CSV file** and choose your password manager's export, smaller than 5 MB.
3. Review the number of logins, then select **Import**.
4. Review the imported, existing, and skipped counts. Delete the exported file afterwards because it isn't encrypted.

The parser supports Chrome, 1Password, and Bitwarden-style columns, quoted fields, usernames, and authenticator keys. Archived entries and rows without passwords are skipped. The server validates each login and authenticator key. A row with an invalid key is skipped rather than saved without that key. Passkeys and browser cookies aren't imported. The mobile client adds no Vault database or secret cache; your document provider can still retain the export or its temporary copies.

## Finish a task's private step

Select **Open private requests** for the existing [private-entry flow](/contribute/mobile-private-entry/). Saving a Vault item does not approve a pending sign-in or payment. Those requests remain bound to their own task, website, and server state.

1Password's helper runs beside your Nod server and needs the desktop 1Password app there. A phone connected to a remote server doesn't make its own 1Password app available to that server. The task's private **Sign in** request can use the server-hosted helper when available. This implementation doesn't add a phone-local 1Password integration.

## Review activity

Vault and each item's details show server-recorded activity. Select **Load more activity** for older entries. Login and session history is filtered by website; card history is filtered by the saved card. Card submission is not proof that a payment settled.

## Safety and evaluation limits

Unsent passwords, authenticator keys, and card numbers are cleared when a private editor closes or the app leaves the foreground. Revealed values are hidden on backgrounding. Delayed reveal results aren't displayed after that transition. Copy responses that arrive after backgrounding, disconnection, re-pairing, or leaving the view don't start a clipboard write. This is not a guarantee against operating-system screenshots, keyboard software, or a compromised device. Values already submitted can still finish on the server.

The feature binds its repository and editors to one connection generation. Re-pairing invalidates old operations. Before editing, revealing, copying, deleting, signing out, or requesting sign-in again, it checks the current target and available revision or session state. A changed or missing item is refused. These are client preflight checks, not an atomic revision lock: the existing Vault update routes don't offer compare-and-swap writes.

Focused tests use synthetic authenticated HTTP contract fixtures and widget lifecycle checks. They cover target changes, foreign or missing items, connection replacement during preflight, duplicate in-flight writes, secret clearing, late reveals, and sign-in requests fenced by session metadata, connection, foreground state, and view lifetime. Clipboard tests intercept synthetic platform-channel writes; they don't read the system clipboard. They don't run the full server, PostgreSQL owner isolation, a native clipboard or file picker, a real password manager, live sign-ins, or payments. Native and live checks remain separate evaluation gates.

## Related resources

- [Flutter mobile evaluation](/contribute/mobile-evaluation/)
- [Private entry on mobile](/contribute/mobile-private-entry/)
- [Vault and saved logins](/trust/vault/)
- [Saved browser sessions](/trust/browser-sessions/)
- [Payments](/trust/payments/)
