---
title: Private entry in the Flutter client
description: Use and check the evaluation client's server-backed private sign-in, payment, and browser handoff surfaces.
---

The Flutter evaluation client can collect private sign-in details and payment approvals without sending them through chat.

Use the matching evaluation server and authenticated connection described in [Try the Flutter client](/contribute/mobile-evaluation/). These forms use the server's existing Vault requests. They don't create a second trust checker or store passwords on the phone.

Opening a request from its original chat link keeps that exact request, even when it is older than recent chat. Payment links use the same private path. If a browser view disconnects, controls stop and queued inputs that haven't been sent are discarded. Reconnect to inspect the page; Nod doesn't repeat an input whose result is uncertain.

## Complete a private sign-in

1. Tap the info icon in the conversation's top bar (**Private entry and browser**), open **Private entry** from the menu, or open a task's private action.
2. Select **Private sign-in** and check the complete website origin.
3. Select an offered sign-in method or saved login. To enter another account, select **Use another login**.
4. Enter the requested account, password, or verification code. Select **Save and continue** or **Continue**.
5. Keep the form open for another step from the same sign-in flow, or return to the conversation.

Field labels and method choices come from the server's bound request, not from page parsing in Flutter. The server decides which saved logins fit. A completed request follows only the successor returned by the server's same-flow endpoint.

When the server offers a password manager, **Use 1Password on the Nod server** lists matching logins through that server's helper. Approve access on the computer running Nod. This doesn't connect the phone's 1Password app to Nod. See [Use a login from 1Password](/trust/vault/#use-a-login-from-1password).

Closing the form or putting the app in the background clears unsent values. Closing doesn't cancel a submission that already reached the server. Use **Stop** on the owning task to stop its work.

## Approve one payment

1. Open **Approve payment**.
2. Check the shop origin, amount, selected card, and every card-field destination.
3. Enter the card's security code and select **Pay** with the displayed amount.
4. Return to the conversation for Nod's check of the shop's result.

**Card submitted is not paid.** The server claims the exact request once and resumes its own task. Flutter never posts a chat message containing the code.

An interrupted or uncertain submission isn't retried automatically. Reopening reads its current status. For an uncertain sign-in, **Request a fresh sign-in step** asks the server for a new step. It never resubmits the old entry. An uncertain payment requires checking the order before another attempt.

## Take over Nod's browser

1. Open **Open browser** on the waiting request or task.
2. Tap or drag on the live page. Use the private text field to type into the selected website field.
3. Use **Tab**, **Enter**, **Backspace**, the scroll buttons, **Back**, or **Reload** as needed.
4. Select **Return to Nod** when finished.

The view streams images from Nod's existing browser over the authenticated connection. Pointer positions are relative to the displayed image, not the surrounding screen. No local browser is launched, and no authentication token is placed in a URL.

Inputs are sent in order. **Return to Nod** waits for pending input, then resumes the bound handoff turn without posting an owner message. A failed input isn't replayed. **Reconnect view** reopens only the view; inspect the page before repeating an action. Backgrounding clears typed text and closes the view stream.

## Check the private surfaces

Run from `clients/flutter` after fetching dependencies in that checkout:

```sh title="Terminal"
flutter test test/private_requests --reporter expanded --timeout 15s
flutter analyze lib/core/private_requests.dart lib/api/private_requests_repository.dart lib/features/private_requests test/private_requests
```

The focused suite uses synthetic request state, generated input, image frames, and a disposable loopback HTTP fixture. It checks replacement refusal, status refresh, same-flow continuation, clearing on close and backgrounding, duplicate prevention, uncertain results, and ordered browser input before Done.

The HTTP check uses the real Flutter HTTP repository with synthetic server routes. It doesn't start Nod's full server, a database, a model, a connected account, a checkout, or 1Password. Browser widget checks use complete image frames; authenticated binary-frame decoding is checked separately with the shared HTTP transport.

:::caution[Evaluation limits]
These checks aren't native-runtime or live-service validation. Phone keyboard behavior, small-screen browser interaction, server-hosted password-manager approval, and real sign-in or payment outcomes still need separate evaluation.
:::

## Wire a feature entry

`NodPrivateRequestsPage` takes the shared `NodApiTransport`. An optional `initialRequest` opens an exact private request from a task action. Without it, the page discovers relative private actions in the current conversation and waiting browser handoffs.

The shared HTTP repository must also implement `NodPrivateBrowserTransport` to provide complete encoded image frames. The private feature doesn't receive bearer credentials or open an unauthenticated fallback. Navigation and shared transport wiring belong to the central Flutter shell.

## Related resources

- [Try the Flutter client](/contribute/mobile-evaluation/)
- [Vault and saved logins](/trust/vault/)
- [Payments](/trust/payments/)
- [Nod's browser](/use/browser/)
