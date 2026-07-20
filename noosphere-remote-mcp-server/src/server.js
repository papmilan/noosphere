import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { ProjectMemoryService } from '@noosphere/remote-mcp-contracts/index.js';
import { buildProjectMemoryMcpServer } from './mcp-core.js';
import { protectedResourceMetadata } from './config.js';
import { correlationId, requestLog } from './logging.js';

// Server identity advertised to clients over the Streamable HTTP transport.
const REMOTE_SERVER_INFO = Object.freeze({ name: 'noosphere-remote-project-memory', version: '0.0.0' });

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

function unauthorized(res, config) {
  sendJson(res, 401, { error: 'unauthenticated' }, {
    'www-authenticate': `Bearer resource_metadata="${config.resourceMetadataUrl}"`,
  });
}

// Distinct control paths: a payload over the limit is not the same failure as
// malformed JSON, so callers can answer 413 vs 400 deterministically.
class PayloadTooLargeError extends Error { constructor() { super('payload-too-large'); this.name = 'PayloadTooLargeError'; } }
class InvalidJsonError extends Error { constructor() { super('invalid-json'); this.name = 'InvalidJsonError'; } }

// Enforce the body limit while streaming, before the full body is buffered. The
// first chunk that crosses maxBytes destroys the request and rejects; no further
// data is buffered, no JSON is parsed, and the caller never dispatches a tool.
// The limit is inclusive: a body of exactly maxBytes is accepted.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let length = 0;
    let done = false;
    const chunks = [];
    const finish = (fn, value) => { if (done) return; done = true; fn(value); };
    req.on('data', (c) => {
      if (done) return;
      length += c.length;
      if (length > maxBytes) {
        // Stop buffering immediately (memory is now bounded) and pause the
        // stream; the handler sends 413 and destroys the socket only after the
        // response has flushed, so the client reliably receives the status.
        req.pause();
        return finish(reject, new PayloadTooLargeError());
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) return finish(resolve, undefined);
      try { finish(resolve, JSON.parse(raw)); } catch { finish(reject, new InvalidJsonError()); }
    });
    req.on('error', (err) => finish(reject, err));
  });
}

export function createMcpServer({ config, verifier, repository, now, readinessCheck, onShutdown, logger = () => {} } = {}) {
  if (!config) throw new Error('server-requires-config');
  if (!verifier) throw new Error('server-requires-verifier');
  if (!repository) throw new Error('server-requires-repository');
  const service = new ProjectMemoryService({ repository, now });
  const sessions = new Map(); // sessionId -> { transport, ownerScope }

  async function authenticate(req) {
    const header = req.headers['authorization'] || '';
    const match = /^Bearer (.+)$/i.exec(header);
    if (!match) return null;
    try { return await verifier.verify(match[1]); } catch { return null; }
  }

  async function handleMcp(req, res) {
    const origin = req.headers['origin'];
    if (origin && !config.allowedOrigins.has(origin)) return sendJson(res, 403, { error: 'forbidden-origin' });
    const identity = await authenticate(req);
    if (!identity) return unauthorized(res, config);

    let body;
    try {
      body = await readBody(req, config.maxBodyBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        // Destroy the request only after the 413 has flushed, so an oversized
        // upload is aborted without racing the response off the socket.
        res.on('finish', () => req.destroy());
        return sendJson(res, 413, { error: 'payload-too-large' });
      }
      return sendJson(res, 400, { error: 'invalid-json' });
    }

    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return sendJson(res, 404, { error: 'unknown-session' });
      // Bind the session to its owner: a token for a different owner cannot
      // drive an established session.
      if (session.ownerScope !== identity.ownerScope) return sendJson(res, 403, { error: 'session-owner-mismatch' });
      return session.transport.handleRequest(req, res, body);
    }

    // New session: the owner scope is fixed at initialize.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { transport, ownerScope: identity.ownerScope }); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    const mcp = buildProjectMemoryMcpServer({ service, ownerScope: identity.ownerScope, serverInfo: REMOTE_SERVER_INFO });
    await mcp.connect(transport);
    return transport.handleRequest(req, res, body);
  }

  const httpServer = http.createServer(async (req, res) => {
    const id = correlationId();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/readyz') {
        const ok = readinessCheck ? await readinessCheck() : true;
        return sendJson(res, ok ? 200 : 503, { status: ok ? 'ready' : 'unavailable' });
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
        return sendJson(res, 200, protectedResourceMetadata(config));
      }
      if (url.pathname === '/mcp') return await handleMcp(req, res);
      return sendJson(res, 404, { error: 'not-found' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    } finally {
      logger(requestLog({ correlationId: id, method: req.method, path: url.pathname, status: res.statusCode, headers: req.headers }));
    }
  });

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    for (const { transport } of sessions.values()) {
      try { await transport.close(); } catch { /* best effort */ }
    }
    sessions.clear();
    await new Promise((resolve) => httpServer.close(() => resolve()));
    if (onShutdown) await onShutdown();
  }

  return {
    httpServer,
    sessions,
    listen(port = config.port) {
      return new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer.address())));
    },
    shutdown,
  };
}
