#!/bin/zsh
set -e
if [[ $# -lt 3 ]]; then
  echo "usage: finish.sh <silent.mp4> <music.wav> <out.mp4>"
  exit 1
fi
silent=$1
music=$2
out=$3
ffmpeg -y -loglevel error -i "$silent" -i "$music" -filter:a "loudnorm=I=-14:TP=-1.0:LRA=7" -ar 48000 \
  -c:v copy -c:a aac -b:a 192k -movflags +faststart -shortest "$out"
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -show_entries format=duration,size -of compact "$out"
ffmpeg -hide_banner -i "$out" -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|Peak):"
base=${out%.mp4}
ffmpeg -y -loglevel error -i "$out" -frames:v 1 "$base-poster.png"
ffmpeg -y -loglevel error -i "$out" -vf "select='isnan(prev_selected_t)+gte(t-prev_selected_t\,1.7)',scale=400:400,tile=4x4:padding=6:color=white" -frames:v 1 -fps_mode vfr "$base-sheet.png"
echo "poster: $base-poster.png"
echo "sheet:  $base-sheet.png"
