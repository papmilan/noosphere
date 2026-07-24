import { sanitizeMemoryText, quoteUntrustedMemory } from './memory-safety.js';

// SEC-05 Phase 3 — the single renderer for a memory slot at every sink.
//
// This is the one place that turns slot bytes into a rendered block, so every
// sink (context.md, the Ollama system prompt, and any future adapter that embeds
// memory) makes the SAME authority decision (invariant 5): a block is unquoted,
// authoritative text ONLY when an authenticated owner trust record vouched for
// exactly these bytes; otherwise it is quoted, non-authoritative data.
//
// The caller decides `authoritative` by calling isSlotAuthoritative on THE SAME
// bytes it passes here as `body` (see the adapter inventory below). That keeps the
// displayed authoritative bytes identical to the bytes the record binds (closes
// M-2, the baseline full-bytes-vs-rendered-body mismatch). Authoritative content
// is owner-approved and therefore rendered in full (never truncated), so the
// displayed bytes equal the bound bytes; only untrusted/quoted content is bounded
// by `maxLength` for context-window reasons.
//
// Adapter/sink inventory (every place untrusted memory is emitted — the Phase-3
// merge gate; extend this list and the parametrized adapter-injection test
// together whenever a new sink is added):
//   1. continuity/index.js refreshContext -> .noosphere/context.md
//        slots: baseline (gated), master-prompt (gated); followups + recalled
//        context are always data (quoted).
//   2. continuity/ollama.js buildOllamaSystemPrompt -> Ollama system prompt
//        slots: master-prompt (gated), instructions (gated); followups, journal,
//        recalled context are always data (quoted).
// The generated agent-adapter files (AGENTS.md/CLAUDE.md/GEMINI.md/noosphere.mdc)
// embed NO memory content — they are static pointers to .noosphere/*.md — so they
// are not content sinks.
export function renderSlotBlock(body, { authoritative = false, maxLength } = {}) {
  if (authoritative) {
    // Owner-approved: render the exact approved bytes, unbounded, so the
    // displayed bytes equal the bytes the trust record vouched for.
    return sanitizeMemoryText(body, { maxLength: Number.POSITIVE_INFINITY });
  }
  return quoteUntrustedMemory(body, maxLength ? { maxLength } : {});
}
