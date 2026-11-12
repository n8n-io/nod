---
title: Deploy on boxd
description: Use a community deployment guide to run Nod on boxd, with managed HTTPS, continuous operation, and external backups.
sidebar:
  label: boxd (community guide)
  order: 6
---

Use this community guide to run Nod on a persistent [boxd](https://boxd.sh/) VM with its own HTTPS address.

:::note[Contributor-tested setup]
A contributor who works on boxd reported installation and access checks on 2026-11-11.
The report does not establish long-term reliability or complete the operating checks below.
:::

boxd machines use Ubuntu 24.04 and include Docker Engine, Compose, and a persistent 100 GB disk. This setup starts with two vCPUs and 8 GiB RAM. Browser tasks and local models can need more capacity.

## Check the cost

Billing checked on 2026-11-12. Check the current [rates and calculator](https://boxd.sh/pricing) before creating a machine.

boxd charges for active CPU, used RAM, and written disk space. This setup disables automatic sleep so Nod can run schedules at any time. Select 24 hours of running time per day in the calculator.

At the checked rates, boxd estimates €24.38 per month for 0.2 active vCPU, 2 GiB used RAM, and 20 GiB written disk. Its listed maximum for a machine with 2 vCPU, 8 GiB RAM, and 100 GiB disk is €132.86 per month. These figures exclude VAT and are not measured Nod costs. Model providers charge separately.

boxd continues to charge for written disk space when a machine is stopped or hibernated. Stopping Nod does not end hosting charges.

Adding a payment method gives €30 credit. When that credit runs out, automatic top-up adds €20 from the card. Review or disable automatic top-up under **Billing** before a disposable test.

## Install Nod

1. [Install the boxd CLI](https://docs.boxd.sh/cli/installation) on your computer and sign in with `boxd auth login`.
2. Pick a unique machine name. Replace `<name>` in each command with that name. Create a machine with two vCPUs and 8 GiB RAM:

   ```sh title="Your computer"
   boxd machine new <name> --vcpu=2 --isolated --auto-suspend-timeout=0 --auto-hibernate-timeout=0
   ```

   `--isolated` keeps boxd's CLI and credentials off the machine and removes its default access to your other boxd machines. The two timeouts disable automatic suspend and hibernate, so Nod can run when no client is open.

   The command prints the machine's address as `url`: `<name>.boxd.sh`, or `<name>.nyc.boxd.sh` in New York. `boxd machine get <name>` shows it again.

3. Run `boxd connect <name>` and follow steps 1 and 2 of [Build from source](/deploy/self-host/#build-from-source). Before step 3, set these values in `.env`. Replace `<machine-url>` with the exact `url` from boxd:

   ```sh title=".env"
   PORT=8000
   NOD_BIND_ADDRESS=0.0.0.0
   NOD_PUBLIC_URL=https://<machine-url>
   ```

   Then run step 3. Skip step 4's SSH tunnel.

4. Open the machine's HTTPS address and enter `NOD_AUTH_TOKEN` from `.env`. Finish onboarding to connect a model.

boxd's [HTTPS proxy](https://docs.boxd.sh/guides/https) detects the service on port 8000 and serves it at the machine's address. Keep Nod's `https` profile off. This setup needs no separate domain or inbound firewall rule.

The address is public. Nod's server token controls access. Keep PostgreSQL, the browser, the workspace, and the Docker API private. Do not add public port forwards for them.

## What the contributor checked

The [contributor's report](https://github.com/n8n-io/nod/pull/733) names Nod commit `d82e06ef` and two machines with different names. It reports:

- The source build completed and the containers were healthy.
- Each HTTPS address opened Nod. API access without a token returned HTTP 401.
- Each machine accepted its own server token. A token from one machine did not open the other.
- One model connection completed a workspace command.
- Port 8000 did not answer on the public IP.

The report does not include the operating checks below.

## Check unattended operation

Use synthetic data to check the server before you rely on unattended work:

1. Run a browser task and check that chat output arrives while the task runs.
2. Create a test schedule. Close all clients and check that it runs after several idle hours.
3. Restart the VM. Check that the containers start again and that conversation history, files, and schedules remain available.
4. Follow Nod's [backup procedure](/deploy/server-operations/#back-up) and restore into a fresh installation. Keep the original server stopped while you check the restored data and schedules.

Keep an encrypted backup outside the machine. A persistent disk alone does not provide a recoverable backup.

## Remove a disposable installation

Make a backup and copy it outside the machine before removing it. Check that you can restore the backup.

On your computer, run this command only when you intend to delete the machine and its disk:

```sh title="Your computer"
boxd machine remove <name> -y
```

Remove any separately retained resources you no longer need. Check **Billing** for remaining charges and the automatic top-up setting.

## Related resources

- [Choose a cloud server](/deploy/providers/)
- [Host your own server](/deploy/self-host/)
- [Back up and update a server](/deploy/server-operations/)
