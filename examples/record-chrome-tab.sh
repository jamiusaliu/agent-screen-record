#!/usr/bin/env bash
# Records the newest Chrome tab, even while it stays in the background.
# Needs Chrome already running with remote debugging on (chrome://inspect/#remote-debugging);
# the first recording of a Chrome session asks you to click Allow.
set -euo pipefail
url="${1:?usage: record-chrome-tab.sh <url> [seconds, default 8]}"
pgrep -xq "Google Chrome" || { echo "Start Google Chrome first (with remote debugging on)." >&2; exit 1; }
# Whatever ends this script (a failed command, Ctrl-C, a closed terminal), stop a running recording
# instead of leaving it to run until --max. "recording" is cleared before the final stop, so a
# recording is never stopped twice.
recording=0
stop_recording() { if [[ $recording -eq 1 ]]; then recording=0; screenrec stop >/dev/null 2>&1 || true; fi; }
trap stop_recording EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
screenrec start --tab newest
recording=1
open -g -a "Google Chrome" "$url"
sleep "${2:-8}"
recording=0
screenrec stop --json
