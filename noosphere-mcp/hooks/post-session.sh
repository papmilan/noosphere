#!/bin/bash

set -u

HOOK_INPUT=$(cat 2>/dev/null || true)
HOOK_CWD=$(printf '%s' "$HOOK_INPUT" | jq -r '.cwd // empty' 2>/dev/null)
TRANSCRIPT_PATH=$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

if [ -z "$HOOK_CWD" ] && [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  HOOK_CWD=$(jq -rs '
    [.[] | .cwd? | select(type == "string" and length > 0)]
    | last // empty
  ' "$TRANSCRIPT_PATH" 2>/dev/null)
fi

PROJECT_DIR=${HOOK_CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}
CONFIG_FILE="$PROJECT_DIR/.noosphere/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  CONFIG_FILE="$PROJECT_DIR/.noosphere.json"
fi

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
HOOK_TIMEOUT_SECONDS=${NOOSPHERE_HOOK_TIMEOUT_SECONDS:-130}
AUTH_HEADER=()
if [ -n "${NOOSPHERE_API_TOKEN:-}" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer $NOOSPHERE_API_TOKEN")
fi
HTTP_STATUS=$(curl -sS \
  --connect-timeout 2 \
  --max-time "$HOOK_TIMEOUT_SECONDS" \
  -o "$RESPONSE_FILE" \
  -w '%{http_code}' \
  -X POST "$RELAYER_URL/v1/actions" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: claude-code-$SESSION_ID" \
  "${AUTH_HEADER[@]}" \
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
