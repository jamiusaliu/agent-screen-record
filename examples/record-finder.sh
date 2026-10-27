#!/usr/bin/env bash
# Records Finder opening a file, following into the app that opens it (Preview for the sample).
# Works in a new temporary test folder, never your real Downloads, so no other file names are
# recorded. Pass a file to copy it into the test folder instead of the generated sample image.
# Finder's sidebar is part of the window and is recorded; hide it (View > Hide Sidebar) if needed.
set -euo pipefail
dir="$(mktemp -d "${TMPDIR:-/tmp}/screenrec-example.XXXXXX")/screenrec-example"
mkdir -p "$dir"
if [[ $# -ge 1 ]]; then
  cp "$1" "$dir/"
  file="$dir/$(basename "$1")"
else
  file="$dir/sample.png"
  ffmpeg -v error -f lavfi -i "testsrc2=size=640x400" -frames:v 1 "$file"
fi
open "$dir"
sleep 1
# Whatever ends this script (a failed command, Ctrl-C, a closed terminal), stop a running recording
# instead of leaving it to run until --max. "recording" is cleared before the final stop, so a
# recording is never stopped twice.
recording=0
stop_recording() { if [[ $recording -eq 1 ]]; then recording=0; screenrec stop >/dev/null 2>&1 || true; fi; }
trap stop_recording EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
screenrec start --app Finder --follow-app
recording=1
screenrec mark "test folder open"
open -F "$file"   # -F: launch the app fresh, so it does not restore (and record) earlier windows
sleep 3
screenrec mark "file opened"
recording=0
screenrec stop --json
