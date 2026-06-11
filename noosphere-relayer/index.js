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
import {
  getScoringPolicy,
  neutralScore,
  scoreAction,
} from './scorer.js';
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
    },
    security: {
      host: securityConfig.host,
      authentication:
        securityConfig.apiToken ? 'bearer-token' : 'loopback-only',
      cors_origins: securityConfig.corsOrigins,
    },
    scorer_configured: Boolean(process.env.ANTHROPIC_API_KEY),
    scoring_mode: process.env.SCORING_MODE || 'private',
  });
});

app.get('/.well-known/noosphere.json', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    name: 'Noosphere',
    version: '2.0.0',
    description:
      'A thin, vendor-neutral agent memory and evaluation layer built on Walrus Memory.',
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
      scoring_policy: `${baseUrl}/scoring-policy`,
      openapi: `${baseUrl}/openapi.json`,
    },
    universal_interfaces: {
      filesystem: ['.noosphere/context.md', '.noosphere/journal.md'],
      cli: ['context', 'recall', 'remember', 'journal', 'protocol'],
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

app.get('/scoring-policy', (_req, res) => {
  res.json(getScoringPolicy());
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
    res.json({
      success: true,
      configured: status.present && !status.invalid,
      backend: status.backend,
      account_id: status.account_id || null,
      network: status.network || null,
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
      res.json({ ...previousReceipt, deduplicated: true });
      return;
    }

    const pending = await runtimeStore.getPending(receiptKey);
    if (pending) {
      const recovered = await processPendingJob(pending);
      res.json({ ...recovered, deduplicated: true, recovered: true });
      return;
    }

    const timestamp = new Date().toISOString();
    const scoring = await resolveActionScore({ ...action, timestamp });
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
      evaluation: {
        score: scoring.score_delta,
        reasoning: scoring.reasoning,
        dimensions: scoring.dimensions,
        status: scoring.score_status,
        model: scoring.scorer_model,
        policy_version: scoring.scoring_policy_version,
      },
    };
    const responseTemplate = {
      success: true,
      action_id: actionId,
      score_delta: scoring.score_delta,
      score_breakdown: scoring.dimensions,
      score_reasoning: scoring.reasoning,
      score_status: scoring.score_status,
      scorer_model: scoring.scorer_model,
      scoring_policy_version: scoring.scoring_policy_version,
      privacy: {
        scoring_mode: process.env.SCORING_MODE || 'private',
        remote_evaluation:
          process.env.SCORING_MODE === 'remote' &&
          scoring.score_status === 'scored',
      },
      storage: memoryStore.mode,
    };
    const job = await runtimeStore.enqueue(receiptKey, {
      projectId: record.project_id,
      serializedRecord: serializeMemory(record),
      responseTemplate,
    });

    console.log(
      `[memory] Remembering ${record.agent_id}/${record.action_type} in ${record.project_id}`,
    );
    const response = await processPendingJob(job);
    res.status(201).json(response);
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
    void recoverPendingJobs();
  });
  installShutdownHandlers();
}

export async function resolveActionScore(
  action,
  {
    contextLoader = loadRelevantContext,
    scorer = scoreAction,
  } = {},
) {
  try {
    const { score_delta: _ignoredScore, ...scorableAction } = action;
    const projectContext = await contextLoader(scorableAction);
    return await scorer(scorableAction, projectContext);
  } catch (error) {
    console.warn('Scorer unavailable, using neutral score');
    if (process.env.NODE_ENV === 'development') {
      console.warn('[scorer]', error.message);
    }
    return neutralScore();
  }
}

async function loadRelevantContext(action) {
  const memories = await recallProject(
    action.project_id,
    action.content,
    8,
  );
  return formatProjectContext(action.project_id, action.content, memories);
}

async function recallProject(projectId, query, limit) {
  const result = await memoryStore.recall(projectId, query, limit);
  return result.results
    .map((memory) => {
      const record = parseMemory(memory.text) || {
        schema: 'walrus-memory.external',
        action_id: memory.blob_id,
        project_id: projectId,
        agent_id: 'mcp-agent',
        action_type: 'memory',
        content: memory.text,
        timestamp: null,
        evaluation: null,
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

  const operation = retryOperation(
    async () => {
      const stored = await memoryStore.remember(
        job.projectId,
        job.serializedRecord,
      );
      const response = {
        ...job.responseTemplate,
        blob_id: stored.blob_id,
        memory_id: stored.id,
        namespace: stored.namespace,
      };
      await runtimeStore.complete(job.key, response);
      return response;
    },
    {
      attempts: uploadAttempts,
      baseDelayMs: uploadRetryBaseMs,
      onFailure: (error) => runtimeStore.markAttempt(job.key, error),
    },
  )
    .catch((error) => {
      error.status = error.status || 503;
      throw error;
    })
    .finally(() => {
      activeJobs.delete(job.key);
    });
  activeJobs.set(job.key, operation);
  return operation;
}

async function recoverPendingJobs() {
  const pending = await runtimeStore.listPending();
  if (pending.length === 0) return;
  console.log(`[queue] Recovering ${pending.length} pending upload(s)`);
  for (const job of pending) {
    try {
      await processPendingJob(job);
      console.log(`[queue] Recovered ${job.key}`);
    } catch (error) {
      console.error(`[queue] Recovery failed for ${job.key}: ${error.message}`);
    }
  }
}

function installShutdownHandlers() {
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal} received`);
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
  const lines = actions.map((action) => {
    const score = action.evaluation?.score;
    const scoreLabel = Number.isFinite(score) ? `, evaluation ${score}` : '';
    return `[${action.timestamp || 'time not recorded'}] ${action.agent_id} (${action.action_type}${scoreLabel}): ${action.content}`;
  });

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
    '1. Read this context before changing the project.',
    '2. Inspect the current working tree; another tool may have edited it.',
    '3. Record concise findings, decisions, evidence, and next steps.',
    '4. Do not expose hidden chain-of-thought. Provide a brief, verifiable rationale.',
    '5. Before stopping, store a handoff through POST /v1/actions.',
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
          summary: 'Evaluate and remember an agent action',
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
      '/scoring-policy': {
        get: {
          operationId: 'getScoringPolicy',
          summary: 'Get the transparent evaluation policy',
          responses: { 200: { description: 'Versioned scoring policy' } },
        },
      },
    },
  };
}
