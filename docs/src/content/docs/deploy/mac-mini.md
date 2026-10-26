---
title: Host on a Mac mini
description: Keep a personal Nod server running on a Mac mini with Docker, persistent data, and access from your other devices.
sidebar:
  order: 4
---

Run the self-hosting stack on a Mac mini to keep Nod on your own hardware and reach it from other devices.

## Prepare the Mac

1. Install [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) for your processor, Apple silicon or Intel.
2. Give Docker enough memory and disk for Nod. Start with 8 GB of memory available to Docker and 50 GB of free disk. Keep capacity for macOS too.
3. In Docker Desktop, turn on **Start Docker Desktop when you sign in to your computer**. This setting starts Docker after sign-in, not before it. See [Docker Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/#general).
4. Keep the Mac awake while you want Nod to run. After a power loss or restart, sign in and confirm Docker and Nod have started.
5. Follow [Host your own server](/deploy/self-host/) using a dedicated folder for this installation.

The server's Linux containers run in Docker's virtual machine. Apple silicon uses the Linux ARM64 bundle; Intel uses Linux AMD64. This is the same stack used on a Linux server. You don't need to run Nod's local desktop assistant on the Mac mini too.

:::note[Desktop or server]
The desktop app's local assistant and the self-hosting stack have separate data. Connecting the desktop app to your server does not copy its local conversation or saved accounts.
:::

## Connect from other devices

For public access, use a domain and HTTPS as described in the [server guide](/deploy/self-host/). Your router must forward ports 80 and 443 to the Mac. Some home internet connections block incoming traffic or use carrier-grade NAT.

For private access, open an [SSH tunnel](/deploy/self-host/#open-a-remote-server-without-a-domain) to the Mac, directly or over your VPN. Alternatively, run an [HTTPS reverse proxy](/deploy/self-host/#use-an-existing-proxy) reachable over the VPN and set `NOD_PUBLIC_URL` to its exact HTTPS origin. A VPN alone does not expose the stack's loopback port or provide the HTTPS required for a remote origin. Keep token authentication enabled on private networks too.

The desktop app connects with the same server address and token as the web app. Nod keeps working on the Mac mini after you close the app on your other device.

Telegram and the WhatsApp QR connection use outbound connections and can work without opening your router. Meta's WhatsApp Cloud API needs a public HTTPS webhook. See [Telegram and WhatsApp](/use/channels/).

## Keep data recoverable

Use the [server backup procedure](/deploy/server-operations/#back-up) before an update or a macOS reinstall. Back up the installation's secrets and volumes together. Copying the repository alone does not save your assistant.

After a restore, confirm access, saved settings, workspace files, and channels before starting new work. A restored old backup can contain old schedules and channel state.

## Related resources

- [Deploy and operate](/deploy/)
- [Host your own server](/deploy/self-host/)
- [Back up and update a server](/deploy/server-operations/)
- [Install the desktop app](/get-started/install-desktop/)
