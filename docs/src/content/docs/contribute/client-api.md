---
title: Connect an external client
description: Discover the authenticated HTTP contract without depending on a client source checkout.
sidebar:
  order: 20
---

External clients connect to Nod over its existing HTTP and server-sent event routes. Nod does not need a Flutter SDK, mobile build scripts, or a client checkout.

## Discover the contract

Send `GET /api/client/capabilities` with the owner's configured `NOD_AUTH_TOKEN` as a bearer token. The normal host, origin, and cross-site guards run before discovery. The endpoint is unavailable on cookie-only or desktop installations; it is registered only when bearer access is enabled. Cookie-only access does not enable discovery. A valid token is never returned in its response.

The response is a small compatibility gate:

```json
{
  "contractVersion": 1,
  "authentication": { "mode": "bearer" },
  "features": { "attachments": true }
}
```

Reject an unsupported contract before sending work. Use the fixed routes below; discovery does not configure endpoint paths or error handling. A supported version does not prove that a client supports every feature-specific route or presentation.

Native connections need bearer authentication even on loopback. Use the exact origin configured by `NOD_PUBLIC_URL`. Existing private account writes still need that origin; do not remove origin checks to accept a native client. Use HTTPS outside the supported loopback development path. Never place owner tokens in build defines, URLs, logs, or test fixtures.

## Core routes

| Purpose                     | Method | Path                       |
| --------------------------- | ------ | -------------------------- |
| Discovery                   | GET    | `/api/client/capabilities` |
| Session                     | GET    | `/api/session`             |
| State                       | GET    | `/api/state`               |
| History and message context | GET    | `/api/messages`            |
| Events                      | GET    | `/api/events`              |
| Send                        | POST   | `/api/messages`            |
| Stop                        | POST   | `/api/thread/stop`         |

Feature clients also use existing routes for tasks, private entry, account settings, files, audio, and other supported workflows. Discovery does not duplicate these server implementations or grant permission for actions.

## Change the contract safely

The discovery response lives in `src/server/client-api.ts`. Existing shared response types and route input validators remain authoritative; there is no separate client-specific schema layer. Preserve server authorization and validation. Review semantic or required-field changes for compatibility and update the version when they break the supported core protocol. Additive response fields need not break clients.

Run `pnpm exec tsx --test tests/client-api.test.ts tests/accounts.test.ts` and `pnpm run lint` for focused checks. Discovery tests exercise the real access guard; account tests separately check origin fencing and privacy changes. Database-backed bootstrap assertions in `tests/channel-application.test.ts` check real route responses; run them only with the documented isolated integration harness and disposable database.

A client repository keeps its own parsers and fixture tests. Neither repository imports the other's files. Before sharing a client build, test the exact server and client versions together with disposable data. Fixture parsing and discovery tests alone do not prove end-to-end feature parity.
