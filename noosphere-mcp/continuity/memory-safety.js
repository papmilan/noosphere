// Sanitizes untrusted semantic-memory content before it is embedded in an adapter
// system prompt or written into context.md. Recalled memory is authored by other
// agents (or by whoever can write to the relayer/Walrus namespace); it must never
// impersonate a system role, forge the structural delimiters that separate prompt
// sections, or smuggle terminal escape sequences into a human's console.
//
// SEC-05 Phase 2 — structural neutralization is complete (design invariant 6). The
// normalizer below is the single registered normalization for untrusted content:
// NFC folding, every line separator collapsed to '\n', and every control / format /
// zero-width / bidi / tag / interlinear / variation-selector code point removed. No
// invisible or line-splitting character survives, so quoteUntrustedMemory's '> '
// prefix cannot be bypassed by a code point the renderer treats as a new line.

// Registered normalizer identity. Authenticated trust records bind these so a
// normalizer change fails closed (invariant 19): an old record's (normAlgo,
// normVersion) will no longer match the running normalizer and must be re-approved.
// Phase 1 was ('raw', 0) — the identity normalizer; Phase 2 is the real one below.
export const NORM_ALGO = 'nfc-strip';
export const NORM_VERSION = 1;

// C0 controls except tab (0x09) and newline (0x0a), DEL (0x7f), and C1 controls
// (0x80-0x9f). Removing the introducer neutralizes ANSI/OSC/BEL sequences. NEL
// (0x85) is a C1 control but is converted to '\n' before this check runs.
function isControl(cp) {
  if (cp < 0x20) return cp !== 0x09 && cp !== 0x0a;
  return cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
}

// Variation selectors (base block FE00-FE0F and the E0100-E01EF supplement) are
// Nonspacing_Mark, not Format, so \p{Cf} does not cover them — strip explicitly.
function isVariationSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

// The canonical Phase-2 normalizer for untrusted content. Deterministic and
// idempotent: normalizeUntrusted(normalizeUntrusted(x)) === normalizeUntrusted(x).
// Truncation is deliberately NOT applied here — content identity (the hash an
// authenticated record binds) must not depend on a display length bound.
//
// Order matters: STRIP first, NFC LAST. Removing an invisible code point (e.g. a
// zero-width space) that sat between a base character and its combining mark makes
// them adjacent, so a final NFC composes them — and a second run is then a no-op.
// Doing NFC before stripping would leave such a pair non-adjacent (uncomposed) on
// the first pass but composable on the second, breaking idempotence.
//
// Pass 1 drops the entire Unicode Format category (\p{Cf} — zero-width space/
// joiner/non-joiner, word joiner, invisible operators, bidi marks/embeddings/
// overrides/isolates, BOM/ZWNBSP, interlinear annotation FFF9-FFFB, and the Tag
// block E0000-E007F used to smuggle hidden text). Pass 2 walks the remaining code
// points to collapse every line separator (CRLF, CR, NEL 0x85, LINE SEPARATOR
// 0x2028, PARAGRAPH SEPARATOR 0x2029) to '\n' and remove controls and variation
// selectors. NFC is applied last.
export function normalizeUntrusted(text) {
  const stripped = String(text ?? '').replace(/\p{Cf}/gu, '');
  let out = '';
  let lastWasCR = false;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0d) { out += '\n'; lastWasCR = true; continue; } // CR (and CRLF lead)
    const wasCR = lastWasCR;
    lastWasCR = false;
    if (cp === 0x0a) { if (!wasCR) out += '\n'; continue; }       // LF, collapse CRLF
    if (cp === 0x85 || cp === 0x2028 || cp === 0x2029) { out += '\n'; continue; }
    if (isControl(cp)) continue;
    if (isVariationSelector(cp)) continue;
    out += ch;
  }
  return out.normalize('NFC');
}

export function sanitizeMemoryText(text, { maxLength = 8000 } = {}) {
  const out = normalizeUntrusted(text);
  if (out.length > maxLength) return `${out.slice(0, maxLength)}\n[truncated]`;
  return out;
}

// Renders untrusted content as a clearly-quoted data block. Every line is prefixed
// with '> ', so no embedded line can equal a structural delimiter (--- X ---),
// close a Markdown code fence, or open a heading at column 0. Because the
// normalizer has already collapsed every line separator to '\n', splitting on '\n'
// quotes every line the renderer could produce.
export function quoteUntrustedMemory(text, options = {}) {
  const safe = sanitizeMemoryText(text, options);
  const body = safe.length === 0 ? '(empty)' : safe;
  return body.split('\n').map((line) => `> ${line}`).join('\n');
}
