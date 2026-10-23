---
title: Back up and update a server
description: Back up a self-hosted nod server, restore into a fresh installation, update it, and rotate its access token.
sidebar:
  order: 5
---

Keep your server configuration and data together, and make a backup before updating nod.

Run the commands below from `nod/deployment/self-host`. If you use the HTTPS profile, include `--profile https` in Compose start, stop, and status commands.

## Check and stop the server

```sh title="Terminal"
docker compose ps
docker compose logs --tail 100 server
```

To stop the stack without deleting data:

```sh title="Terminal"
docker compose stop
```

Start it again with `docker compose up -d --wait`. Don't use `docker compose down --volumes` or delete the installation's volumes unless you intend to remove its data.

## Back up

Wait for active work to finish. Keep your configuration in `.env`, remove shell overrides, and restart after configuration changes before making a backup. Backup and restore refuse `NOD_ENV_FILE` overrides in either the shell or saved configuration; they preserve the installation's `.env` only.

Choose a new backup directory whose parent already exists:

```sh title="Terminal"
sh backup.sh /absolute/path/to/nod-backup-2026-10-23
```

The command stops the server, browser, and workspace while it copies data. It resumes only the services that were running beforehand, including if the backup fails.

| Backup item              | What it preserves                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `.env`                   | Server access token, Vault key, database password, and your environment settings.             |
| `postgres.dump`          | A logical PostgreSQL backup of conversations, settings, schedules, and encrypted credentials. |
| `server-data.tar.gz`     | Server state, transcripts, and local profile data.                                            |
| `workspace-data.tar.gz`  | Files created in nod's workspace.                                                             |
| `workspace-tools.tar.gz` | Installed workspace tools and their files.                                                    |
| `browser-data.tar.gz`    | Browser profiles and saved browser state.                                                     |
| `source-commit`          | The source checkout revision to restore before starting nod.                                  |
| `complete`               | The marker required by the restore command.                                                   |

The destination must not exist. The command creates private files and refuses a custom `DATABASE_URL`. For an external database, coordinate its backup with copies of the four data volumes while nod is stopped.

:::danger[The backup contains secrets]
Store it encrypted and restrict who can read it. Without the original Vault key, the database cannot recover saved credentials.
:::

Copy the backup off the server. TLS certificates are not included; Caddy obtains new certificates when a restored HTTPS installation starts.

## Restore into a fresh installation

Keep the original installation until you have checked the restore. The restore command refuses an existing `.env`, project containers, or project volumes.

1. Clone nod into a new folder. Check out the commit recorded in the backup's `source-commit` file.

   ```sh title="Terminal"
   git clone https://github.com/n8n-io/nod.git nod-restored
   cd nod-restored
   git checkout <commit-from-source-commit>
   cd deployment/self-host
   ```

2. Restore under a new Compose project name. Don't run `setup.sh` first: the backup supplies the original keys.

   ```sh title="Terminal"
   sh restore.sh /absolute/path/to/nod-backup-2026-10-23 nod-restored
   ```

3. Review the restored `.env`. Set the new public address if it changed. If the original server still runs on this machine, select another `PORT`.
4. Stop the original server before starting the restored one. Two copies can run the same schedules or receive messages for the same bot.
5. Start the restored stack.

   ```sh title="Terminal"
   docker compose up -d --build --wait
   ```

   For a public address, use `docker compose --profile https up -d --build --wait` instead.

The restore command restores file ownership and the original Vault key. It stops PostgreSQL afterwards and leaves the assistant stopped until you start it.

If configuration validation fails before data is restored, the command removes the newly created `.env` so you can correct the backup configuration and retry. A failure after restoration starts keeps the new project for inspection.

Open nod with the saved token. Check conversation history, workspace files, model settings, and channel status. Check a saved credential through the private form without sending its value to chat. Review schedules before leaving the server running.

A restore returns data to the backup's point in time. It does not undo messages or actions that happened afterwards.

## Update

1. Read the release notes and create a backup.
2. Stop the stack.
3. Check out the release tag or commit you want to run, then rebuild and start it.

   ```sh title="Terminal"
   docker compose stop
   git fetch origin --tags
   git checkout <release-tag-or-commit>
   docker compose up -d --build --wait
   ```

4. Open nod, confirm its history and files, and check channel status.

The images build from the checked-out source. Pin a release or commit so you can identify what runs on the server. The setup command preserves your existing `.env`.

Database migrations run when nod starts. Don't point an older application version at an already upgraded database. To roll back, restore the pre-update backup into a fresh installation using its recorded revision.

## Rotate access

Generate a replacement token on the server:

```sh title="Terminal"
openssl rand -hex 32
```

Replace `NOD_AUTH_TOKEN` in `.env`, then recreate the server:

```sh title="Terminal"
docker compose up -d --wait server
```

Reconnect web and desktop clients with the new token. The previous token no longer grants access. Channel credentials are separate.

Don't replace `NOD_VAULT_KEY` to rotate access. It encrypts saved credentials; changing it without re-encrypting those records makes them unreadable.

## Related resources

- [Deploy and operate](/deploy/)
- [Host your own server](/deploy/self-host/)
- [Configuration reference](/deploy/configuration/)
- [Your data and privacy](/trust/privacy/)
