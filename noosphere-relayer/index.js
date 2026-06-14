import 'dotenv/config';

import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DurableStore,
  retryOperation,
} from './durable-store.js';
import {
  memoryStore,
  parseMemory,
  serializeMemory,
} from './memory.js';
import {
  listLocalProjects,
  localProjectControl,
  registerLocalProject,
  pauseLocalProject,
  resumeLocalProject,
  forgetLocalProject,
} from './local-projects.js';
import {
  authenticationMiddleware,
  corsMiddleware,
  rateLimitMiddleware,
  resolveSecurityConfig,
  securityHeaders,
} from './security.js';
import { CredentialStore } from './credentials.js';

export const app = express();
app.disable('x-powered-by');

const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) {
  app.set('trust proxy', trustProxy);
}

const port = Number(process.env.PORT || 3001);
const directory = path.dirname(fileURLToPath(import.meta.url));
export const securityConfig = resolveSecurityConfig(process.env);
export const runtimeStore = new DurableStore({
  filePath:
    process.env.NOOSPHERE_STATE_PATH ||
    path.join(directory, '.noosphere-runtime', 'state.json'),
  persist: process.env.NODE_ENV !== 'test',
});
const activeJobs = new Map();
const uploadAttempts = parsePositiveInteger(
  process.env.UPLOAD_RETRY_ATTEMPTS,
  3,
  'UPLOAD_RETRY_ATTEMPTS',
);
const uploadRetryBaseMs = parsePositiveInteger(
  process.env.UPLOAD_RETRY_BASE_MS,
  1_000,
  'UPLOAD_RETRY_BASE_MS',
);
const queueRecoveryIntervalMs = parsePositiveInteger(
  process.env.QUEUE_RECOVERY_INTERVAL_MS,
  30_000,
  'QUEUE_RECOVERY_INTERVAL_MS',
);
const queueRetryMaxMs = parsePositiveInteger(
  process.env.QUEUE_RETRY_MAX_MS,
  5 * 60_000,
  'QUEUE_RETRY_MAX_MS',
);
const uploadMinIntervalMs =
  process.env.NODE_ENV === 'test'
    ? 0
    : parsePositiveInteger(
        process.env.UPLOAD_MIN_INTERVAL_MS,
        30_000,
        'UPLOAD_MIN_INTERVAL_MS',
      );
let queueRecoveryTimer = null;
let queuePausedUntil = 0;
let uploadInProgress = false;
let lastUploadAttemptMonotonic = 0;

app.use(securityHeaders);
app.use(corsMiddleware(securityConfig));
app.use(rateLimitMiddleware(securityConfig));

app.use((req, res, next) => {
  const suppliedRequestId = req.get('X-Request-ID') || '';
  req.id = /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : randomUUID();
  res.set('X-Request-ID', req.id);
  const start = Date.now();
  res.on('finish', () => {
    if (process.env.NODE_ENV !== 'test') {
      console.log(JSON.stringify({
        time: new Date().toISOString(),
        request_id: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start
      }));
    }
  });
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(directory, 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Noosphere' });
});

app.get('/ready', async (_req, res) => {
  const [memory, pending, state] = await Promise.all([
    memoryStore.health(),
    runtimeStore.listPending(),
    runtimeStore.health(),
  ]);
  const uploadDelayMs = uploadDelayRemaining();
  const ready = memory.ready && state.ready;
  const status = ready ? 200 : 503;
  res.status(status).json({
    success: ready,
    service: 'Noosphere',
    memory,
    queue: {
      pending: pending.length,
      durable: state.durable,
      writable: state.ready,
      paused_until:
        queuePausedUntil > Date.now()
          ? new Date(queuePausedUntil).toISOString()
          : null,
      upload_in_progress: uploadInProgress,
      next_upload_at:
        uploadDelayMs > 0
          ? new Date(Date.now() + uploadDelayMs).toISOString()
          : null,
    },
    security: {
      host: securityConfig.host,
      authentication:
        securityConfig.apiToken ? 'bearer-token' : 'loopback-only',
      cors_origins: securityConfig.corsOrigins,
    },
  });
});

app.get('/.well-known/noosphere.json', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    name: 'Noosphere',
    version: '2.0.0',
    description:
      'Persistent shared project memory for AI agents, built on Walrus Memory.',
    architecture: {
      memory: 'Official Walrus Memory managed relayer',
      encryption: 'Seal encryption managed by Walrus Memory',
      search: 'Walrus Memory semantic recall',
      access_control: 'Walrus Memory account and delegate permissions',
      custom_smart_contract: false,
    },
    security: {
      loopback_default: true,
      external_authentication: 'Bearer token',
      cors_origins: securityConfig.corsOrigins,
      rate_limit_per_window: securityConfig.rateLimitMax,
      rate_limit_window_ms: securityConfig.rateLimitWindowMs,
      durable_upload_queue: true,
    },
    endpoints: {
      remember: `${baseUrl}/v1/actions`,
      recall: `${baseUrl}/v1/projects/{project_id}/recall`,
      context: `${baseUrl}/v1/projects/{project_id}/context`,
      bootstrap: `${baseUrl}/v1/projects/{project_id}/bootstrap`,
      local_projects: `${baseUrl}/v1/local/projects`,
      openapi: `${baseUrl}/openapi.json`,
    },
    universal_interfaces: {
      filesystem: [
        '.noosphere/master-prompt.md',
        '.noosphere/followups.jsonl',
        '.noosphere/context.md',
        '.noosphere/journal.md',
      ],
      cli: [
        'context',
        'recall',
        'remember',
        'journal',
        'master-prompt',
        'protocol',
      ],
      http: true,
      mcp: true,
    },
    mcp: {
      package: '@mysten-incubation/memwal-mcp',
      tools: [
        'memwal_remember',
        'memwal_recall',
        'memwal_analyze',
        'memwal_restore',
      ],
    },
  });
});

app.get('/openapi.json', (req, res) => {
  res.json(buildOpenApiDocument(getBaseUrl(req)));
});

app.use('/v1', authenticationMiddleware(securityConfig));

app.get(
  '/v1/local/projects',
  localProjectControl(securityConfig),
  async (_req, res, next) => {
    try {
      const projects = await listLocalProjects();
      res.json({ success: true, projects });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  '/v1/local/projects',
  localProjectControl(securityConfig),
  async (req, res, next) => {
    try {
      const registered = await registerLocalProject(req.body?.path);
      res.status(201).json({
        success: true,
        ...registered,
      });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  '/v1/local/projects/:project_id/pause',
  localProjectControl(securityConfig),
  async (req, res, next) => {
    try {
      await pauseLocalProject(req.params.project_id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/v1/local/projects/:project_id/resume',
  localProjectControl(securityConfig),
  async (req, res, next) => {
    try {
      await resumeLocalProject(req.params.project_id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/v1/local/projects/:project_id/forget',
  localProjectControl(securityConfig),
  async (req, res, next) => {
    try {
      await forgetLocalProject(req.params.project_id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/v1/local/projects/:project_id/retry',
  localProjectControl(securityConfig),
  async (req, res, next) => {
    try {
      const pendingJobs = await runtimeStore.listPending();
      const requestedKey = requireOptionalString(req.body?.job_id);
      const candidates = pendingJobs
        .filter((job) => job.projectId === req.params.project_id)
        .sort(
          (a, b) =>
            (b.lastAttemptAt || b.createdAt || 0) -
            (a.lastAttemptAt || a.createdAt || 0),
        );
      const job = requestedKey
        ? candidates.find((candidate) => candidate.key === requestedKey)
        : candidates[0];
      if (!job) {
        res.status(404).json({ success: false, error: 'No pending job found' });
        return;
      }
      if (activeJobs.has(job.key)) {
        res.status(409).json({ success: false, error: 'Job is already active' });
        return;
      }
      await runtimeStore.reschedule(job.key);
      if (!canAttemptUpload()) {
        scheduleQueueRecovery(uploadDelayRemaining());
        res.status(202).json(queuedResponse(job));
        return;
      }
      void processPendingJob(job).catch((error) => {
        console.error(
          JSON.stringify({
            event: 'upload_retry_failed',
            project_id: job.projectId,
            error: error.message,
          }),
        );
      });
      res.status(202).json({
        success: true,
        message: 'Retry initiated',
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  '/v1/local/projects/state',
  localProjectControl(securityConfig),
  async (req, res, next) => {
    try {
      const projects = await listLocalProjects();
      const pendingJobs = await runtimeStore.listPending();

      const states = await Promise.all(projects.map(async (project) => {
        let lastCheckpoint = null;
        try {
          const stateJson = await readFile(
            path.join(project.path, '.noosphere', 'state.json'),
            'utf8',
          );
          const parsed = JSON.parse(stateJson);
          lastCheckpoint = parsed.last_checkpoint_at || null;
        } catch {
          // A project may not have checkpointed yet.
        }

        const projPending = pendingJobs
          .filter((job) => job.projectId === project.project_id)
          .sort(
            (a, b) =>
              (b.lastAttemptAt || b.createdAt || 0) -
              (a.lastAttemptAt || a.createdAt || 0),
          );
        const latestFailure = projPending.find((job) => job.lastError);

        return {
          project_id: project.project_id,
          path: project.path,
          enabled: project.enabled,
          last_checkpoint_at: lastCheckpoint,
          pending_count: projPending.length,
          latest_failure: latestFailure?.lastError || null,
          retry_job_id: latestFailure?.key || projPending[0]?.key || null,
        };
      }));
      res.json({ success: true, states });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  '/v1/local/credentials/status',
  localProjectControl(securityConfig),
  (_req, res) => {
    const status = new CredentialStore('default').status();
    const environmentConfigured = Boolean(
      process.env.MEMWAL_ACCOUNT_ID && process.env.MEMWAL_PRIVATE_KEY,
    );
    const secureStoreConfigured = status.present && !status.invalid;
    res.json({
      success: true,
      configured: secureStoreConfigured || environmentConfigured,
      backend: secureStoreConfigured
        ? status.backend
        : environmentConfigured
          ? 'environment-file'
          : status.backend,
      account_id:
        status.account_id || process.env.MEMWAL_ACCOUNT_ID || null,
      network:
        status.network || process.env.MEMWAL_NETWORK || 'mainnet',
    });
  },
);

app.post('/v1/actions', async (req, res, next) => {
  try {
    const action = validateAction(req.body);
    const actionId =
      requireOptionalString(req.get('Idempotency-Key')) || randomUUID();
    const receiptKey = `${action.project_id}:${actionId}`;

    const previousReceipt = await runtimeStore.getReceipt(receiptKey);
    if (previousReceipt) {
      res.json({
        ...normalizeMemoryResponse(previousReceipt),
        deduplicated: true,
      });
      return;
    }

    const pending = await runtimeStore.getPending(receiptKey);
    if (pending) {
      if (
        activeJobs.has(pending.key) ||
        !canAttemptUpload() ||
        (pending.nextAttemptAt && pending.nextAttemptAt > Date.now())
      ) {
        res.status(202).json({
          ...queuedResponse(pending),
          deduplicated: true,
        });
        return;
      }
      try {
        const recovered = await processPendingJob(pending);
        res.json({ ...recovered, deduplicated: true, recovered: true });
      } catch {
        scheduleQueueRecovery();
        res.status(202).json({
          ...queuedResponse(pending),
          deduplicated: true,
        });
      }
      return;
    }

    const timestamp = new Date().toISOString();
    const record = {
      schema: 'noosphere.agent-memory.v2',
      action_id: actionId,
      project_id: action.project_id,
      agent_id: action.agent_id,
      action_type: action.action_type,
      content: action.content,
      session_id: action.session_id,
      provider: action.provider,
      model: action.model,
      client: action.client,
      metadata: action.metadata,
      timestamp,
    };
    const responseTemplate = {
      success: true,
      action_id: actionId,
      storage: memoryStore.mode,
    };
    const job = await runtimeStore.enqueue(receiptKey, {
      projectId: record.project_id,
      actionType: record.action_type,
      serializedRecord: serializeMemory(record),
      responseTemplate,
    });

    console.log(
      `[memory] Remembering ${record.agent_id}/${record.action_type} in ${record.project_id}`,
    );
    if (!canAttemptUpload()) {
      scheduleQueueRecovery(uploadDelayRemaining());
      res.status(202).json(queuedResponse(job));
      return;
    }
    try {
      const response = await processPendingJob(job);
      res.status(201).json(response);
    } catch {
      scheduleQueueRecovery();
      res.status(202).json(queuedResponse(job));
    }
  } catch (error) {
    next(error);
  }
});

const recallRouteHandler = async (req, res, next) => {
  try {
    const projectId = requireNonEmptyString(
      req.params.project_id,
      'project_id',
    );
    const query = requireNonEmptyString(
      req.method === 'GET' ? req.query.q : req.body?.query,
      'query',
    );
    const limit = parseLimit(
      req.method === 'GET' ? req.query.limit : req.body?.limit,
    );
    const recalled = await recallProject(projectId, query, limit);

    res.json({
      success: true,
      project_id: projectId,
      query,
      retrieval: 'semantic',
      total: recalled.length,
      memories: recalled,
    });
  } catch (error) {
    next(error);
  }
};

app.get('/v1/projects/:project_id/recall', recallRouteHandler);
app.post('/v1/projects/:project_id/recall', recallRouteHandler);

app.get(
  '/v1/projects/:project_id/bootstrap',
  async (req, res, next) => {
    try {
      const projectId = requireNonEmptyString(
        req.params.project_id,
        'project_id',
      );
      const query =
        requireOptionalString(req.query.q) ||
        'latest project state failures decisions tests blockers and next steps';
      const actions = await recallProject(
        projectId,
        query,
        parseLimit(req.query.limit, 30),
      );
      const context = formatProjectContext(projectId, query, actions);
      res.type('text/plain').send(formatBootstrap(projectId, context));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  '/v1/projects/:project_id/context',
  async (req, res, next) => {
    try {
      const projectId = requireNonEmptyString(
        req.params.project_id,
        'project_id',
      );
      const query =
        requireOptionalString(req.query.q) ||
        'current project status decisions changes bugs findings and next steps';
      const actions = await recallProject(
        projectId,
        query,
        parseLimit(req.query.limit, 20),
      );
      const context = formatProjectContext(projectId, query, actions);

      if (
        req.query.format === 'text' ||
        req.accepts(['json', 'text']) === 'text'
      ) {
        res.type('text/plain').send(context);
        return;
      }

      res.json({
        success: true,
        project_id: projectId,
        query,
        retrieval: 'semantic',
        context,
        actions,
      });
    } catch (error) {
      next(error);
    }
  },
);

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  console.error('[error]', error);
  res.status(status).json({
    success: false,
    error: status === 500 ? 'Internal server error' : error.message,
    ...(process.env.NODE_ENV === 'development' && { details: error.message }),
  });
});

export let server = null;

if (process.env.NODE_ENV !== 'test') {
  await runtimeStore.initialize();
  server = app.listen(port, securityConfig.host, () => {
    console.log(
      `Noosphere is live on ${securityConfig.host}:${port}`,
    );
    console.log(`Memory backend: ${memoryStore.mode}`);
    scheduleQueueRecovery(0);
  });
  installShutdownHandlers();
}

async function recallProject(projectId, query, limit) {
  const result = await memoryStore.recall(projectId, query, limit);
  return result.results
    .map((memory) => {
      const parsed = parseMemory(memory.text);
      const record = parsed ? normalizeMemoryRecord(parsed) : {
        schema: 'walrus-memory.external',
        action_id: memory.blob_id,
        project_id: projectId,
        agent_id: 'mcp-agent',
        action_type: 'memory',
        content: memory.text,
        timestamp: null,
      };
      return {
        ...record,
        blob_id: memory.blob_id,
        distance: memory.distance,
      };
    })
    .sort(
      (a, b) =>
        (a.distance ?? 1) - (b.distance ?? 1) ||
        (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0),
    );
}

async function processPendingJob(job) {
  if (activeJobs.has(job.key)) return activeJobs.get(job.key);
  if (!canAttemptUpload()) {
    const error = new Error('Walrus upload lane is cooling down');
    error.status = 429;
    throw error;
  }
  uploadInProgress = true;
  lastUploadAttemptMonotonic = performance.now();

  const operation = retryOperation(
    async () => {
      const stored = await memoryStore.remember(
        job.projectId,
        job.serializedRecord,
      );
      const response = normalizeMemoryResponse({
        ...job.responseTemplate,
        blob_id: stored.blob_id,
        memory_id: stored.id,
        namespace: stored.namespace,
      });
      await runtimeStore.complete(job.key, response);
      return response;
    },
    {
      attempts: uploadAttempts,
      baseDelayMs: uploadRetryBaseMs,
      shouldRetry: (error) => !isRateLimited(error),
      onFailure: async (error) => {
        const current = await runtimeStore.getPending(job.key);
        const delay = retryDelayFor(error, (current?.attempts || 0) + 1);
        await runtimeStore.markAttempt(job.key, error, {
          nextAttemptAt: Date.now() + delay,
        });
        if (isRateLimited(error)) {
          queuePausedUntil = Math.max(queuePausedUntil, Date.now() + delay);
        }
      },
    },
  )
    .catch((error) => {
      error.status = error.status || 503;
      throw error;
    })
    .finally(() => {
      activeJobs.delete(job.key);
      uploadInProgress = false;
      scheduleQueueRecovery(uploadDelayRemaining());
    });
  activeJobs.set(job.key, operation);
  return operation;
}

async function recoverPendingJobs() {
  if (!canAttemptUpload()) {
    scheduleQueueRecovery(uploadDelayRemaining());
    return;
  }
  const pending = prioritizePendingJobs(await runtimeStore.listPending());
  const job = pending.find(
    (candidate) =>
      !activeJobs.has(candidate.key) &&
      (!candidate.nextAttemptAt || candidate.nextAttemptAt <= Date.now()),
  );
  if (!job) {
    const nextAttempt = pending
      .map((candidate) => candidate.nextAttemptAt)
      .filter((value) => value && value > Date.now())
      .sort((a, b) => a - b)[0];
    if (pending.length > 0) {
      scheduleQueueRecovery(
        nextAttempt
          ? Math.max(queueRecoveryIntervalMs, nextAttempt - Date.now())
          : queueRecoveryIntervalMs,
      );
    }
    return;
  }

  console.log(`[queue] Recovering 1 of ${pending.length} pending upload(s)`);
  try {
    await processPendingJob(job);
    console.log(`[queue] Recovered ${job.key}`);
  } catch (error) {
    console.error(`[queue] Recovery failed for ${job.key}: ${error.message}`);
  }
  scheduleQueueRecovery();
}

export function prioritizePendingJobs(jobs) {
  return [...jobs].sort((a, b) => {
    const priorityDifference =
      pendingJobPriority(a) - pendingJobPriority(b);
    if (priorityDifference !== 0) return priorityDifference;

    const aCreated = a.createdAt || 0;
    const bCreated = b.createdAt || 0;
    if (isCheckpointJob(a)) return bCreated - aCreated;
    return aCreated - bCreated;
  });
}

function pendingJobPriority(job) {
  return isCheckpointJob(job) ? 1 : 0;
}

function isCheckpointJob(job) {
  return (
    job.actionType === 'checkpoint' ||
    String(job.key || '').includes(':checkpoint-')
  );
}

function scheduleQueueRecovery(delay = queueRecoveryIntervalMs) {
  if (process.env.NODE_ENV === 'test') return;
  if (queueRecoveryTimer) clearTimeout(queueRecoveryTimer);
  queueRecoveryTimer = setTimeout(() => {
    queueRecoveryTimer = null;
    void recoverPendingJobs();
  }, Math.max(0, delay));
  queueRecoveryTimer.unref();
}

function canAttemptUpload() {
  return !uploadInProgress && uploadDelayRemaining() === 0;
}

function uploadDelayRemaining() {
  return Math.max(
    0,
    queuePausedUntil - Date.now(),
    lastUploadAttemptMonotonic + uploadMinIntervalMs - performance.now(),
  );
}

function queuedResponse(job) {
  return {
    ...normalizeMemoryResponse(job.responseTemplate),
    success: true,
    pending: true,
    action_id: job.responseTemplate?.action_id || job.key.split(':').at(-1),
    message: 'Accepted into the durable Walrus upload queue',
  };
}

export function retryDelayFor(error, attempt) {
  const retryAfter = String(error?.message || '').match(
    /retry_after_seconds["']?\s*[:=]\s*(\d+)/i,
  );
  if (retryAfter) return Number(retryAfter[1]) * 1_000;
  return Math.min(
    uploadRetryBaseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 8),
    queueRetryMaxMs,
  );
}

export function isRateLimited(error) {
  return /\b429\b|rate limit/i.test(String(error?.message || ''));
}

function installShutdownHandlers() {
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal} received`);
    if (queueRecoveryTimer) clearTimeout(queueRecoveryTimer);
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    server.close(async () => {
      await runtimeStore.writeChain.catch(() => undefined);
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

function validateAction(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  return {
    project_id: requireNonEmptyString(body.project_id, 'project_id'),
    agent_id: requireNonEmptyString(body.agent_id, 'agent_id'),
    action_type: requireNonEmptyString(body.action_type, 'action_type'),
    content: requireNonEmptyString(body.content, 'content'),
    session_id: requireOptionalString(body.session_id) || randomUUID(),
    provider: requireOptionalString(body.provider),
    model: requireOptionalString(body.model),
    client: requireOptionalString(body.client),
    metadata: requireOptionalObject(body.metadata, 'metadata'),
  };
}

function formatProjectContext(projectId, query, actions) {
  const lines = actions.map(
    (action) =>
      `[${action.timestamp || 'time not recorded'}] ${action.agent_id} (${action.action_type}): ${action.content}`,
  );

  return [
    `--- NOOSPHERE CONTEXT: ${projectId} ---`,
    `Semantic query: ${query}`,
    ...lines,
    '--- END NOOSPHERE CONTEXT ---',
  ].join('\n');
}

function formatBootstrap(projectId, context) {
  return [
    '# NOOSPHERE UNIVERSAL AGENT BOOTSTRAP',
    '',
    `Project: ${projectId}`,
    '',
    'Protocol:',
    '1. Read .noosphere/master-prompt.md first when available.',
    '2. Read .noosphere/followups.jsonl in order when available.',
    '3. Treat the original prompt plus follow-ups as current user intent.',
    '4. Read this recalled context before changing the project.',
    '5. Inspect the current working tree; another tool may have edited it.',
    '6. Record concise findings, decisions, evidence, and next steps.',
    '7. Do not expose hidden chain-of-thought. Provide a brief, verifiable rationale.',
    '8. Before stopping, store a handoff through POST /v1/actions.',
    '',
    context,
    '',
  ].join('\n');
}

function parseLimit(value, fallback = 10) {
  if (value === undefined || value === null || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw badRequest('limit must be an integer from 1 to 100');
  }
  return limit;
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function requireOptionalString(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw badRequest('Optional identity fields must be strings');
  }
  return value.trim() || null;
}

function requireOptionalObject(value, fieldName) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${fieldName} must be a JSON object`);
  }
  return value;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

export function parseTrustProxy(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return value;
}

function buildOpenApiDocument(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Noosphere API',
      version: '2.0.0',
      description:
        'Thin agent-memory API backed by the official Walrus Memory service.',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
    paths: {
      '/v1/actions': {
        post: {
          security: [{ bearerAuth: [] }],
          operationId: 'rememberAgentAction',
          summary: 'Remember an agent action',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'project_id',
                    'agent_id',
                    'action_type',
                    'content',
                  ],
                  properties: {
                    project_id: { type: 'string' },
                    agent_id: { type: 'string' },
                    action_type: { type: 'string' },
                    content: { type: 'string' },
                    session_id: { type: 'string' },
                    provider: { type: 'string' },
                    model: { type: 'string' },
                    client: { type: 'string' },
                    metadata: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Memory stored through Walrus Memory' },
          },
        },
      },
      '/v1/local/projects': {
        get: {
          security: [{ bearerAuth: [] }],
          operationId: 'listLocalProjects',
          summary:
            'List projects watched by this local Noosphere installation',
          responses: {
            200: { description: 'Registered local projects' },
            404: { description: 'Unavailable on non-loopback deployments' },
          },
        },
        post: {
          security: [{ bearerAuth: [] }],
          operationId: 'registerLocalProject',
          summary:
            'Initialize and watch a local Git project by explicit path',
          responses: {
            201: { description: 'Project registered locally' },
            404: { description: 'Unavailable on non-loopback deployments' },
          },
        },
      },
      '/v1/projects/{project_id}/recall': {
        post: {
          security: [{ bearerAuth: [] }],
          operationId: 'recallProjectMemory',
          summary: 'Semantically recall project memories',
          responses: { 200: { description: 'Relevant memories' } },
        },
      },
      '/v1/projects/{project_id}/context': {
        get: {
          security: [{ bearerAuth: [] }],
          operationId: 'getProjectContext',
          summary: 'Get prompt-ready semantic project context',
          responses: { 200: { description: 'Prompt-ready context' } },
        },
      },
      '/v1/projects/{project_id}/bootstrap': {
        get: {
          security: [{ bearerAuth: [] }],
          operationId: 'bootstrapAnyAgent',
          summary: 'Get universal instructions and project context',
          responses: {
            200: {
              description:
                'Plain-text bootstrap compatible with any HTTP client',
            },
          },
        },
      },
    },
  };
}

function normalizeMemoryRecord(record) {
  return definedEntries({
    schema: record.schema,
    action_id: record.action_id,
    project_id: record.project_id,
    agent_id: record.agent_id,
    action_type: record.action_type,
    content: record.content,
    session_id: record.session_id,
    provider: record.provider,
    model: record.model,
    client: record.client,
    metadata: record.metadata,
    timestamp: record.timestamp,
  });
}

function normalizeMemoryResponse(response = {}) {
  return definedEntries({
    success: response.success,
    action_id: response.action_id,
    storage: response.storage,
    blob_id: response.blob_id,
    memory_id: response.memory_id,
    namespace: response.namespace,
    pending: response.pending,
    message: response.message,
    deduplicated: response.deduplicated,
    recovered: response.recovered,
  });
}

function definedEntries(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}
