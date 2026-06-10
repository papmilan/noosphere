#!/bin/bash

set -u

HOOK_INPUT=$(cat 2>/dev/null || true)
HOOK_CWD=$(printf '%s' "$HOOK_INPUT" | jq -r '.cwd // empty' 2>/dev/null)
PROJECT_DIR=${HOOK_CWD:-$PWD}
CONFIG_FILE="$PROJECT_DIR/.noosphere.json"

if [ -f "$CONFIG_FILE" ]; then
  PROJECT_ID=$(jq -r '.project_id // empty' "$CONFIG_FILE" 2>/dev/null)
  RELAYER_URL=$(jq -r '.relayer_url // empty' "$CONFIG_FILE" 2>/dev/null)
else
  PROJECT_ID=""
  RELAYER_URL=""
fi

PROJECT_ID=${PROJECT_ID:-$(basename "$PROJECT_DIR")}
RELAYER_URL=${RELAYER_URL:-${NOOSPHERE_RELAYER_URL:-http://localhost:3001}}

SESSION_ID=$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null)
SESSION_ID=${SESSION_ID:-$(date -u '+%Y%m%dT%H%M%SZ')}

SUMMARY=${CLAUDE_SESSION_SUMMARY:-}

if [ -z "$SUMMARY" ]; then
  TRANSCRIPT_PATH=$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
  if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    SUMMARY=$(jq -rs '
      [
        .[]
        | select(.type == "assistant")
        | .message.content[]?
        | select(.type == "text")
        | .text
      ]
      | last // empty
    ' "$TRANSCRIPT_PATH" 2>/dev/null)
  fi
fi

if [ -z "$SUMMARY" ] && [ -f "$HOME/.claude/sessions/latest.json" ]; then
  SUMMARY=$(jq -r '
    .summary
    // .session_summary
    // .last_assistant_message
    // empty
  ' "$HOME/.claude/sessions/latest.json" 2>/dev/null)
fi

if [ -z "$SUMMARY" ] && [ -d "$HOME/.claude/sessions" ]; then
  LATEST_SESSION=$(find "$HOME/.claude/sessions" -type f -name '*.json' -print0 2>/dev/null |
    xargs -0 ls -t 2>/dev/null |
    head -n 1)
  if [ -n "$LATEST_SESSION" ]; then
    SUMMARY=$(jq -r '
      .summary
      // .session_summary
      // .last_assistant_message
      // empty
    ' "$LATEST_SESSION" 2>/dev/null)
  fi
fi

if [ -z "$SUMMARY" ]; then
  SUMMARY="Claude Code session completed for project $PROJECT_ID."
fi

PAYLOAD=$(jq -n \
  --arg project_id "$PROJECT_ID" \
  --arg content "$SUMMARY" \
  --arg session_id "$SESSION_ID" \
  '{
    project_id: $project_id,
    agent_id: "claude-code",
    action_type: "session",
    content: $content,
    session_id: $session_id,
    provider: "Anthropic",
    model: "claude-code",
    client: "CLI"
  }')

RESPONSE_FILE=$(mktemp)
HTTP_STATUS=$(curl -sS \
  --connect-timeout 2 \
  --max-time 10 \
  -o "$RESPONSE_FILE" \
  -w '%{http_code}' \
  -X POST "$RELAYER_URL/v1/actions" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: claude-code-$SESSION_ID" \
  --data "$PAYLOAD" 2>/dev/null)
CURL_STATUS=$?

if [ "$CURL_STATUS" -eq 0 ] && [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
  printf '✓ Session stored in Noosphere\n'
  rm -f "$RESPONSE_FILE"
  exit 0
fi

ERROR_BODY=$(cat "$RESPONSE_FILE" 2>/dev/null)
rm -f "$RESPONSE_FILE"
printf 'Noosphere hook: upload failed (%s). Is the relayer running at %s?\n' \
  "${HTTP_STATUS:-connection error}" "$RELAYER_URL" >&2
[ -n "$ERROR_BODY" ] && printf '%s\n' "$ERROR_BODY" >&2

# Hooks should never prevent Claude Code from ending a session.
exit 0
