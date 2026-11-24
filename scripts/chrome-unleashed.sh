#!/bin/bash
# Relaunch Google Chrome with the flags that widen what byob can reach:
#   --extensions-on-chrome-urls      byob may drive other extensions' pages
#                                    (chrome:// pages stay off-limits to any
#                                    extension's debugger — Chrome's rule)
#   --silent-debugger-extension-api  no "… is debugging this browser" banner
# --restore-last-session brings back the open tabs whatever the startup setting.
#
# The flags last for this launch only; opening Chrome from its usual icon
# starts it without them again.
set -euo pipefail

APP="Google Chrome"
FLAGS=(--extensions-on-chrome-urls --silent-debugger-extension-api --restore-last-session)

if pgrep -xq "$APP"; then
  echo "Quitting $APP (tabs come back on relaunch)…"
  osascript -e "tell application \"$APP\" to quit"
  for _ in $(seq 1 60); do
    pgrep -xq "$APP" || break
    sleep 0.5
  done
  if pgrep -xq "$APP"; then
    echo "$APP is still running — close it yourself and run this again." >&2
    exit 1
  fi
fi

open -a "$APP" --args "${FLAGS[@]}"
echo "Started $APP with: ${FLAGS[*]}"
