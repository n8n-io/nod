#!/bin/zsh
set -e
if [[ $# -lt 2 ]]; then
  echo "usage: init.sh <work-dir> <template> [name]"
  echo "templates: $(ls ${0:A:h}/../templates/*.html | xargs -n1 basename | sed 's/.html//' | tr '\n' ' ')"
  exit 1
fi
skill=${0:A:h}/..
repo=${0:A:h}/../../../..
work=$1
template=$2
name=${3:-$template}
mkdir -p "$work/assets"
cp "$repo/docs/src/assets/landing/reply-collage.png" "$work/assets/collage.png"
cp "$repo/docs/src/assets/landing/patterns/dot-grid.svg" "$work/assets/dot-grid.svg"
cp "$repo/public/fonts/Geist-Variable.woff2" "$repo/public/fonts/GeistMono-Variable.woff2" "$work/assets/"
cp "$skill/templates/$template.html" "$work/$name.html"
[[ -f "$skill/templates/$template.music.mjs" ]] && cp "$skill/templates/$template.music.mjs" "$work/$name.music.mjs"
echo "ready: $work/$name.html"
