#!/bin/sh
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077

base='https://internal.users.n8n.cloud/webhook/nod/desktop'
certificate='82e4c9de30d80541d1c59c0d590537e4c0abf4a04cc34fde6217a0f9e47e1e2d'
temporary=''
mounted=false
installed=false
locked=false

fail() {
  printf 'nod: %s\n' "$1" >&2
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
      printf 'Your previous nod app was restored.\n' >&2
    else
      printf 'Your previous nod app is preserved at %s/Previous.app\n' "$temporary" >&2
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

check_asset_url() {
  case "$1" in
    "$base/releases/$release_id/assets/"*) relative=${1#"$base/releases/$release_id/assets/"} ;;
    *) fail 'Release download URL is invalid.' ;;
  esac
  printf '%s\n' "$relative" | grep -Eq "^[1-9][0-9]*/$2$" || fail 'Release download URL is invalid.'
}

check_stopped() {
  if pgrep -x nod >/dev/null 2>&1; then fail 'Quit nod, then run the installer again.'; fi
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
  codesign --verify --deep --strict "$1" >/dev/null 2>&1 || fail 'The nod signature is invalid.'
  codesign -d --extract-certificates="$temporary/certificate" "$1" >/dev/null 2>&1 || fail 'The nod signing certificate is missing.'
  [ -f "$temporary/certificate0" ] && [ "$(hash "$temporary/certificate0")" = "$certificate" ] || fail 'The nod signing identity does not match.'
  rm -f "$temporary/certificate0"
}

check_app() {
  candidate=$1
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || fail 'The disk image does not contain a nod app.'
  check_signature "$candidate"
  info="$candidate/Contents/Info.plist"
  package="$candidate/Contents/Resources/app/package.json"
  [ -f "$info" ] && [ ! -L "$info" ] && [ -f "$package" ] && [ ! -L "$package" ] || fail 'The nod app metadata is invalid.'
  [ "$(field "$info" CFBundleIdentifier string)" = 'dev.nod.desktop' ] || fail 'The downloaded app is not nod.'
  [ "$(field "$info" CFBundleShortVersionString string)" = "$version" ] || fail 'The nod app version does not match the release.'
  [ "$(field "$info" LSMinimumSystemVersion string)" = "$minimum" ] || fail 'The nod system requirement does not match the release.'
  [ "$(field "$package" version string)" = "$version" ] || fail 'The nod package version does not match the release.'
  [ "$(field "$package" nodBuild.source string)" = "$source" ] || fail 'The nod app source does not match the release.'
  [ "$(field "$package" nodBuild.modified bool)" = false ] || fail 'The nod app was not built from a clean release.'
  [ "$(field "$package" nodBuild.updateSourceUrl string)" = "$base" ] || fail 'The nod update service does not match.'
  file -b "$candidate/Contents/MacOS/nod" | grep -q "Mach-O 64-bit executable $machine_arch" || fail 'The nod app architecture does not match this Mac.'
}

[ "$#" -eq 0 ] || fail 'This installer takes no arguments and installs to /Applications/nod.app.'
[ "$(uname -s)" = Darwin ] || fail 'nod requires macOS 14 or later.'
case "$(uname -m)" in
  arm64) arch=arm64; machine_arch=arm64; manifest_name='release\.json'; installer_query='installer=true' ;;
  x86_64) arch=x64; machine_arch=x86_64; manifest_name='release-darwin-x64\.json'; installer_query='installer=true&platform=darwin-x64' ;;
  *) fail 'This Mac architecture is unsupported.' ;;
esac
[ "$(id -u)" -ne 0 ] || fail 'Run this installer as your normal user, without sudo.'
os_version=$(sw_vers -productVersion)
os_major=${os_version%%.*}
case "$os_major" in ''|*[!0-9]*) fail 'Could not read the macOS version.' ;; esac
[ "$os_major" -ge 14 ] || fail 'nod requires macOS 14 or later.'
applications='/Applications'
target="$applications/nod.app"
[ ! -L "$applications" ] && [ ! -L "$target" ] || fail 'The installation destination must not be a symbolic link.'
[ ! -e "$target" ] || [ -d "$target" ] || fail 'The installation destination is not an app directory.'
[ -d "$applications" ] && [ -w "$applications" ] && [ -x "$applications" ] || fail 'You need permission to install apps in /Applications. Use a macOS administrator account.'
[ ! -d "$target" ] || { [ -w "$target" ] && [ -x "$target" ]; } || fail 'You need permission to replace /Applications/nod.app. Ask its owner or your administrator.'
check_stopped
mkdir "$applications/.nod-install-lock" 2>/dev/null || fail 'Another installer is running. If it was interrupted, remove /Applications/.nod-install-lock and retry.'
locked=true
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
temporary=$(mktemp -d "$applications/.nod-install.XXXXXXXX")
current_version=''
current_identity=''
current_metadata=''
if [ -d "$target" ]; then
  [ "$(field "$target/Contents/Info.plist" CFBundleIdentifier string)" = 'dev.nod.desktop' ] || fail 'An unrelated app already occupies /Applications/nod.app.'
  current_version=$(field "$target/Contents/Info.plist" CFBundleShortVersionString string)
  valid_version "$current_version" || fail 'The installed nod version is invalid.'
  current_identity=$(stat -f '%d:%i' "$target")
  current_metadata=$(hash "$target/Contents/Info.plist")
fi

printf 'Finding the latest nod release…\n'
download "$base/releases?$installer_query" "$temporary/latest.json" 2097152
[ "$(field "$temporary/latest.json" schema integer)" = 1 ] || fail 'The installer metadata format is unsupported.'
version=$(field "$temporary/latest.json" version string)
valid_version "$version" || fail 'The release version is invalid.'
if [ -n "$current_version" ] && newer_than "$current_version" "$version"; then fail 'A newer nod version is already installed. Your app was kept.'; fi
release_id=$(field "$temporary/latest.json" releaseId integer)
printf '%s\n' "$release_id" | grep -Eq '^[1-9][0-9]*$' || fail 'The release identity is invalid.'
disk_url=$(field "$temporary/latest.json" disk.url string)
bytes=$(field "$temporary/latest.json" disk.bytes integer)
digest=$(field "$temporary/latest.json" disk.sha256 string)
manifest_url=$(field "$temporary/latest.json" manifestUrl string)
printf '%s\n' "$bytes" | grep -Eq '^[1-9][0-9]{0,9}$' || fail 'The download size is invalid.'
[ "$bytes" -le 2147483648 ] || fail 'The download exceeds the installer limit.'
printf '%s\n' "$digest" | grep -Eq '^[a-f0-9]{64}$' || fail 'The download hash is invalid.'
check_asset_url "$disk_url" "nod-$arch\.dmg"
check_asset_url "$manifest_url" "$manifest_name"
download "$manifest_url" "$temporary/release.json" 2097152
manifest="$temporary/release.json"
[ "$(field "$manifest" version string)" = "$version" ] || fail 'The release versions do not match.'
[ "$(field "$manifest" platform string)" = "darwin-$arch" ] || fail 'The release platform is unsupported.'
[ "$(field "$manifest" disk.file string)" = "nod-$arch.dmg" ] || fail 'The release filename is invalid.'
[ "$(field "$manifest" disk.bytes integer)" = "$bytes" ] && [ "$(field "$manifest" disk.sha256 string)" = "$digest" ] || fail 'The release download metadata does not match.'
[ "$(field "$manifest" signing.certificateSha256 string)" = "$certificate" ] || fail 'The release signing identity does not match.'
source=$(field "$manifest" source string)
printf '%s\n' "$source" | grep -Eq '^[a-f0-9]{40}$' || fail 'The release source is invalid.'
minimum=$(field "$manifest" minimumSystemVersion string)
printf '%s\n' "$minimum" | grep -Eq '^[1-9][0-9]*\.[0-9]+(\.[0-9]+)?$' || fail 'The release system requirement is invalid.'
awk -v current="$os_version" -v required="$minimum" 'BEGIN { split(current,a,"."); split(required,b,"."); for(i=1;i<=3;i++){if(a[i]+0>b[i]+0)exit 0;if(a[i]+0<b[i]+0)exit 1} }' || fail "This nod release requires macOS $minimum or later."

printf 'Downloading nod %s…\n' "$version"
download "$disk_url" "$temporary/nod.dmg" "$bytes"
[ "$(stat -f %z "$temporary/nod.dmg")" = "$bytes" ] && [ "$(hash "$temporary/nod.dmg")" = "$digest" ] || fail 'The nod download is incomplete or has the wrong hash.'
printf 'Verifying nod…\n'
check_signature "$temporary/nod.dmg"
hdiutil verify "$temporary/nod.dmg" >/dev/null 2>&1 || fail 'The nod disk image is damaged.'
mkdir "$temporary/mount"
hdiutil attach "$temporary/nod.dmg" -mountpoint "$temporary/mount" -readonly -nobrowse -noautoopen -quiet || fail 'The nod disk image could not be opened.'
mounted=true
check_app "$temporary/mount/nod.app"
ditto "$temporary/mount/nod.app" "$temporary/nod.app" || fail 'The nod app could not be copied.'
check_app "$temporary/nod.app"
hdiutil detach "$temporary/mount" -quiet || fail 'The nod disk image could not be closed.'
mounted=false
check_stopped
[ ! -L "$target" ] || fail 'The installation destination changed during installation.'
if [ -e "$target" ]; then
  [ -d "$target" ] || fail 'The installation destination changed during installation.'
  [ -n "$current_identity" ] && [ "$(stat -f '%d:%i' "$target")" = "$current_identity" ] && [ "$(hash "$target/Contents/Info.plist")" = "$current_metadata" ] || fail 'Your nod app changed during installation. Run the installer again.'
  mv "$target" "$temporary/Previous.app" || fail 'Your current nod app could not be moved.'
elif [ -n "$current_identity" ]; then
  fail 'Your nod app moved during installation. Run the installer again.'
fi
mv "$temporary/nod.app" "$target" || fail 'The new nod app could not be installed.'
installed=true
printf '\nnod %s is installed at %s\n' "$version" "$target"
printf 'Your keys, conversations and workspace are kept. Updates are available inside nod.\n'
printf 'Opening nod…\n'
open "$target" || fail 'nod is installed, but could not open. Open nod from Applications.'
