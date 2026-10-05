# Cloudflare deployment

The public Worker serves `dist/web` and sends `/api/*` to one private Node gateway. The gateway authenticates Google sessions, provisions a tenant SQL role and schemas per user, and sends signed requests to that user's tenant container. Each owner also gets separate browser and workspace containers that start on first use and checkpoint to private R2 when idle. Provider keys stay in the Node runtime.

| Class                        | Image tag                            | Instance type | Development max | Production max |
| ---------------------------- | ------------------------------------ | ------------- | --------------- | -------------- |
| `GatewayContainer`           | `otto-<environment>:<SHA>`           | `basic`       | 1               | 1              |
| `TenantContainer`            | same runtime image                   | `basic`       | 8               | 100            |
| `BrowserComputerContainer`   | `otto-<environment>-browser:<SHA>`   | `standard-4`  | 8               | 100            |
| `WorkspaceComputerContainer` | `otto-<environment>-workspace:<SHA>` | `basic`       | 8               | 100            |

Production uses `OTTO_MAX_USERS=100` in `GATEWAY_ENV`. The default remains 8 for other deployments, with a maximum of 400. Admission must match the container limits; raise them together with database connections and budget.

**This release has no migration path from the task model. Every existing environment must be reset (see [Database reset](#database-reset)) before deploying it.**

## Checks

```sh
npm ci && npm run build
npm --prefix deployment/cloudflare ci
npm --prefix deployment/cloudflare run check
npm --prefix deployment/cloudflare test
cd deployment/cloudflare
npx wrangler deploy --env development --dry-run --containers-rollout=none
npx wrangler deploy --env production --dry-run --containers-rollout=none
```

Dry runs validate bundling and configuration only.

## Local hosted development

Create a private `.env.hosted.local` (mode 600) with a dedicated development database reachable from Docker, fresh random 32-byte `OTTO_MASTER_KEY` and `BETTER_AUTH_SECRET`, `OTTO_ENVIRONMENT=development`, Google OAuth client ID/secret (redirect `http://localhost:4330/api/auth/callback/google`), and model/Composio keys. See `deployment/hosted.env.example`. Then:

```sh
npm run build
npm --prefix deployment/cloudflare ci
node scripts/start-hosted.mjs --check
node scripts/start-hosted.mjs
```

The app runs at `http://localhost:4330` with local R2 emulation. Ctrl-C drains work and stops safely; if a stop is refused, run `node scripts/start-hosted.mjs --resume`. Run only one Wrangler container stack at a time. Rebuild `dist/web` after UI edits.

## Environments and secrets

`wrangler.jsonc` defines separate `development` and `production` Workers, Durable Objects, EU R2 buckets and container applications. Keep development and production databases, keys, Google clients and Composio projects separate. Use a dedicated PostgreSQL database: provisioning changes default grants.

Each environment has one `GATEWAY_ENV` Worker secret: compact JSON of the gateway's server environment (`DATABASE_URL`, `OTTO_MASTER_KEY`, `COMPUTER_PROVIDER` (`cloudflare`, or `e2b` with `E2B_API_KEY` and `E2B_COMPUTER_TEMPLATE`), `OBJECT_STORAGE_PROVIDER=http`, `OBJECT_STORAGE_ENDPOINT=http://otto.storage/v1/objects/`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, model and `COMPOSIO_*` keys, optional `OTTO_MAX_USERS`, `OTTO_DEVELOPER_IDS`, `DEV_INSPECTOR`). It must stay under 5 KiB. Never put secrets in build arguments, Vite variables or Wrangler `vars`. Treat `OTTO_MASTER_KEY` as recovery material: replacing it invalidates tenant credentials and encrypted data. Secret changes take effect only through a new release rollout.

Privacy notice: operators write their own public Markdown notice to `public/privacy-notice.md` (the build copies it to `dist/web/privacy-notice.md`) and set `OTTO_PRIVACY_NOTICE_FILE=dist/web/privacy-notice.md` in `GATEWAY_ENV`. It is served at `/privacy`. Without the setting there is no notice; an unreadable or invalid file fails startup. Verify `/privacy` signed out and set it as the Google OAuth privacy-policy URL before inviting users.

PostHog product analytics and masked session recordings use the public project key embedded in the app. They default to enabled for the `production` deployment and disabled for other environments, including staging. Set `OTTO_ANALYTICS_ENABLED=false` in `GATEWAY_ENV` to disable both browser recording and server events, or `true` to inspect a development deployment. `OTTO_ANALYTICS_ENVIRONMENT` optionally overrides the `production` or `development` event label. The gateway passes both settings to every tenant. Changes require a release rollout. Include these practices in the operator privacy notice; see [Analytics](../../docs/analytics.md) for captured events and masking boundaries.

## Storage bootstrap

Each environment needs exactly one private EU R2 bucket bound as `TENANT_FILES`. Create it once with a separate operator token (`CLOUDFLARE_R2_OPERATOR_TOKEN`, Workers R2 Storage Edit):

```sh
npm --prefix deployment/cloudflare run provision:storage -- development
npm --prefix deployment/cloudflare run provision:storage -- production
```

## CI and rollout

`.github/workflows/ci.yml` runs root checks, PostgreSQL tests, the build, this package's checks and tests, both dry runs and the image builds. `.github/workflows/deploy.yml` runs after successful CI on the current `main` commit, in the GitHub `production` environment, which needs:

| Kind     | Name                    | Value                                                   |
| -------- | ----------------------- | ------------------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`  | Deployment token (Workers publish/settings, Containers) |
| Secret   | `CLOUDFLARE_ACCOUNT_ID` | Account ID                                              |
| Secret   | `GATEWAY_ENV`           | Production gateway JSON                                 |
| Variable | `OTTO_PUBLIC_URL`       | Canonical HTTPS origin                                  |

`scripts/deploy.mjs production` then:

1. Pushes all three images and resolves their digests.
2. Closes a durable admission barrier (authorized by an HMAC derived from `OTTO_MASTER_KEY`).
3. Drains each tenant naturally, then requires clean browser/workspace checkpoints and confirmed stop of each exact generation. Active holds, uncertain state or an expired deadline block the deploy; nothing is force-cancelled.
4. Publishes Worker code, image references and `GATEWAY_ENV` together with `wrangler deploy --secrets-file`.
5. Verifies every container application's image and rollout, the R2 binding, and a public smoke test, then reopens admission.

Deploying the SHA already in production is refused; configuration changes need a new release. A manual development deploy uses `npm --prefix deployment/cloudflare run deploy:development` with locally built `linux/amd64` images and development configuration.

## Recovery and rollback

If a deployment is interrupted, check out the same target release, load the same private environment with `OTTO_RELEASE` set to that SHA, and run:

```sh
node deployment/cloudflare/scripts/recover.mjs production status
node deployment/cloudflare/scripts/recover.mjs production abort     # only before activation
node deployment/cloudflare/scripts/recover.mjs production complete  # only after activation
```

A failed or expired deployment never reopens automatically. Do not delete the barrier, substitute a nonce or clear a fence to get past a failure.

Before a rollback, confirm the previous code supports the current SQL schema, Durable Object classes, checkpoint format and keys, and stop the current tenant and computer generations. Worker rollback does not revert PostgreSQL, R2 or completed external actions; prefer a forward fix.

## Database reset

A reset removes every account and its data from one environment. It is required when deploying this release over any database created by the task model. It is separate from the in-app Get started action, which only archives the owner's thread.

1. Confirm the exact origin, database, bucket, provider projects and release. Keep the deployment, OAuth clients, provider keys, Composio auth configs and `OTTO_MASTER_KEY`.
2. Close admission and stop work with the deployment barrier (as in a rollout) and confirm every tenant and computer generation is physically stopped. Keep the gateway from restarting during the reset.
3. Remove external resources while their identifiers are still readable: unregister each user's Telegram webhook, delete their Composio triggers, sessions and connected accounts, and revoke direct OAuth grants.
4. Delete R2 objects under `<environment>/<owner>/` (`artifacts/`, `sessions/`, `computers/`) and abort incomplete multipart uploads.
5. In PostgreSQL, drop every tenant app/jobs schema and tenant role, delete Better Auth users, accounts, sessions, verification rows and account settings, and clear the tenant registry and channel claim records. Keep the auth and control table definitions.
6. Verify zero users, sessions, tenant schemas, roles, registry rows and owner objects. Keep a counts-only record; never log user content or credentials.
7. Reopen admission with the same deployment operation, then check `/api/health`, that anonymous sessions have no access and that old sessions are rejected.

If a provider or database call fails mid-reset, keep admission closed and re-verify before retrying. Provider backups and logs are outside this procedure.
