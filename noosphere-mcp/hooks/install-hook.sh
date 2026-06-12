#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}
HOOK_DIR="$CLAUDE_DIR/hooks/noosphere"
HOOK_PATH="$HOOK_DIR/post-session.sh"
SETTINGS_PATH="$CLAUDE_DIR/settings.json"

command -v jq >/dev/null 2>&1 || {
  printf 'jq is required. Install it with: brew install jq\n' >&2
  exit 1
}

mkdir -p "$HOOK_DIR"
cp "$SCRIPT_DIR/post-session.sh" "$HOOK_PATH"
chmod 700 "$HOOK_PATH"

if [ ! -f "$SETTINGS_PATH" ]; then
  printf '{}\n' > "$SETTINGS_PATH"
fi

BACKUP_PATH="$SETTINGS_PATH.noosphere-backup-$(date '+%Y%m%d%H%M%S')"
cp "$SETTINGS_PATH" "$BACKUP_PATH"

HOOK_COMMAND="bash \"$HOOK_PATH\""
TEMP_SETTINGS=$(mktemp)

jq --arg command "$HOOK_COMMAND" '
  .hooks //= {}
  | .hooks.SessionEnd //= []
  | if any(
      .hooks.SessionEnd[]?.hooks[]?;
      .command == $command
    )
    then .
    else
      .hooks.SessionEnd += [{
        "hooks": [{
          "type": "command",
          "command": $command,
          "timeout": 145,
          "statusMessage": "Storing session in Noosphere..."
        }]
      }]
    end
  | .hooks.SessionEnd |= map(
      .hooks |= map(
        if .command == $command
        then .timeout = 145
          | .statusMessage = "Storing session in Noosphere..."
        else .
        end
      )
    )
' "$SETTINGS_PATH" > "$TEMP_SETTINGS"

jq empty "$TEMP_SETTINGS"
mv "$TEMP_SETTINGS" "$SETTINGS_PATH"
chmod 600 "$SETTINGS_PATH"

printf 'Installed Noosphere hook: %s\n' "$HOOK_PATH"
printf 'Registered Claude Code SessionEnd hook in: %s\n' "$SETTINGS_PATH"
printf 'Backup created: %s\n' "$BACKUP_PATH"
printf 'Run noosphere activate inside each project you want to track.\n'
