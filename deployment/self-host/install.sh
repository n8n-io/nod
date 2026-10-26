#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
case "${1:-}" in '') [ "$#" -eq 0 ] ;; --https) [ "$#" -eq 1 ] ;; *) echo 'Usage: sh install.sh [--https]' >&2; exit 1 ;; esac
[ "${NOD_ENV_FILE:-.env}" = .env ] || { echo 'Keep configuration in this installation .env; unset NOD_ENV_FILE.' >&2; exit 1; }
if [ -f .env ] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?NOD_ENV_FILE[[:space:]]*=' .env; then
  echo 'Remove NOD_ENV_FILE from .env before installing.' >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | awk '{print $1}'; }
else
  command -v shasum >/dev/null 2>&1 || { echo 'Install sha256sum or shasum first.' >&2; exit 1; }
  checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
fi
[ -f checksums.sha256 ] && [ ! -L checksums.sha256 ] || { echo 'Missing bundle checksums.' >&2; exit 1; }
for file in .env.example Caddyfile docker-proxy.mjs setup.sh backup.sh restore.sh install.sh compose.yaml source-revision architecture images.txt images.tar.gz; do
  [ -f "$file" ] && [ ! -L "$file" ] || { echo "Missing regular bundle file: $file" >&2; exit 1; }
  expected=$(awk -v name="$file" '$2 == name {print $1}' checksums.sha256)
  [ "${#expected}" -eq 64 ] && [ "$(checksum "$file")" = "$expected" ] || { echo "Bundle checksum failed: $file" >&2; exit 1; }
done
revision=$(cat source-revision)
[ "${#revision}" -eq 40 ] || { echo 'Invalid source revision.' >&2; exit 1; }
case "$revision" in *[!a-f0-9]*) echo 'Invalid source revision.' >&2; exit 1 ;; esac
architecture=$(cat architecture)
case "$architecture" in amd64|arm64) ;; *) echo 'Unsupported bundle architecture.' >&2; exit 1 ;; esac
platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
case "$platform" in linux/x86_64|linux/amd64) native=amd64 ;; linux/aarch64|linux/arm64) native=arm64 ;; *) echo 'Use a Linux Docker Engine on AMD64 or ARM64.' >&2; exit 1 ;; esac
[ "$architecture" = "$native" ] || { echo "This bundle is $architecture; Docker requires $native." >&2; exit 1; }
sh setup.sh >/dev/null
docker image load --input images.tar.gz >/dev/null
while read -r reference config target; do
  case "$reference" in nod-server:bundle-*|nod-browser:bundle-*|nod-workspace:bundle-*) ;; *) echo 'Invalid bundled image reference.' >&2; exit 1 ;; esac
  actual=$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$reference")
  [ "$actual" = "$config linux/$architecture $revision" ] || [ "$actual" = "$target linux/$architecture $revision" ] || { echo 'Loaded image does not match the bundle.' >&2; exit 1; }
done < images.txt
if [ "${1:-}" = --https ]; then
  docker compose --file compose.yaml --env-file .env --profile https up -d --no-build --wait --wait-timeout 180
else
  docker compose --file compose.yaml --env-file .env up -d --no-build --wait --wait-timeout 180
fi
address=$(docker compose --file compose.yaml --env-file .env exec -T server node -p 'process.env.NOD_PUBLIC_URL')
printf 'Nod is ready at %s\n' "$address"
printf '%s\n' 'Enter NOD_AUTH_TOKEN from the private .env file. For a remote loopback address, open an SSH tunnel first.' "Installed source revision: $revision"
