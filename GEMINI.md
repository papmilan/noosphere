<!-- noosphere:continuity:start -->
## Noosphere continuity adapter

Noosphere's core protocol is vendor-neutral. This file is an auto-load adapter
for tools that recognize this filename.

1. Before working, read `.noosphere/master-prompt.md`,
   `.noosphere/followups.jsonl`, `.noosphere/context.md`, and
   `.noosphere/journal.md`.
2. Treat the master prompt plus ordered follow-ups as current project intent.
   Preserve unfinished phases and constraints unless the user changes them.
3. Inspect the working tree because another tool may have changed it.
4. Append concise findings, evidence, decisions, failed approaches, and
   handoffs to `.noosphere/journal.md`.
5. Do not record hidden chain-of-thought, secrets, or private internal
   reasoning.

Project namespace: `noosphere-noosphere`.
<!-- noosphere:continuity:end -->
