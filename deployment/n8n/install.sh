#!/bin/sh
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077

releases='https://github.com/n8n-io/nod/releases'
legacy_update_source='https://internal.users.n8n.cloud/webhook/nod/desktop'
certificate='82e4c9de30d80541d1c59c0d590537e4c0abf4a04cc34fde6217a0f9e47e1e2d'
temporary=''
mounted=false
installed=false
locked=false

fail() {
  printf 'Nod: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$mounted" = true ] && ! hdiutil detach "$temporary/mount" -quiet >/dev/null 2>&1; then
    printf 'The disk image is still mounted at %s/mount. Eject it in Finder before removing this temporary folder.\n' "$temporary" >&2
    temporary=''
  fi
  if [ -n "$temporary" ] && [ -d "$temporary/Previous.app" ] && [ "$installed" = false ]; then
    if [ ! -e "$target" ] && [ ! -L "$target" ] && mv "$temporary/Previous.app" "$target"; then
      printf 'Your previous Nod app was restored.\n' >&2
    else
      printf 'Your previous Nod app is preserved at %s/Previous.app\n' "$temporary" >&2
      temporary=''
    fi
  fi
  if [ -n "$temporary" ]; then rm -rf "$temporary"; fi
  if [ "$locked" = true ]; then rmdir "$applications/.nod-install-lock"; fi
  exit "$result"
}

field() {
  plutil -extract "$2" raw -expect "$3" -o - "$1" 2>/dev/null || fail 'Release metadata is invalid.'
}

download() {
  curl -q --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error \
    --location --max-redirs 3 --connect-timeout 20 --max-time 1800 \
    --max-filesize "$3" --output "$2" "$1" || fail 'Download failed. Run the installer again to retry.'
}

hash() {
  shasum -a 256 "$1" | awk '{print $1}'
}

check_stopped() {
  if pgrep -x nod >/dev/null 2>&1; then fail 'Quit Nod, then run the installer again.'; fi
}

stop_updater() {
  update_job="gui/$(id -u)/dev.nod.desktop.ShipIt"
  if launchctl print "$update_job" >/dev/null 2>&1; then
    launchctl bootout "$update_job" >/dev/null 2>&1 || fail 'The previous Nod updater could not be stopped. Your app was kept.'
  fi
  if launchctl print "$update_job" >/dev/null 2>&1; then
    fail 'The previous Nod updater is still running. Your app was kept.'
  fi
}

valid_version() {
  printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
}

newer_than() {
  awk -v left="$1" -v right="$2" '
    function cmp(a,b,numeric) {
      if (("x" a)==("x" b)) return 0
      if (numeric && length(a)!=length(b)) return length(a)>length(b)?1:-1
      return ("x" a)>("x" b)?1:-1
    }
    BEGIN {
      split(left,a,"-"); split(right,b,"-"); split(a[1],aa,"."); split(b[1],bb,".")
      for(i=1;i<=3;i++) { c=cmp(aa[i],bb[i],1); if(c) exit c>0?0:1 }
      sub(/^[^-]*-?/,"",left); sub(/^[^-]*-?/,"",right)
      if(left=="" || right=="") exit left==""&&right!=""?0:1
      n=split(left,aa,"."); m=split(right,bb,".")
      for(i=1;i<=n&&i<=m;i++) {
        an=aa[i]~/^[0-9]+$/; bn=bb[i]~/^[0-9]+$/
        c=an!=bn?(an?-1:1):cmp(aa[i],bb[i],an); if(c) exit c>0?0:1
      }
      exit n>m?0:1
    }'
}

check_signature() {
  codesign --verify --deep --strict "$1" >/dev/null 2>&1 || fail 'The Nod signature is invalid.'
  codesign -d --extract-certificates="$temporary/certificate" "$1" >/dev/null 2>&1 || fail 'The Nod signing certificate is missing.'
  [ -f "$temporary/certificate0" ] && [ "$(hash "$temporary/certificate0")" = "$certificate" ] || fail 'The Nod signing identity does not match.'
  rm -f "$temporary/certificate0"
}

check_app() {
  candidate=$1
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || fail 'The disk image does not contain a Nod app.'
  check_signature "$candidate"
  info="$candidate/Contents/Info.plist"
  package="$candidate/Contents/Resources/app/package.json"
  [ -f "$info" ] && [ ! -L "$info" ] && [ -f "$package" ] && [ ! -L "$package" ] || fail 'The Nod app metadata is invalid.'
  [ "$(field "$info" CFBundleIdentifier string)" = 'dev.nod.desktop' ] || fail 'The downloaded app is not Nod.'
  [ "$(field "$info" CFBundleShortVersionString string)" = "$version" ] || fail 'The Nod app version does not match the release.'
  [ "$(field "$info" LSMinimumSystemVersion string)" = "$minimum" ] || fail 'The Nod system requirement does not match the release.'
  [ "$(field "$package" version string)" = "$version" ] || fail 'The Nod package version does not match the release.'
  [ "$(field "$package" nodBuild.source string)" = "$source" ] || fail 'The Nod app source does not match the release.'
  [ "$(field "$package" nodBuild.modified bool)" = false ] || fail 'The Nod app was not built from a clean release.'
  if [ -n "$update_source" ]; then
    [ "$(field "$package" nodBuild.updateSourceUrl string)" = "$update_source" ] || fail 'The Nod update service does not match.'
  elif plutil -extract nodBuild.updateSourceUrl raw -o - "$package" >/dev/null 2>&1; then
    fail 'The Nod update service does not match.'
  fi
  file -b "$candidate/Contents/MacOS/nod" | grep -q "Mach-O 64-bit executable $machine_arch" || fail 'The Nod app architecture does not match this Mac.'
}

[ "$#" -eq 0 ] || fail 'This installer takes no arguments and installs to /Applications/Nod.app.'
[ "$(uname -s)" = Darwin ] || fail 'Nod requires macOS 14 or later.'
case "$(uname -m)" in
  arm64) arch=arm64; machine_arch=arm64; manifest_name='release.json' ;;
  x86_64) arch=x64; machine_arch=x86_64; manifest_name='release-darwin-x64.json' ;;
  *) fail 'This Mac architecture is unsupported.' ;;
esac
[ "$(id -u)" -ne 0 ] || fail 'Run this installer as your normal user, without sudo.'
os_version=$(sw_vers -productVersion)
os_major=${os_version%%.*}
case "$os_major" in ''|*[!0-9]*) fail 'Could not read the macOS version.' ;; esac
[ "$os_major" -ge 14 ] || fail 'Nod requires macOS 14 or later.'
applications='/Applications'
target="$applications/Nod.app"
if [ ! -e "$target" ] && [ ! -L "$target" ] && { [ -e "$applications/nod.app" ] || [ -L "$applications/nod.app" ]; }; then
  target="$applications/nod.app"
fi
[ ! -L "$applications" ] && [ ! -L "$target" ] || fail 'The installation destination must not be a symbolic link.'
[ ! -e "$target" ] || [ -d "$target" ] || fail 'The installation destination is not an app directory.'
[ -d "$applications" ] && [ -w "$applications" ] && [ -x "$applications" ] || fail 'You need permission to install apps in /Applications. Use a macOS administrator account.'
[ ! -d "$target" ] || { [ -w "$target" ] && [ -x "$target" ]; } || fail 'You need permission to replace the installed Nod app. Ask its owner or your administrator.'
check_stopped
mkdir "$applications/.nod-install-lock" 2>/dev/null || fail 'Another installer is running. If it was interrupted, remove /Applications/.nod-install-lock and retry.'
locked=true
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
temporary=$(mktemp -d "$applications/.nod-install.XXXXXXXX")
stop_updater
current_version=''
current_identity=''
current_metadata=''
if [ -d "$target" ]; then
  [ "$(field "$target/Contents/Info.plist" CFBundleIdentifier string)" = 'dev.nod.desktop' ] || fail 'An unrelated app already occupies the installation path.'
  current_version=$(field "$target/Contents/Info.plist" CFBundleShortVersionString string)
  valid_version "$current_version" || fail 'The installed Nod version is invalid.'
  current_identity=$(stat -f '%d:%i' "$target")
  current_metadata=$(hash "$target/Contents/Info.plist")
fi

printf 'Finding the latest Nod release…\n'
status=$(curl -q --proto '=https' --tlsv1.2 --head --silent --show-error \
  --max-time 30 --max-redirs 0 --dump-header "$temporary/latest.headers" \
  --output /dev/null --write-out '%{http_code}' \
  "$releases/latest/download/$manifest_name") || fail 'The latest Nod release is unavailable.'
[ "$status" = 302 ] || fail 'The latest Nod release is unavailable.'
redirect=$(awk 'tolower($1)=="location:" { sub(/\r$/, "", $2); print $2 }' "$temporary/latest.headers" | tail -n 1)
case "$redirect" in
  "$releases/download/nod-v"*"/$manifest_name") tag=${redirect#"$releases/download/"}; tag=${tag%"/$manifest_name"} ;;
  *) fail 'The latest Nod release tag is invalid.' ;;
esac
version=${tag#nod-v}
printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || fail 'The latest Nod release tag is invalid.'
download "$releases/download/$tag/$manifest_name" "$temporary/release.json" 2097152
manifest="$temporary/release.json"
[ "$(field "$manifest" version string)" = "$version" ] || fail 'The release version does not match its tag.'
if [ -n "$current_version" ] && newer_than "$current_version" "$version"; then fail 'A newer Nod version is already installed. Your app was kept.'; fi
disk_url="$releases/download/$tag/nod-$arch.dmg"
bytes=$(field "$manifest" disk.bytes integer)
digest=$(field "$manifest" disk.sha256 string)
printf '%s\n' "$bytes" | grep -Eq '^[1-9][0-9]{0,9}$' || fail 'The download size is invalid.'
[ "$bytes" -le 2147483648 ] || fail 'The download exceeds the installer limit.'
printf '%s\n' "$digest" | grep -Eq '^[a-f0-9]{64}$' || fail 'The download hash is invalid.'
[ "$(field "$manifest" platform string)" = "darwin-$arch" ] || fail 'The release platform is unsupported.'
[ "$(field "$manifest" disk.file string)" = "nod-$arch.dmg" ] || fail 'The release filename is invalid.'
update_source=''
if plutil -extract updateSourceUrl raw -o - "$manifest" >/dev/null 2>&1; then
  update_source=$(field "$manifest" updateSourceUrl string)
  [ "$update_source" = "$legacy_update_source" ] || fail 'The Nod update service does not match.'
fi
[ "$(field "$manifest" signing.certificateSha256 string)" = "$certificate" ] || fail 'The release signing identity does not match.'
source=$(field "$manifest" source string)
printf '%s\n' "$source" | grep -Eq '^[a-f0-9]{40}$' || fail 'The release source is invalid.'
minimum=$(field "$manifest" minimumSystemVersion string)
printf '%s\n' "$minimum" | grep -Eq '^[1-9][0-9]*\.[0-9]+(\.[0-9]+)?$' || fail 'The release system requirement is invalid.'
awk -v current="$os_version" -v required="$minimum" 'BEGIN { split(current,a,"."); split(required,b,"."); for(i=1;i<=3;i++){if(a[i]+0>b[i]+0)exit 0;if(a[i]+0<b[i]+0)exit 1} }' || fail "This Nod release requires macOS $minimum or later."

printf 'Downloading Nod %s…\n' "$version"
download "$disk_url" "$temporary/nod.dmg" "$bytes"
[ "$(stat -f %z "$temporary/nod.dmg")" = "$bytes" ] && [ "$(hash "$temporary/nod.dmg")" = "$digest" ] || fail 'The Nod download is incomplete or has the wrong hash.'
printf 'Verifying Nod…\n'
check_signature "$temporary/nod.dmg"
hdiutil verify "$temporary/nod.dmg" >/dev/null 2>&1 || fail 'The Nod disk image is damaged.'
mkdir "$temporary/mount"
hdiutil attach "$temporary/nod.dmg" -mountpoint "$temporary/mount" -readonly -nobrowse -noautoopen -quiet || fail 'The Nod disk image could not be opened.'
mounted=true
candidate="$temporary/mount/Nod.app"
check_app "$candidate"
ditto "$candidate" "$temporary/nod.app" || fail 'The Nod app could not be copied.'
check_app "$temporary/nod.app"
hdiutil detach "$temporary/mount" -quiet || fail 'The Nod disk image could not be closed.'
mounted=false
check_stopped
stop_updater
rm -rf "$HOME/Library/Caches/dev.nod.desktop.ShipIt" || fail 'The previous Nod update cache could not be removed. Your app was kept.'
[ ! -L "$target" ] || fail 'The installation destination changed during installation.'
if [ -e "$target" ]; then
  [ -d "$target" ] || fail 'The installation destination changed during installation.'
  [ -n "$current_identity" ] && [ "$(stat -f '%d:%i' "$target")" = "$current_identity" ] && [ "$(hash "$target/Contents/Info.plist")" = "$current_metadata" ] || fail 'Your Nod app changed during installation. Run the installer again.'
  mv "$target" "$temporary/Previous.app" || fail 'Your current Nod app could not be moved.'
elif [ -n "$current_identity" ]; then
  fail 'Your Nod app moved during installation. Run the installer again.'
fi
mv "$temporary/nod.app" "$target" || fail 'The new Nod app could not be installed.'
printf '\nNod %s is installed at %s\n' "$version" "$target"
printf 'Your keys, conversations and workspace are kept. Updates are available inside Nod.\n'
printf 'Opening Nod…\n'
open "$target" || fail 'Nod is installed, but could not open. Open Nod from Applications.'
installed=true
