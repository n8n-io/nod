#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
[ "${NOD_ENV_FILE:-.env}" = .env ] || { echo 'Backup and restore require the installation .env; unset NOD_ENV_FILE.' >&2; exit 1; }
[ "$#" -eq 2 ] || { echo 'Usage: sh restore.sh /absolute/backup-directory new-project-name' >&2; exit 1; }
case "$1" in /*) ;; *) echo 'Use an absolute backup path.' >&2; exit 1 ;; esac
backup=$1
project=$2
case "$project" in ''|*[!a-z0-9_-]*|[-_]*) echo 'Use a new project name beginning with a lowercase letter or digit, followed by lowercase letters, digits, hyphens or underscores.' >&2; exit 1 ;; esac
[ ! -e .env ] || { echo 'Restore into a fresh checkout with no .env. Existing configuration was kept.' >&2; exit 1; }
for file in .env source-commit complete postgres.dump server-data.tar.gz workspace-data.tar.gz workspace-tools.tar.gz browser-data.tar.gz; do
  [ -f "$backup/$file" ] || { echo "Backup is missing $file." >&2; exit 1; }
done
[ "$(cat "$backup/complete")" = nod-self-host-backup-v1 ] || { echo 'Unsupported or incomplete backup.' >&2; exit 1; }
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?NOD_ENV_FILE[[:space:]]*=' "$backup/.env"; then
  echo 'Restore requires the saved .env; remove NOD_ENV_FILE from the backup configuration.' >&2
  exit 1
fi
if env | grep -Eq '^(NOD_AUTH_TOKEN|NOD_VAULT_KEY|NOD_POSTGRES_PASSWORD)='; then
  echo 'Unset shell secret overrides before restoring the saved .env.' >&2
  exit 1
fi
if [ -f source-revision ]; then revision=$(cat source-revision); else revision=$(git -C ../.. rev-parse HEAD); fi
[ "${#revision}" -eq 40 ] && printf '%s\n' "$revision" | grep -Eq '^[a-f0-9]{40}$' || { echo 'Invalid installation source revision.' >&2; exit 1; }
[ "$revision" = "$(cat "$backup/source-commit")" ] || { echo 'Use the bundle or source checkout recorded in source-commit before restoring.' >&2; exit 1; }
if [ -n "${DATABASE_URL:-}" ] || grep -Eq '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=[[:space:]]*[^[:space:]]' "$backup/.env"; then
  echo 'This restore command supports the bundled database only. Use your external database restore procedure.' >&2
  exit 1
fi
[ -z "$(docker ps --all --quiet --filter "label=com.docker.compose.project=$project")" ] || { echo 'That Compose project already has containers. Choose a fresh project name.' >&2; exit 1; }
[ -z "$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")" ] || { echo 'That Compose project already has volumes. Choose a fresh project name.' >&2; exit 1; }
for volume in server-data workspace-data workspace-tools browser-data postgres-data https-data https-config; do
  if docker volume inspect "${project}_$volume" >/dev/null 2>&1; then
    echo 'That Compose project already has volumes. Choose a fresh project name.' >&2
    exit 1
  fi
done
helper_image=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
docker image inspect "$helper_image" >/dev/null 2>&1 || docker pull "$helper_image" >/dev/null
(
  set -C
  {
    sed '/^COMPOSE_PROJECT_NAME=/d' "$backup/.env"
    printf '\nCOMPOSE_PROJECT_NAME=%s\n' "$project"
  } > .env
)
export COMPOSE_PROJECT_NAME="$project"
if ! docker compose --file compose.yaml --env-file .env config --quiet; then
  rm .env
  exit 1
fi
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  docker compose --file compose.yaml --env-file .env stop postgres >/dev/null || result=1
  if [ "$result" -ne 0 ]; then
    echo 'Restore incomplete. The new project was kept for inspection; no assistant was started.' >&2
  else
    printf '%s\n' 'Restored into a new project. Review .env before starting Nod.' \
      'Start with: docker compose --file compose.yaml --env-file .env up -d --build --wait' \
      'For public HTTPS: docker compose --file compose.yaml --env-file .env --profile https up -d --build --wait'
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for volume in server-data workspace-data workspace-tools browser-data; do
  docker volume create --label "com.docker.compose.project=$project" \
    --label "com.docker.compose.volume=$volume" "${project}_$volume" >/dev/null
  docker run --rm --interactive --network none --read-only --cap-drop ALL \
    --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true \
    --mount "type=volume,src=${project}_$volume,dst=/data" \
    --entrypoint tar "$helper_image" -C /data --same-owner -xzf - < "$backup/$volume.tar.gz"
done
docker compose --file compose.yaml --env-file .env up -d --wait postgres
docker compose --file compose.yaml --env-file .env exec -T postgres pg_restore --exit-on-error --no-owner --no-privileges -U nod -d nod < "$backup/postgres.dump"
