import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { ProjectMemoryService } from '@noosphere/remote-mcp-contracts/index.js';
import { buildProjectMemoryMcpServer } from './mcp-core.js';
import { protectedResourceMetadata } from './config.js';
import { correlationId, requestLog } from './logging.js';

// Server identity advertised to clients over the Streamable HTTP transport.
const REMOTE_SERVER_INFO = Object.freeze({ name: 'noosphere-remote-project-memory', version: '0.0.0' });
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

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

function applyCors(res, origin) {
  if (!origin) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  );
  res.setHeader('access-control-expose-headers', 'Mcp-Session-Id, WWW-Authenticate');
}

// Distinct control paths: a payload over the limit is not the same failure as
// malformed JSON, so callers can answer 413 vs 400 deterministically.
class PayloadTooLargeError extends Error { constructor() { super('payload-too-large'); this.name = 'PayloadTooLargeError'; } }
class InvalidJsonError extends Error { constructor() { super('invalid-json'); this.name = 'InvalidJsonError'; } }
const UTF8 = new TextDecoder('utf-8', { fatal: true });

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
      try {
        const raw = UTF8.decode(Buffer.concat(chunks));
        if (raw.length === 0) return finish(resolve, undefined);
        finish(resolve, JSON.parse(raw));
      } catch {
        finish(reject, new InvalidJsonError());
      }
    });
    req.on('error', (err) => finish(reject, err));
  });
}

export function createMcpServer({
  config,
  verifier,
  repository,
  now,
  sessionNow,
  readinessCheck,
  onShutdown,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  logger = () => {},
} = {}) {
  if (!config) throw new Error('server-requires-config');
  if (!verifier) throw new Error('server-requires-verifier');
  if (!repository) throw new Error('server-requires-repository');
  if (!Number.isFinite(shutdownGraceMs) || shutdownGraceMs < 0) {
    throw new Error('server-invalid-shutdown-grace-ms');
  }
  const service = new ProjectMemoryService({ repository, now, cursorSecret: config.cursorSecret });
  const sessions = new Map(); // sessionId -> { transport, ownerScope, lastAccessAt, inFlight }
  const transports = new Set(); // includes initialization transports not yet assigned a session id
  const sessionClock = typeof sessionNow === 'function' ? sessionNow : Date.now;
  let pendingSessions = 0;
  let closing = false;
  let shutdownPromise = null;

  function sessionTime() {
    const value = sessionClock();
    if (!Number.isFinite(value)) throw new Error('invalid-session-clock');
    return value;
  }

  function isExpired(session, at) {
    return session.inFlight === 0 && at - session.lastAccessAt >= config.mcpSessionTtlMs;
  }

  async function closeSession(sessionId, session) {
    if (sessions.get(sessionId) !== session) return;
    sessions.delete(sessionId);
    try { await session.transport.close(); } catch { /* best effort */ }
  }

  async function expireIdleSessions(at) {
    const expired = [...sessions].filter(([, session]) => isExpired(session, at));
    await Promise.all(expired.map(([sessionId, session]) => closeSession(sessionId, session)));
  }

  async function authenticate(req) {
    const header = req.headers['authorization'] || '';
    const match = /^Bearer (.+)$/i.exec(header);
    if (!match) return { identity: null, error: 'unauthenticated' };
    try {
      const identity = await verifier.verify(match[1]);
      return identity
        ? { identity, error: null }
        : { identity: null, error: 'unauthenticated' };
    } catch (error) {
      return {
        identity: null,
        error: error?.code === 'forbidden' ? 'forbidden' : 'unauthenticated',
      };
    }
  }

  async function handleMcp(req, res) {
    if (closing) return sendJson(res, 503, { error: 'server-shutting-down' }, { connection: 'close' });
    const origin = req.headers['origin'];
    if (origin && !config.allowedOrigins.has(origin)) return sendJson(res, 403, { error: 'forbidden-origin' });
    applyCors(res, origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const authentication = await authenticate(req);
    if (closing) return sendJson(res, 503, { error: 'server-shutting-down' }, { connection: 'close' });
    if (authentication.error === 'forbidden') return sendJson(res, 403, { error: 'forbidden' });
    if (!authentication.identity) return unauthorized(res, config);
    const { identity } = authentication;

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
    if (closing) return sendJson(res, 503, { error: 'server-shutting-down' }, { connection: 'close' });

    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return sendJson(res, 404, { error: 'unknown-session' });
      const accessedAt = sessionTime();
      if (isExpired(session, accessedAt)) {
        await closeSession(sessionId, session);
        return sendJson(res, 404, { error: 'unknown-session' });
      }
      // Bind the session to its owner: a token for a different owner cannot
      // drive an established session.
      if (session.ownerScope !== identity.ownerScope) return sendJson(res, 403, { error: 'session-owner-mismatch' });
      session.lastAccessAt = accessedAt;
      session.inFlight += 1;
      try {
        return await session.transport.handleRequest(req, res, body);
      } finally {
        session.inFlight -= 1;
        session.lastAccessAt = sessionTime();
      }
    }

    await expireIdleSessions(sessionTime());
    if (sessions.size + pendingSessions >= config.maxMcpSessions) {
      return sendJson(res, 503, { error: 'session-capacity' }, { 'retry-after': '1' });
    }

    // New session: the owner scope is fixed at initialize.
    pendingSessions += 1;
    let reservationHeld = true;
    let initializedSessionId = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        initializedSessionId = id;
        if (reservationHeld) {
          pendingSessions -= 1;
          reservationHeld = false;
        }
        sessions.set(id, {
          transport,
          ownerScope: identity.ownerScope,
          lastAccessAt: sessionTime(),
          inFlight: 1,
        });
      },
    });
    transports.add(transport);
    transport.onclose = () => {
      transports.delete(transport);
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const mcp = buildProjectMemoryMcpServer({ service, ownerScope: identity.ownerScope, serverInfo: REMOTE_SERVER_INFO });
    try {
      await mcp.connect(transport);
      return await transport.handleRequest(req, res, body);
    } finally {
      if (reservationHeld) {
        pendingSessions -= 1;
        reservationHeld = false;
      }
      if (initializedSessionId) {
        const session = sessions.get(initializedSessionId);
        if (session) {
          session.inFlight -= 1;
          session.lastAccessAt = sessionTime();
        }
      } else {
        try { await transport.close(); } catch { /* best effort */ }
      }
    }
  }

  async function handleHttpRequest(req, res) {
    const id = correlationId();
    let requestPath = '<invalid-url>';
    try {
      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        requestPath = url.pathname;
      } catch {
        return sendJson(res, 400, { error: 'invalid-request-url' });
      }
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
      logger(requestLog({ correlationId: id, method: req.method, path: requestPath, status: res.statusCode, headers: req.headers }));
    }
  }

  // Node's HTTP server does not observe a Promise returned by an async request
  // listener. Any rejection outside the inner try/catch (including URL parsing
  // or a throwing logger) would otherwise become an unhandled rejection and
  // leave the socket unanswered. Terminate that boundary explicitly.
  const httpServer = http.createServer((req, res) => {
    void handleHttpRequest(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else if (!res.writableEnded) res.destroy();
    });
  });

  function closeHttpServer() {
    return new Promise((resolve, reject) => {
      try {
        httpServer.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        httpServer.closeIdleConnections?.();
      } catch (error) {
        if (error?.code === 'ERR_SERVER_NOT_RUNNING') resolve();
        else reject(error);
      }
    });
  }

  async function performShutdown() {
    // Stop accepting sockets immediately. Transport shutdown and the HTTP
    // drain run together; a slow/incomplete request cannot keep deployment
    // shutdown wedged forever.
    const httpClosed = closeHttpServer();
    const transportClosures = Promise.allSettled(
      [...transports].map((transport) => Promise.resolve().then(() => transport.close())),
    );
    let graceTimer;
    const graceElapsed = new Promise((resolve) => {
      graceTimer = setTimeout(() => {
        httpServer.closeAllConnections?.();
        resolve();
      }, shutdownGraceMs);
    });

    let failure = null;
    try {
      await Promise.all([
        httpClosed,
        Promise.race([transportClosures, graceElapsed]),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(graceTimer);
      transports.clear();
      sessions.clear();
    }

    try {
      if (onShutdown) await onShutdown();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = performShutdown();
    return shutdownPromise;
  }

  return {
    httpServer,
    sessions,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          httpServer.removeListener('error', onError);
          httpServer.removeListener('listening', onListening);
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onListening = () => {
          cleanup();
          resolve(httpServer.address());
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        try {
          httpServer.listen(port);
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
    },
    shutdown,
  };
}
