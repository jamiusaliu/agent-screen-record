#!/usr/bin/env bash
# Makes docs/demo.gif, the README demo, with screenrec itself.
#
# What it does: creates a throwaway test folder (never your real Downloads) holding a sample GIF,
# opens it in Finder, records Finder with --app Finder --follow-app while the file is revealed and
# opened in Preview (the recording follows into Preview), then squeezes (holding each still step
# 1.2 s so it reads at a glance), crops 8 px from each edge and exports a 1200 px wide GIF (800 px
# blurs the Retina text).
#
# It records your real screen (the Finder and Preview windows only, not the whole display), so it
# refuses to run without --yes. Close or move anything private out of those apps first, and look at
# every frame of the GIF before committing it. Finder's sidebar is part of the window and shows
# your favourites, tags and home folder name: pass --hide-sidebar to hide it on the demo window
# (it is restored after the recording; the first run may ask to let your terminal control Finder).
# Preview is launched fresh (open -F), so it does not restore earlier documents into the recording.
#
# usage: scripts/make-demo.sh --yes [--no-crop] [--hide-sidebar]
set -euo pipefail

yes=0 crop=1 hide_sidebar=0
for a in "$@"; do
  case "$a" in
    --yes) yes=1 ;;
    --no-crop) crop=0 ;;
    --hide-sidebar) hide_sidebar=1 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
if [[ $yes -ne 1 ]]; then
  echo "usage: scripts/make-demo.sh --yes [--no-crop] [--hide-sidebar]" >&2
  echo "This records your screen (Finder and Preview windows). Pass --yes when you are ready." >&2
  exit 2
fi
[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS only" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is not on PATH: brew install ffmpeg" >&2; exit 1; }

repo="$(cd "$(dirname "$0")/.." && pwd)"
# Prefer this checkout's build over an older global install.
if [[ -f "$repo/dist/cli/main.js" && -x "$repo/bin/screenrec-mac" ]]; then sr="$repo/bin/screenrec"
elif command -v screenrec >/dev/null; then sr="$(command -v screenrec)"
else echo "no screenrec: run npm run build here, or install it globally" >&2; exit 1; fi
gif="$repo/docs/demo.gif"
if [[ -e "$gif" ]]; then echo "$gif already exists; move it away first" >&2; exit 1; fi

work="$(mktemp -d "${TMPDIR:-/tmp}/screenrec-demo.XXXXXX")"
folder="$work/screenrec-demo"
mkdir -p "$folder"
# A harmless sample file to open: a few seconds of ffmpeg's test pattern as a GIF.
ffmpeg -v error -f lavfi -i "testsrc2=size=480x300:rate=10:duration=3" \
  -vf "split[a][b];[a]palettegen[p];[b][p]paletteuse" "$folder/sample.gif"

open "$folder"
sleep 2
# Finder gives new windows the sidebar width of the last one closed, so put the width back afterwards.
sidebar_width=""
restore_sidebar() {
  if [[ -n "$sidebar_width" ]]; then
    osascript -e "tell application \"Finder\" to set sidebar width of Finder window \"screenrec-demo\" to $sidebar_width" >/dev/null 2>&1 || true
  fi
}
if [[ $hide_sidebar -eq 1 ]]; then
  sidebar_width="$(osascript -e 'tell application "Finder" to get sidebar width of Finder window "screenrec-demo"')"
  osascript -e 'tell application "Finder" to set sidebar width of Finder window "screenrec-demo" to 0' >/dev/null
  sleep 0.5
fi
# Whatever ends this script (a failed command, Ctrl-C, a closed terminal), stop a running recording
# instead of leaving it to run until --max. "recording" is cleared before the final stop, so a
# recording is never stopped twice.
recording=0
stop_recording() { if [[ $recording -eq 1 ]]; then recording=0; "$sr" stop >/dev/null 2>&1 || true; fi; }
trap 'stop_recording; restore_sidebar' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
"$sr" start --app Finder --follow-app --out "$work/raw.mp4" --max 2m
recording=1
"$sr" mark "test folder open in Finder"
sleep 1
open -R "$folder/sample.gif"
sleep 1.5
"$sr" mark "sample.gif selected"
open -F -a Preview "$folder/sample.gif"
sleep 4
"$sr" mark "sample.gif open in Preview"
recording=0
"$sr" stop --json

"$sr" squeeze "$work/raw.mp4" --hold 1.2 --out "$work/squeezed.mp4"
last="$work/squeezed.mp4"
if [[ $crop -eq 1 ]]; then
  "$sr" crop "$last" --trim-edges 8 --out "$work/cropped.mp4"
  last="$work/cropped.mp4"
fi
"$sr" gif "$last" --width 1200 --out "$gif"

bytes=$(stat -f %z "$gif")
echo "demo: $gif ($((bytes / 1024)) KB); working files in $work"
if (( bytes > 8 * 1024 * 1024 )); then
  echo "warning: the GIF is over 8 MB; try again with a shorter run, or re-export with --fps 8 or --width 640" >&2
fi
echo "Review every frame before committing it: it must not show anything private."
