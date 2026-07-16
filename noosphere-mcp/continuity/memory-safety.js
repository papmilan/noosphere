// Sanitizes untrusted semantic-memory content before it is embedded in an adapter
// system prompt or written into context.md. Recalled memory is authored by other
// agents (or by whoever can write to the relayer/Walrus namespace); it must never
// impersonate a system role, forge the structural delimiters that separate prompt
// sections, or smuggle terminal escape sequences into a human's console.

function isControl(code) {
  // C0 controls except tab (0x09) and newline (0x0a); DEL (0x7f); C1 controls.
  // The ANSI escape (0x1b) and BEL (0x07) fall in these ranges, so ANSI/OSC
  // sequences are neutralized once their introducer is removed.
  if (code < 0x20) return code !== 0x09 && code !== 0x0a;
  return code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function isBidi(code) {
  // Bidirectional overrides/isolates that can visually reorder rendered text.
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

export function sanitizeMemoryText(text, { maxLength = 8000 } = {}) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0);
    if (isControl(code) || isBidi(code)) continue;
    out += ch;
  }
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}\n[truncated]`;
  return out;
}

// Renders untrusted content as a clearly-quoted data block. Every line is prefixed
// with '> ', so no embedded line can equal a structural delimiter (--- X ---),
// close a Markdown code fence, or open a heading at column 0. The result reads as
// quoted data in both Markdown and plain-text prompts.
export function quoteUntrustedMemory(text, options = {}) {
  const safe = sanitizeMemoryText(text, options);
  const body = safe.length === 0 ? '(empty)' : safe;
  return body.split('\n').map((line) => `> ${line}`).join('\n');
}
