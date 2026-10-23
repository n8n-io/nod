#!/bin/sh
set -eu
set -C
cd "$(dirname "$0")"
umask 077
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
  (
    sed '/^NOD_AUTH_TOKEN=/d; /^NOD_VAULT_KEY=/d; /^NOD_POSTGRES_PASSWORD=/d' .env.example
    printf 'NOD_AUTH_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'NOD_VAULT_KEY=%s\n' "$(openssl rand -base64 32)"
    printf 'NOD_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  ) > .env
fi
chmod 600 .env
docker compose config --quiet
printf '%s\n' 'Ready. Run: docker compose up -d --build --wait' 'Open http://localhost:4310 and enter NOD_AUTH_TOKEN from .env.' 'For HTTPS, set NOD_PUBLIC_URL and run: docker compose --profile https up -d --build --wait'
