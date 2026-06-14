#!/bin/sh
# Noosphere — cross-agent project memory
# Docs: https://github.com/papmilan/noosphere
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/papmilan/noosphere/main/noosphere-relayer/public/install.sh | sh
#   (or from the local dashboard)
#   curl -fsSL http://127.0.0.1:3001/install.sh | sh

set -e

REQUIRED_NODE=22
PKG_CLI="noosphere-continuity"
PKG_RELAY="noosphere-relayer"

# ── helpers ────────────────────────────────────────────────────────────────────

log()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# ── prerequisites ──────────────────────────────────────────────────────────────

printf '\n'
printf '╔══════════════════════════════════════════════════════════╗\n'
printf '║          Noosphere — Installing…                         ║\n'
printf '╚══════════════════════════════════════════════════════════╝\n'
printf '\n'

# Node.js
if ! command -v node > /dev/null 2>&1; then
  err "Node.js ${REQUIRED_NODE}+ is required but not installed."
  log "Install from https://nodejs.org or via nvm: https://github.com/nvm-sh/nvm"
  exit 1
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.version.match(/^v(\d+)/)[1]))')
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE" ]; then
  die "Node.js ${REQUIRED_NODE}+ required (found $(node --version)). Upgrade at https://nodejs.org"
fi
ok "Node.js $(node --version)"

# npm
if ! command -v npm > /dev/null 2>&1; then
  die "npm is required. It comes with Node.js — reinstall from https://nodejs.org"
fi
ok "npm $(npm --version)"

# ── install npm packages ───────────────────────────────────────────────────────

printf '\n'
log "Installing Noosphere packages from npm…"
log "(this may take 30–60 seconds)"
printf '\n'

npm install -g "$PKG_CLI" "$PKG_RELAY" --loglevel=warn

ok "noosphere-continuity and noosphere-relayer installed"

# ── run user-level installer ───────────────────────────────────────────────────

printf '\n'
log "Setting up Noosphere for your user account…"
printf '\n'

noosphere install

# ── done ──────────────────────────────────────────────────────────────────────

printf '\n'
printf '╔══════════════════════════════════════════════════════════╗\n'
printf '║  Noosphere installed!                                    ║\n'
printf '║                                                          ║\n'
printf '║  Next step: run   noosphere setup                        ║\n'
printf '║  This will connect your Walrus Memory account.           ║\n'
printf '║                                                          ║\n'
printf '║  No account yet? The wizard will guide you.              ║\n'
printf '╚══════════════════════════════════════════════════════════╝\n'
printf '\n'

log "Verify your install any time with: noosphere doctor"
printf '\n'
