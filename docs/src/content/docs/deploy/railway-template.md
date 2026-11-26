---
title: Deploy on Railway with a template
description: Use a community Railway template that runs Nod's server, workspace, browser, and database as Railway services, with its test scope and limits.
sidebar:
  label: Railway template (community guide)
  order: 7
---

Use this community template to run Nod on [Railway](https://railway.com/) as ordinary services, with a public HTTPS address and no VM to manage.

:::note[Contributor-tested setup]
The template's maintainer reported deployment and agent checks on 2026-11-17 with Nod `nod-v0.8.3`.
The report does not establish long-term reliability or complete the operating checks below.
:::

## How the template differs from the Docker stack

Nod's server drives its workspace and browser containers through `docker exec`, over a filtered Docker socket. Railway services have no Docker socket, so a plain Railway service can't run Nod's workspace or browser.

The [template source](https://github.com/hmseeb/nod-railway-template) builds Nod's own Dockerfiles at a pinned release and adds a small exec relay:

- The server image replaces the `docker` CLI with a shim. The shim forwards only the two `docker exec -i` forms that Nod uses.
- The workspace and browser services each run a relay agent as root on Railway's private network. The agent checks a shared token, applies the allow rules from [`docker-proxy.mjs`](https://github.com/n8n-io/nod/blob/main/deployment/self-host/docker-proxy.mjs), and runs the command as the same user it would run as in Docker.
- Commands get a fixed environment. The relay token and Railway's variables never reach them.

The project has four services:

| Service   | What it runs                              | Volume                     |
| --------- | ----------------------------------------- | -------------------------- |
| Nod       | The server and web app, with a public URL | `/var/lib/nod`             |
| Workspace | The Linux workspace and the relay agent   | `/workspace`               |
| Browser   | Chromium and the relay agent              | `/data`                    |
| Postgres  | The database                              | `/var/lib/postgresql/data` |

:::caution[No workspace egress firewall]
The Docker stack's firewall blocks private network addresses from the workspace. It needs `NET_ADMIN`, which Railway doesn't grant. On Railway, workspace commands can reach the project's private network. Every service there needs a token or password. Don't add services without authentication to this project.
:::

## Check the cost

Pricing checked on 2026-11-17. Check Railway's current [plans and resource prices](https://docs.railway.com/pricing/plans) before deploying.

The template needs four volumes, so it needs the Hobby plan or higher. Trial projects allow three volumes, and Free projects allow one.

Railway charges a monthly plan fee plus the CPU, memory, egress, and volume storage the services use. The Hobby plan costs US$5 per month and includes US$5 of usage.

One lightly used deployment ran for about 25 hours. It averaged 0.08 vCPU, 3.3 GB of memory, and 7.2 GB of volume storage. At the checked rates, that's about US$35 per month, mostly for memory. This is one measurement, not a Nod requirement. Browser tasks raise memory use. Model providers charge separately.

## Deploy Nod

1. Open the [Nod template](https://railway.com/deploy/nod) and select **Deploy Now**. No variables need values. The template generates the access token, the Vault seed, and the relay token.
2. Wait until all four services are running. The first deployment takes a few minutes.
3. Open the **Nod** service, go to **Variables**, and copy `NOD_AUTH_TOKEN`.
4. Open the Nod service's public URL and enter the token. Finish onboarding to connect a model.

The address is public. Nod's server token controls access. Only the Nod service has a public domain. Don't add public domains or TCP proxies to the workspace, browser, or Postgres services.

To use the desktop app, choose **Connect to a server** and enter the Railway URL and `NOD_AUTH_TOKEN`.

If you add a custom domain, set `NOD_PUBLIC_URL` on the Nod service to the new `https://` address and redeploy it.

## Keep the Vault seed

The template derives Nod's Vault key from `NOD_VAULT_SEED` on the Nod service. Keep a copy outside Railway. If the seed changes, Nod can't read saved passwords and keys, and a database backup can't recover them.

## What the maintainer checked

The maintainer's report names Nod `nod-v0.8.3` (commit `36458072`) and one new deployment. It reports:

- All four services started and stayed healthy.
- One model connection completed a turn that ran a workspace command, saved a file, showed its contents, and read a page in the browser.
- Nod's process stop program, run by hand through the relay as the `node` user in `/var/tmp`, stopped a leftover workspace process. Nod runs this program after an uncertain command.
- The relay refused a working directory outside the workspace.

The template's relay tests cover stdio, exit codes, the token, the working directory and command rules, and the command environment.

The report does not include the operating checks below.

## Check unattended operation

Use synthetic data to check the server before you rely on unattended work:

1. Create a test schedule. Close all clients and check that it runs after several idle hours.
2. Redeploy each service. Check that conversation history, files, signed-in browser sessions, and schedules remain available.
3. Back up and restore. Railway [volume backups](https://docs.railway.com/volumes/backups) snapshot one service's volume at a time. Nod's [backup procedure](/deploy/server-operations/#back-up) assumes the Docker stack and isn't verified on this template.

Keep a backup outside Railway. Deleting a project deletes its volumes and their backups after Railway's grace period.

## Update Nod

The template pins Nod's release in each image tag, so a redeploy doesn't change the version. Each Nod release needs its own template images. Check the [template source](https://github.com/hmseeb/nod-railway-template) for the current tag, then change the image tag on the Nod, Workspace, and Browser services to match. Back up first.

## Remove a disposable installation

Make a backup and copy it outside Railway before removing the project. In the project's **Settings**, select **Delete Project**. Check **Usage** for remaining charges.

## Related resources

- [Choose a cloud server](/deploy/providers/)
- [Host your own server](/deploy/self-host/)
- [Back up and update a server](/deploy/server-operations/)
- [Deploy on boxd](/deploy/boxd/)
