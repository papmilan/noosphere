// Independent low-level Streamable HTTP / JSON-RPC client for acceptance tests.
// It deliberately does NOT import the MCP SDK Client or its transport — it
// builds JSON-RPC frames, sets every header by hand, captures the
// Mcp-Session-Id response header, and parses both application/json and
// text/event-stream response bodies itself. Uses only the Node built-in fetch.

const ACCEPT = 'application/json, text/event-stream';

// Parse a Streamable HTTP response body. The server answers requests as SSE
// (`event: message\ndata: {json}\n\n`); notifications get an empty 202. JSON
// responses are also supported for forward-compatibility.
function parseBody(contentType, text) {
  if (!text) return undefined;
  if (contentType && contentType.includes('text/event-stream')) {
    const messages = [];
    for (const block of text.split('\n\n')) {
      const dataLines = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      messages.push(JSON.parse(dataLines.join('\n')));
    }
    return messages.length === 1 ? messages[0] : messages;
  }
  if (contentType && contentType.includes('application/json')) return JSON.parse(text);
  return text;
}

export class RawJsonRpcClient {
  #url; #token; #origin; #sessionId = undefined; #nextId = 0; #last = null;

  constructor({ url, token, origin = 'https://app.example' }) {
    this.#url = url;
    this.#token = token;
    this.#origin = origin;
  }

  get sessionId() { return this.#sessionId; }
  set sessionId(value) { this.#sessionId = value; } // deliberate override for negative routing tests
  get lastResponse() { return this.#last; } // raw transport inspection: { status, headers, body }

  // Send one JSON-RPC frame with fully explicit headers. Returns the parsed
  // envelope { status, headers, jsonrpc, result, error }. `notification: true`
  // omits the id (no response expected). `omitAuth` / `token` / `sessionId` /
  // `origin` overrides drive negative tests.
  async send(method, params = {}, { notification = false, token, sessionId, origin, omitAuth = false, accept = ACCEPT } = {}) {
    const body = { jsonrpc: '2.0', method };
    if (!notification) body.id = ++this.#nextId;
    if (params !== undefined) body.params = params;

    const headers = { 'content-type': 'application/json', accept };
    if (!omitAuth) headers.authorization = `Bearer ${token ?? this.#token}`;
    const effectiveOrigin = origin ?? this.#origin;
    if (effectiveOrigin !== null) headers.origin = effectiveOrigin;
    const sid = sessionId !== undefined ? sessionId : this.#sessionId;
    if (sid) headers['mcp-session-id'] = sid;

    const res = await fetch(this.#url, { method: 'POST', headers, body: JSON.stringify(body) });
    const returnedSid = res.headers.get('mcp-session-id');
    if (returnedSid) this.#sessionId = returnedSid;
    const text = await res.text();
    const parsed = parseBody(res.headers.get('content-type'), text);
    const envelope = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
    this.#last = {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      jsonrpc: parsed,
      result: envelope && typeof envelope === 'object' ? envelope.result : undefined,
      error: envelope && typeof envelope === 'object' ? envelope.error : undefined,
    };
    return this.#last;
  }

  // MCP initialize handshake: initialize request, capture the session id, then
  // the required notifications/initialized. Returns the initialize result.
  async initialize({ protocolVersion = '2025-06-18' } = {}) {
    const init = await this.send('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'raw-jsonrpc-client', version: '0.0.0' } });
    if (init.status !== 200) return init;
    await this.send('notifications/initialized', undefined, { notification: true });
    return init;
  }

  async listTools() {
    const r = await this.send('tools/list', {});
    // Mirror the SDK: a JSON-RPC protocol error throws rather than silently
    // returning undefined.
    if (r.error) throw Object.assign(new Error(typeof r.error.message === 'string' ? r.error.message : 'jsonrpc-error'), { code: r.error.code, data: r.error.data });
    return r.result ? r.result.tools : undefined;
  }

  // Returns the CallToolResult ({ content, structuredContent, isError }) so it
  // is shape-compatible with the SDK client's callTool result.
  async callTool(name, args = {}) {
    const r = await this.send('tools/call', { name, arguments: args });
    // A JSON-RPC protocol error (bad params, unknown method) leaves `result`
    // undefined; throw so this mirrors the SDK client, which raises McpError.
    // Tool-level failures (`isError: true`) travel inside `result` and are
    // returned as-is, exactly like the SDK.
    if (r.error) {
      const err = new Error(typeof r.error.message === 'string' ? r.error.message : 'jsonrpc-error');
      err.code = r.error.code;
      err.data = r.error.data;
      throw err;
    }
    return r.result;
  }

  async close() {
    if (!this.#sessionId) return;
    const headers = { authorization: `Bearer ${this.#token}`, accept: ACCEPT, 'mcp-session-id': this.#sessionId };
    if (this.#origin !== null) headers.origin = this.#origin;
    try {
      await fetch(this.#url, { method: 'DELETE', headers });
    } catch { /* best effort */ }
    this.#sessionId = undefined;
  }
}
