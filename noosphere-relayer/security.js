import { timingSafeEqual } from 'node:crypto';

const DEFAULT_LOCAL_ORIGINS = [
  'http://127.0.0.1:3001',
  'http://localhost:3001',
];

export function resolveSecurityConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const apiToken = env.NOOSPHERE_API_TOKEN || '';
  const corsOrigins = parseList(env.CORS_ORIGINS || env.CORS_ORIGIN);
  const production = env.NODE_ENV === 'production';
  const allowLoopbackWithoutToken =
    !production &&
    isLoopbackHost(host) &&
    env.ALLOW_LOOPBACK_WITHOUT_TOKEN !== 'false';

  if (!isLoopbackHost(host) && !apiToken) {
    throw new Error(
      'NOOSPHERE_API_TOKEN is required when HOST is not a loopback address',
    );
  }
  if (production && !apiToken) {
    throw new Error(
      'NOOSPHERE_API_TOKEN is required when NODE_ENV=production',
    );
  }

  return {
    host,
    apiToken,
    allowLoopbackWithoutToken,
    corsOrigins:
      corsOrigins.length > 0 ? corsOrigins : DEFAULT_LOCAL_ORIGINS,
    rateLimitWindowMs: parsePositiveInteger(
      env.RATE_LIMIT_WINDOW_MS,
      60_000,
      'RATE_LIMIT_WINDOW_MS',
    ),
    rateLimitMax: parsePositiveInteger(
      env.RATE_LIMIT_MAX,
      120,
      'RATE_LIMIT_MAX',
    ),
  };
}

export function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Permitted-Cross-Domain-Policies': 'none',
  });
  next();
}

export function corsMiddleware(config) {
  const allowed = new Set(config.corsOrigins);

  return (req, res, next) => {
    const origin = req.get('Origin');
    if (origin && !allowed.has(origin)) {
      res.status(403).json({
        success: false,
        error: 'Origin is not allowed',
      });
      return;
    }

    if (origin) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
      });
    }
    res.set({
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, Idempotency-Key, X-Agent-Id, X-Noosphere-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export function authenticationMiddleware(config) {
  return (req, res, next) => {
    if (!config.apiToken) {
      next();
      return;
    }
    if (
      config.allowLoopbackWithoutToken &&
      isLoopbackAddress(req.socket.remoteAddress)
    ) {
      next();
      return;
    }

    const supplied = readToken(req);
    if (!supplied || !tokensEqual(supplied, config.apiToken)) {
      res.set('WWW-Authenticate', 'Bearer realm="Noosphere"');
      res.status(401).json({
        success: false,
        error: 'A valid Noosphere API token is required',
      });
      return;
    }
    next();
  };
}

export function rateLimitMiddleware(config, now = () => Date.now()) {
  const clients = new Map();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const timestamp = now();
    let bucket = clients.get(key);
    if (!bucket || timestamp >= bucket.resetAt) {
      bucket = {
        count: 0,
        resetAt: timestamp + config.rateLimitWindowMs,
      };
      clients.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, config.rateLimitMax - bucket.count);
    res.set({
      'RateLimit-Limit': String(config.rateLimitMax),
      'RateLimit-Remaining': String(remaining),
      'RateLimit-Reset': String(Math.ceil(bucket.resetAt / 1000)),
    });

    if (bucket.count > config.rateLimitMax) {
      res.set(
        'Retry-After',
        String(Math.ceil((bucket.resetAt - timestamp) / 1000)),
      );
      res.status(429).json({
        success: false,
        error: 'Too many requests',
      });
      return;
    }

    if (clients.size > 10_000) {
      for (const [client, value] of clients) {
        if (timestamp >= value.resetAt) clients.delete(client);
      }
    }
    next();
  };
}

export function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

function isLoopbackAddress(address = '') {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function readToken(req) {
  const authorization = req.get('Authorization') || '';
  if (authorization.startsWith('Bearer ')) {
    return authorization.slice(7).trim();
  }
  return (req.get('X-Noosphere-Token') || '').trim();
}

function tokensEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
