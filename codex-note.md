# Codex Note — 2026-06-11

## What other agents did

| Agent | When | Work |
|---|---|---|
| **workspace-continuity** | Jun 10–11 | Automated checkpoints tracking the full redesign (Sui contract removed, Walrus Memory + universal protocol added) |
| **codex** | Jun 10 22:11 | Decided on universal integration architecture (filesystem, CLI, HTTP, MCP) |
| **verification-bot** | Jun 11 07:06 | Verified Claude Code's bug fixes; confirmed relayer and continuity test suites pass |
| **codex** | Jun 11 07:12 | Corrected three post-fix regressions: proxy trust parsing, receipt expiry, disk-write queue recovery |
| **codex** | Jun 11 08:49 | Removed Move contract, legacy routes, obsolete storage modules, build artifacts |
| **codex** | Jun 11 08:56 | Rewrote README for current architecture |
| **codex** | Jun 11 09:31 | Ran a live Codex→Claude→Codex cross-agent continuity test; confirmed the SessionEnd hook stores Claude sessions correctly |
| **codex** | Jun 11 10:43 | Validated Walrus mainnet credentials; observed writes average **~87 seconds**; increased continuity request timeout to 130s |

## Recommendation

**Increase `MEMWAL_REMEMBER_TIMEOUT_MS` from 120 s to 180 s.**

Codex measured ~87 s for a mainnet Walrus write. The relayer's current default is 120 s
(`memory.js:68`, `.env.example`). The continuity daemon already has a 130 s client-side
timeout, but if Walrus takes 95–110 s under load, the **relayer times out first** (at
120 s) and returns a 503 before continuity's timeout fires. The request never retries
because the checkpoint fingerprint was already cleared.

Fix: change the default in `.env.example` and in `memory.js`:

```js
// memory.js:68
timeoutMs: Number(process.env.MEMWAL_REMEMBER_TIMEOUT_MS || 180_000),
```

```
# .env.example
MEMWAL_REMEMBER_TIMEOUT_MS=180000
```

180 s gives a 93 s buffer above the observed average and sits safely below
continuity's 130 s client timeout — which itself should be bumped to 200 s
to stay above the relayer.
