#!/usr/bin/env bash
# Apply the Zen-like setup to your default Firefox profile.
#
#   ./install.sh               # prefs, theme, toolbar, sidebar width; keeps your tabs
#   ./install.sh --import-zen  # also replace current tabs with Zen Essentials + folders
#
# macOS blocks other apps from Firefox's profile folder, so this restarts
# Firefox with Marionette and lets Firefox copy the files into its own profile.
# Existing files are backed up to <profile>/zen-kit-backup-*.
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
PORT=2828
IMPORT_ZEN=0
for arg in "$@"; do
  case "$arg" in
    --import-zen) IMPORT_ZEN=1 ;;
    -h|--help) sed -n 2,10p "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

firefox_running() { pgrep -f "/Applications/Firefox.app/Contents/MacOS/firefox" >/dev/null; }
wait_for() { for _ in $(seq 1 "$2"); do eval "$1" && return 0; sleep 1; done; return 1; }
port_open() { lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

if port_open; then
  echo "Port $PORT is busy (another Marionette session?). Close it and retry." >&2
  exit 1
fi

SESSION_ARG=null
if [[ "$IMPORT_ZEN" == 1 ]]; then
  ZEN_PROFILE="$(ls -d "$HOME/Library/Application Support/zen/Profiles/"*/ 2>/dev/null | while read -r d; do [[ -f "$d/zen-sessions.jsonlz4" ]] && echo "$d"; done | head -1)"
  [[ -n "$ZEN_PROFILE" ]] || { echo "No Zen session found." >&2; exit 1; }
  if [[ ! -x "$KIT/.venv/bin/python" ]]; then
    python3 -m venv "$KIT/.venv" && "$KIT/.venv/bin/pip" -q install lz4
  fi
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  "$KIT/.venv/bin/python" "$KIT/scripts/zen_to_firefox_session.py" "$ZEN_PROFILE" "$TMP/session.jsonlz4"
  "$KIT/.venv/bin/python" -c "import lz4.block,sys; d=open(sys.argv[1],'rb').read(); open(sys.argv[2],'wb').write(lz4.block.decompress(d[8:]))" "$TMP/session.jsonlz4" "$TMP/session.json"
  SESSION_ARG="\"$TMP/session.json\""
fi

if firefox_running; then
  echo "Quitting Firefox…"
  osascript -e 'tell application "Firefox" to quit'
  wait_for '! firefox_running' 30 || { echo "Firefox didn't quit." >&2; exit 1; }
  sleep 3
fi

echo "Starting Firefox with Marionette…"
open -a Firefox --env MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 --args -marionette
wait_for port_open 60 || { echo "Marionette didn't start." >&2; exit 1; }
sleep 4
port_open && firefox_running || { echo "Firefox exited during startup; re-run ./install.sh." >&2; exit 1; }

python3 "$KIT/scripts/marionette.py" "$PORT" run "$KIT/firefox_setup.js" "[\"$KIT\", $SESSION_ARG]"

echo "Restarting Firefox normally…"
python3 "$KIT/scripts/marionette.py" "$PORT" quit || true
wait_for '! firefox_running' 30
open -a Firefox
echo "Done."
