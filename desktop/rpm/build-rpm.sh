#!/bin/sh
set -eu

version="${NOD_DESKTOP_VERSION:?NOD_DESKTOP_VERSION is required}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
application="$root/dist/desktop/Nod-linux-x64"
output="$root/dist/desktop/rpm"

test -x "$application/nod" || { echo "The packaged app is missing at $application." >&2; exit 1; }

dnf install -y rpm-build

rm -rf "$output"
mkdir -p "$output"
rpmbuild -bb \
  --define "_topdir $output/build" \
  --define "_rpmdir $output" \
  --define "nod_version $(printf '%s' "$version" | tr '-' '~')" \
  --define "nod_application $application" \
  --define "nod_rpm $root/desktop/rpm" \
  --define "nod_flatpak $root/desktop/flatpak" \
  --define "nod_assets $root/desktop/assets" \
  --define "nod_payload ${NOD_RPM_PAYLOAD:-w19.zstdio}" \
  "$root/desktop/rpm/nod.spec"
rm -rf "$output/build"
mv "$output"/x86_64/*.rpm "$output/nod-linux-x64.rpm"
rmdir "$output/x86_64"

dnf install -y "$output/nod-linux-x64.rpm"

test -u /usr/lib/nod/chrome-sandbox
for tool in qemu-system-x86_64 qemu-img ssh; do command -v "$tool"; done
missing="$(ldd /usr/lib/nod/nod | grep 'not found' || true)"
if [ -n "$missing" ]; then
  echo "The installed app is missing libraries:" >&2
  echo "$missing" >&2
  exit 1
fi

test ! -e /usr/lib/nod/resources/engine/runtime-assets
ELECTRON_RUN_AS_NODE=1 /usr/lib/nod/nod --input-type=module -e '
  const { runtimeRelease } = await import("/usr/lib/nod/resources/engine/desktop/runtime/assets.mjs");
  const release = await runtimeRelease("/usr/lib/nod/resources/engine");
  if (release?.platform !== "linux-x64") throw new Error("The packaged runtime release is missing or not for linux-x64.");
'

cd /usr/lib/nod/resources/engine
ELECTRON_RUN_AS_NODE=1 /usr/lib/nod/nod --input-type=module -e '
  const { register } = await import("tsx/esm/api");
  register();
  await import("./src/server/composition.ts");
  const { pool } = await import("./src/server/db.ts");
  await pool.end();
  const sharp = (await import("sharp")).default;
  await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer();
'
(cd "$output" && sha256sum "nod-linux-x64.rpm" > "SHA256SUMS-linux-x64-rpm")
chmod -R a+rX "$output"
