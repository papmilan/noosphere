<!-- noosphere:continuity:start -->
## Noosphere continuity adapter

Noosphere's core protocol is vendor-neutral. This file is an auto-load adapter
for tools that recognize this filename.

1. Read `.noosphere/master-prompt.md` and `.noosphere/followups.jsonl` in order.
2. Read CSP machine state from `.noosphere/state.json` when present.
3. Treat the master prompt plus ordered follow-ups as current project intent.
   Preserve unfinished phases and constraints unless the user changes them.
4. Inspect Git separately; branch/HEAD are runtime observations, not CSP fields. Read baseline/context/journal only when
   needed; never parse journal prose into machine state when CSP exists.
5. Append concise findings, evidence, decisions, failed approaches, and
   handoffs to `.noosphere/journal.md`.
6. Do not record hidden chain-of-thought, secrets, or private internal
   reasoning.

Project namespace: `noosphere-noosphere`.
<!-- noosphere:continuity:end -->
