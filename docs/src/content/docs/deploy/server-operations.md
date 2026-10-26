---
title: Back up and update a server
description: Back up a self-hosted Nod server, restore into a fresh installation, update it, and rotate its access token.
sidebar:
  order: 5
---

Keep your server configuration and data together, and make a backup before updating Nod.

Run the commands below from your bundle directory or `nod/deployment/self-host` source checkout. If you use the HTTPS profile, include `--profile https` in Compose start, stop, and status commands.

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

Wait for active work to finish. Keep your configuration in `.env`, remove shell overrides, and [apply configuration changes](/deploy/configuration/#how-settings-work) before making a backup. Backup and restore refuse `NOD_ENV_FILE` overrides in either the shell or saved configuration; they preserve the installation's `.env` only.

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
| `workspace-data.tar.gz`  | Files created in Nod's workspace.                                                             |
| `workspace-tools.tar.gz` | Installed workspace tools and their files.                                                    |
| `browser-data.tar.gz`    | Browser profiles and saved browser state.                                                     |
| `source-commit`          | The bundle or source checkout revision to restore before starting Nod.                        |
| `complete`               | The marker required by the restore command.                                                   |

The destination must not exist. The command creates private files and refuses a custom `DATABASE_URL`. For an external database, coordinate its backup with copies of the four data volumes while Nod is stopped.

:::danger[The backup contains secrets]
Store it encrypted and restrict who can read it. Without the original Vault key, the database cannot recover saved credentials.
:::

Copy the backup off the server. TLS certificates are not included; Caddy obtains new certificates when a restored HTTPS installation starts.

## Restore into a fresh installation

Keep the original installation until you have checked the restore. The restore command refuses an existing `.env`, project containers, or project volumes.

1. Unpack your saved bundle into a new folder. Its `source-revision` must match the backup's `source-commit`. Don't run the installer yet.

   For a source installation, clone Nod into a new folder and check out that commit:

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
5. Start the restored bundle:

   ```sh title="Bundle installation"
   sh install.sh
   ```

   Use `sh install.sh --https` for a public address. For a source checkout, rebuild and start:

   ```sh title="Terminal"
   docker compose up -d --build --wait
   ```

   For a public address, use `docker compose --profile https up -d --build --wait` instead.

The restore command restores file ownership and the original Vault key. It stops PostgreSQL afterwards and leaves the assistant stopped until you start it.

If configuration validation fails before data is restored, the command removes the newly created `.env` so you can correct the backup configuration and retry. A failure after restoration starts keeps the new project for inspection.

Open Nod with the saved token. Check conversation history, workspace files, model settings, and channel status. Check a saved credential through the private form without sending its value to chat. Review schedules before leaving the server running.

A restore returns data to the backup's point in time. It does not undo messages or actions that happened afterwards.

## Update a bundle

1. Download the new [private bundle](/deploy/self-host/#install-a-prebuilt-bundle) for the same architecture. Check the source commit in its release tag or workflow run, and verify the archive checksum.
2. Back up the server. Keep the old bundle with that backup.
3. Stop the whole stack with `docker compose --profile https stop`. This also includes Caddy when HTTPS is enabled.
4. From the parent of your installation directory, unpack the new bundle over the existing directory. The bundle doesn't contain `.env` or your data volumes.

   ```sh title="Parent of the installation directory"
   tar -xzf nod-server-linux-<architecture>-<new-commit>.tar.gz
   cd nod-server-linux-<architecture>
   sh install.sh
   ```

   For public HTTPS, use `sh install.sh --https`. The installer keeps your existing `.env`, checks the images, and starts them without compiling.

5. Open Nod, confirm its history and files, and check channel status.

The `source-revision` file records the installed bundle revision. Don't change `COMPOSE_PROJECT_NAME` during an update: it selects your existing data volumes.

## Prepare a private server release

After maintainer approval, run the **Self-host bundle** workflow on `main` with **draft_release** selected. Normal pushes, pull requests and manual runs leave this option off and only create temporary workflow artifacts.

Both native architecture builds, server checks and standalone installer checks must pass before the release job runs. That job uses the existing `release` environment and its protection rules. It verifies each archive's checksum, source commit and architecture, creates `server-<full-source-commit>`, uploads both bundles and checks GitHub's asset digests. The result is an unpublished draft in the private repository.

Review the successful run, checksums and release notes before publishing the draft within the private repository. Drafts are only visible to maintainers; published releases are available to people with repository access. Neither step changes repository visibility. Release assets do not use the workflow's 14-day artifact retention.

The workflow never publishes or replaces an existing tag, release or asset. If a run stops after creating a tag or draft, inspect that partial result before retrying; a rerun refuses to overwrite it. Keep your own copy of each installed bundle with its backup even after a release is available.

## Update a source installation

1. Read the release notes and create a backup.
2. Stop the stack.
3. Check out the release tag or commit you want to run, then rebuild and start it.

   ```sh title="Terminal"
   docker compose stop
   git fetch origin --tags
   git checkout <release-tag-or-commit>
   docker compose up -d --build --wait
   ```

4. Open Nod, confirm its history and files, and check channel status.

The images build from the checked-out source. Pin a release or commit so you can identify what runs on the server. The setup command preserves your existing `.env`.

Database migrations run when Nod starts. Don't point an older application version at an already upgraded database. To roll back, restore the pre-update backup into a fresh installation using its recorded revision.

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
