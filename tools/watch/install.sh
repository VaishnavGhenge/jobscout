#!/bin/sh
# Installs the new-posting watcher as a launchd agent that runs every 10 minutes
# while the Mac is awake. Re-run after pulling changes; it rebuilds and reloads.
#
#   sh tools/watch/install.sh            install or update
#   sh tools/watch/install.sh uninstall  stop and remove the agent
set -eu

LABEL=com.jobscout.watch
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DIR="$HOME/.jobscout"
CONFIG="$DIR/watch.json"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "watcher removed (state and alert log kept in $DIR)"
  exit 0
fi

NODE=$(command -v node)
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
cd "$REPO"
node_modules/.bin/esbuild tools/watch/watch.ts --bundle --platform=node --format=esm \
  --packages=external --log-level=warning --outfile=tools/watch/dist/watch.mjs

# The topic name is the only thing protecting the phone feed, so it's random.
if [ ! -f "$CONFIG" ]; then
  printf '{\n  "ntfyTopic": "jobscout-%s",\n  "threshold": 70,\n  "maxAgeHours": 48\n}\n' "$(openssl rand -hex 12)" > "$CONFIG"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file=.env</string>
    <string>tools/watch/dist/watch.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/watch.log</string>
  <key>StandardErrorPath</key><string>$DIR/watch.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

TOPIC=$(sed -n 's/.*"ntfyTopic": *"\([^"]*\)".*/\1/p' "$CONFIG")
echo "watcher installed: every 10 min, log at $DIR/watch.log"
echo "phone alerts: install the ntfy app and subscribe to topic: $TOPIC"
