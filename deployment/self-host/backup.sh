#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
[ "${NOD_ENV_FILE:-.env}" = .env ] || { echo 'Backup and restore require the installation .env; unset NOD_ENV_FILE.' >&2; exit 1; }
[ "$#" -eq 1 ] || { echo 'Usage: sh backup.sh /absolute/new-backup-directory' >&2; exit 1; }
case "$1" in /*) ;; *) echo 'Use an absolute backup path.' >&2; exit 1 ;; esac
[ -f .env ] || { echo 'This installation has no .env.' >&2; exit 1; }
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?NOD_ENV_FILE[[:space:]]*=' .env; then
  echo 'Backup requires the installation .env; remove NOD_ENV_FILE from .env.' >&2
  exit 1
fi
if env | grep -Eq '^(NOD_AUTH_TOKEN|NOD_VAULT_KEY|NOD_POSTGRES_PASSWORD)='; then
  echo 'Keep server secrets in .env and unset shell overrides before backing up.' >&2
  exit 1
fi
if [ -n "${DATABASE_URL:-}" ] || grep -Eq '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=[[:space:]]*[^[:space:]]' .env; then
  echo 'This backup command supports the bundled database only. Use your external database backup procedure.' >&2
  exit 1
fi
if [ -f source-revision ]; then revision=$(cat source-revision); else revision=$(git -C ../.. rev-parse HEAD); fi
[ "${#revision}" -eq 40 ] && printf '%s\n' "$revision" | grep -Eq '^[a-f0-9]{40}$' || { echo 'Invalid installation source revision.' >&2; exit 1; }
running=$(docker compose --file compose.yaml --env-file .env ps --status running --services)
printf '%s\n' "$running" | grep -Fx postgres >/dev/null || { echo 'Start the bundled PostgreSQL service before backing up.' >&2; exit 1; }
volume_for() {
  container=$(docker compose --file compose.yaml --env-file .env ps --all --quiet "$1")
  [ -n "$container" ] || { echo "Missing $1 container." >&2; exit 1; }
  volume=$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Name}}{{end}}{{end}}" "$container")
  [ -n "$volume" ] || { echo "Missing $1 data volume." >&2; exit 1; }
  printf '%s\n' "$volume"
}
server_volume=$(volume_for server /var/lib/nod)
workspace_volume=$(volume_for workspace /workspace)
tools_volume=$(volume_for workspace /home/node)
browser_volume=$(volume_for browser /data)
helper_image=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
docker image inspect "$helper_image" >/dev/null 2>&1 || docker pull "$helper_image" >/dev/null
backup=$1
mkdir "$backup"
stopped=false
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$stopped" = true ]; then
    for service in browser workspace server; do
      if printf '%s\n' "$running" | grep -Fx "$service" >/dev/null; then
        docker compose --file compose.yaml --env-file .env start "$service" >/dev/null || result=1
      fi
    done
  fi
  if [ "$result" -ne 0 ]; then
    rm -f "$backup/complete"
    printf 'Backup incomplete: %s\n' "$backup" >&2
  else
    printf 'Backup saved: %s\n' "$backup"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
stopped=true
docker compose --file compose.yaml --env-file .env stop server browser workspace >/dev/null
cp .env "$backup/.env"
printf '%s\n' "$revision" > "$backup/source-commit"
docker compose --file compose.yaml --env-file .env exec -T postgres pg_dump -U nod -d nod --format=custom > "$backup/postgres.dump"
archive_volume() {
  docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges:true --mount "type=volume,src=$1,dst=/data,readonly" \
    --entrypoint tar "$helper_image" -C /data -czf - . > "$backup/$2.tar.gz"
}
archive_volume "$server_volume" server-data
archive_volume "$workspace_volume" workspace-data
archive_volume "$tools_volume" workspace-tools
archive_volume "$browser_volume" browser-data
printf 'nod-self-host-backup-v1\n' > "$backup/complete"
