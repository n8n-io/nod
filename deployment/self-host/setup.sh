#!/bin/sh
set -eu
set -C
cd "$(dirname "$0")"
umask 077
if env | grep -Eq '^(NOD_AUTH_TOKEN|NOD_VAULT_KEY|NOD_POSTGRES_PASSWORD)='; then
  echo 'Keep server secrets in .env and unset shell overrides before running setup or Compose.' >&2
  exit 1
fi
command -v docker >/dev/null 2>&1 || { echo 'Install Docker with Compose first.' >&2; exit 1; }
docker compose version >/dev/null
api=$(docker version --format '{{.Server.APIVersion}}')
case "$api" in 1.*) ;; *) echo 'Use Docker Engine 25 or newer.' >&2; exit 1 ;; esac
[ "${api#1.}" -ge 44 ] || { echo 'Use Docker Engine 25 or newer.' >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo 'Install OpenSSL first.' >&2; exit 1; }
if [ -L .env ] || { [ -e .env ] && [ ! -f .env ]; }; then
  echo '.env must be a regular file.' >&2
  exit 1
fi
if [ -e .env ]; then
  echo 'Using the existing .env. Its keys and data are unchanged.'
else
  project=${COMPOSE_PROJECT_NAME:-nod-$(openssl rand -hex 8)}
  case "$project" in ''|*[!a-z0-9_-]*|[-_]*) echo 'COMPOSE_PROJECT_NAME must begin with a lowercase letter or digit and contain only lowercase letters, digits, hyphens or underscores.' >&2; exit 1 ;; esac
  if [ -n "$(docker ps --all --quiet --filter "label=com.docker.compose.project=$project")" ] ||
    [ -n "$(docker volume ls --quiet --filter "name=^${project}_")" ] ||
    [ -n "$(docker network ls --quiet --filter "label=com.docker.compose.project=$project")" ]; then
    echo 'That Compose project already has resources. Choose a different COMPOSE_PROJECT_NAME for this new installation.' >&2
    exit 1
  fi
  (
    sed '/^COMPOSE_PROJECT_NAME=/d; /^NOD_AUTH_TOKEN=/d; /^NOD_VAULT_KEY=/d; /^NOD_POSTGRES_PASSWORD=/d' .env.example
    printf 'COMPOSE_PROJECT_NAME=%s\n' "$project"
    printf 'NOD_AUTH_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'NOD_VAULT_KEY=%s\n' "$(openssl rand -base64 32)"
    printf 'NOD_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  ) > .env
fi
chmod 600 .env
docker compose --file compose.yaml --env-file .env config --quiet
printf '%s\n' 'Ready. Run: docker compose --file compose.yaml --env-file .env up -d --build --wait' 'Open the configured NOD_PUBLIC_URL and enter NOD_AUTH_TOKEN from .env. For a remote server, open an SSH tunnel first.' 'For HTTPS on port 443, set NOD_PUBLIC_URL and run: docker compose --file compose.yaml --env-file .env --profile https up -d --build --wait'
