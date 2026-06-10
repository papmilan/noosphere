import 'dotenv/config';

import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addProjectAction,
  getActionReceipt,
  getProjectActionReceipts,
  getProjectBlobIds,
  getProjectDemoAgents,
  getProjectGenomeIds,
} from './registry.js';
import { addDecision, getGenomeScores } from './sui.js';
import { downloadBlob, STORAGE_EPOCHS, uploadBlob } from './walrus.js';
import {
  getScoringPolicy,
  neutralScore,
  scoreAction,
  signScoreResult,
} from './scorer.js';

export const app = express();
const port = Number(process.env.PORT || 3001);
const demoMode = process.env.DEMO_MODE === 'true';
const directory = path.dirname(fileURLToPath(import.meta.url));

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, Idempotency-Key, X-Agent-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(directory, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    network: demoMode ? 'local demo' : 'Sui testnet',
    demo_mode: demoMode,
    scorer_configured: Boolean(process.env.ANTHROPIC_API_KEY),
    scorer_key_configured: Boolean(process.env.SCORER_PRIVATE_KEY),
  });
});

app.get('/.well-known/noosphere.json', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    name: 'Noosphere',
    version: '1.0.0',
    description:
      'The shared mind for AI agents. Persistent memory and reputation layer for any AI agent, stored on Walrus and verified on Sui.',
    protocol: 'https',
    authentication: demoMode
      ? { type: 'none', mode: 'local-demo' }
      : { type: 'relayer-managed-sui-signer' },
    endpoints: {
      submit_action: `${baseUrl}/v1/actions`,
      project_context: `${baseUrl}/v1/projects/{project_id}/context`,
      project_agents: `${baseUrl}/v1/projects/{project_id}/agents`,
      scoring_policy: `${baseUrl}/scoring-policy`,
      openapi: `${baseUrl}/openapi.json`,
    },
    capabilities: [
      'shared-project-memory',
      'agent-reputation',
      'immutable-ai-ratings',
      'cross-agent-comparison',
      'walrus-blob-storage',
      'sui-testnet',
      'plain-text-context',
    ],
    agent_compatibility: {
      agent_id: 'Any non-empty string',
      provider: 'Optional provider name',
      model: 'Optional model name',
      client: 'Optional IDE, CLI, framework, or runtime name',
      metadata: 'Optional JSON object',
    },
    scoring: {
      source: 'Noosphere scorer only; caller-provided scores are ignored',
      model: 'claude-haiku-4-5-20251001',
      range: '-10 to +10',
      policy_version: '1.0.0',
      scorer_version: 'noosphere-scorer-v1.0',
      on_chain_event: 'noosphere::noosphere::DecisionScored',
    },
  });
});

app.get('/openapi.json', (req, res) => {
  res.json(buildOpenApiDocument(getBaseUrl(req)));
});

app.get('/scoring-policy', (_req, res) => {
  res.json(getScoringPolicy());
});

app.post(['/action', '/v1/actions'], async (req, res, next) => {
  try {
    const action = validateAction(req.body);
    const actionId =
      requireOptionalString(req.get('Idempotency-Key')) || randomUUID();
    const previousReceipt = await getActionReceipt(
      action.project_id,
      actionId,
    );
    if (previousReceipt) {
      res.status(200).json({
        success: true,
        action_id: actionId,
        blob_id: previousReceipt.blob_id,
        tx_digest: previousReceipt.tx_digest,
        score_delta: previousReceipt.score_delta,
        score_breakdown: previousReceipt.score_breakdown,
        score_reasoning: previousReceipt.score_reasoning,
        score_automatic: previousReceipt.score_automatic,
        score_status: previousReceipt.score_status,
        scorer_model: previousReceipt.scorer_model,
        scorer_version: previousReceipt.scorer_version,
        scored_by: previousReceipt.scored_by,
        score_signature: previousReceipt.score_signature,
        scoring_policy_version: previousReceipt.scoring_policy_version,
        deduplicated: true,
      });
      return;
    }

    const timestamp = Date.now();
    const scoring = await resolveActionScore({ ...action, timestamp });
    const finalScoreDelta = scoring.score_delta;

    const agentAction = {
      schema_version: '1.0',
      action_id: actionId,
      project_id: action.project_id,
      agent_id: action.agent_id,
      genome_object_id: action.genome_object_id,
      provider: action.provider,
      model: action.model,
      client: action.client,
      session_id: action.session_id,
      action_type: action.action_type,
      content: action.content,
      timestamp,
      stored_at: new Date(timestamp).toISOString(),
      storage_epochs: STORAGE_EPOCHS,
      score_delta: finalScoreDelta,
      score_reasoning: scoring.reasoning,
      score_breakdown: scoring.dimensions,
      score_automatic: scoring.automatic,
      score_status: scoring.score_status,
      scorer_model: scoring.scorer_model,
      scorer_version: scoring.scorer_version,
      scored_by: scoring.scored_by,
      score_signature: scoring.score_signature,
      scoring_policy_version: scoring.scoring_policy_version,
      metadata: action.metadata,
    };

    console.log(
      `[action] Uploading ${agentAction.agent_id}/${agentAction.action_type} for ${agentAction.project_id}`,
    );

    const bytes = new TextEncoder().encode(JSON.stringify(agentAction));
    const blobId = await uploadBlob(bytes);
    const isPositive = finalScoreDelta >= 0;
    const scoreDelta = Math.abs(finalScoreDelta);

    console.log(`[action] Blob ${blobId} uploaded; updating genome`);
    let txDigest;
    try {
      txDigest = await addDecision({
        genomeObjectId: action.genome_object_id,
        blobId,
        scoreDelta,
        isPositive,
      });
    } catch (suiError) {
      console.error(
        `[action] Sui tx failed after blob upload — blob ${blobId} is orphaned on Walrus`,
        suiError,
      );
      throw suiError;
    }

    await addProjectAction(action.project_id, {
      blobId,
      genomeObjectId: action.genome_object_id,
      agentId: action.agent_id,
      provider: action.provider,
      model: action.model,
      client: action.client,
      scoreDelta: finalScoreDelta,
      actionId,
      txDigest,
      scoreBreakdown: scoring.dimensions,
      scoreReasoning: scoring.reasoning,
      scoreAutomatic: scoring.automatic,
      scoreStatus: scoring.score_status,
      scorerModel: scoring.scorer_model,
      scorerVersion: scoring.scorer_version,
      scoredBy: scoring.scored_by,
      scoreSignature: scoring.score_signature,
      scoringPolicyVersion: scoring.scoring_policy_version,
    });

    console.log(`[action] Completed in transaction ${txDigest}`);
    res.status(201).json({
      success: true,
      action_id: agentAction.action_id,
      blob_id: blobId,
      tx_digest: txDigest,
      score_delta: finalScoreDelta,
      score_breakdown: scoring.dimensions,
      score_reasoning: scoring.reasoning,
      score_automatic: scoring.automatic,
      score_status: scoring.score_status,
      scorer_model: scoring.scorer_model,
      scorer_version: scoring.scorer_version,
      scored_by: scoring.scored_by,
      score_signature: scoring.score_signature,
      scoring_policy_version: scoring.scoring_policy_version,
    });
  } catch (error) {
    next(error);
  }
});

app.get(
  ['/context/:project_id', '/v1/projects/:project_id/context'],
  async (req, res, next) => {
  try {
    const projectId = requireNonEmptyString(
      req.params.project_id,
      'project_id',
    );
    const { actions, failedBlobIds, context } =
      await loadProjectData(projectId);

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
      context,
      actions,
      failed_blob_ids: failedBlobIds,
    });
  } catch (error) {
    next(error);
  }
  },
);

app.get(
  ['/agents/:project_id', '/v1/projects/:project_id/agents'],
  async (req, res, next) => {
  try {
    const projectId = requireNonEmptyString(
      req.params.project_id,
      'project_id',
    );
    const [genomeObjectIds, receipts] = await Promise.all([
      getProjectGenomeIds(projectId),
      getProjectActionReceipts(projectId),
    ]);
    const agents = demoMode
      ? await getProjectDemoAgents(projectId)
      : await getGenomeScores(genomeObjectIds);
    const receiptActions = Object.values(receipts);

    res.json({
      success: true,
      project_id: projectId,
      agents: enrichAgentsWithRatings(agents, receiptActions),
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
  server = app.listen(port, () => {
    console.log(`🧠 Noosphere is live on port ${port}`);
    console.log(`Mode: ${demoMode ? 'local demo' : 'Sui testnet'}`);
  });
}

function validateAction(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  return {
    project_id: requireNonEmptyString(body.project_id, 'project_id'),
    agent_id: requireNonEmptyString(body.agent_id, 'agent_id'),
    genome_object_id: requireNonEmptyString(
      body.genome_object_id,
      'genome_object_id',
    ),
    action_type: requireNonEmptyString(body.action_type, 'action_type'),
    content: requireNonEmptyString(body.content, 'content'),
    session_id: requireNonEmptyString(body.session_id, 'session_id'),
    provider: requireOptionalString(body.provider),
    model: requireOptionalString(body.model),
    client: requireOptionalString(body.client),
    metadata: requireOptionalObject(body.metadata, 'metadata'),
  };
}

function formatProjectContext(projectId, actions) {
  const lines = actions.map((action) => {
    const timestamp = new Date(Number(action.timestamp)).toISOString();
    return `[${timestamp}] ${action.agent_id} (${action.action_type}): ${action.content}`;
  });

  return [
    `--- PROJECT CONTEXT: ${projectId} ---`,
    ...lines,
    '--- END CONTEXT ---',
  ].join('\n');
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function requireOptionalString(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw badRequest('Optional identity fields must be strings');
  }

  return value.trim() || null;
}

function requireOptionalObject(value, fieldName) {
  if (value === undefined || value === null) {
    return {};
  }
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
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function buildOpenApiDocument(baseUrl) {
  const actionSchema = {
    type: 'object',
    required: [
      'project_id',
      'agent_id',
      'genome_object_id',
      'action_type',
      'content',
      'session_id',
    ],
    properties: {
      project_id: { type: 'string' },
      agent_id: {
        type: 'string',
        description: 'Any stable agent identity; no vendor allowlist.',
      },
      genome_object_id: { type: 'string' },
      action_type: { type: 'string' },
      content: { type: 'string' },
      session_id: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      client: { type: 'string' },
      metadata: {
        type: 'object',
        additionalProperties: true,
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Noosphere API',
      version: '1.0.0',
      description:
        'Vendor-neutral API for persistent AI agent memory and reputation.',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/v1/actions': {
        post: {
          operationId: 'submitAgentAction',
          summary: 'Store an agent action and update its genome',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: actionSchema },
            },
          },
          responses: {
            201: { description: 'Action stored and reputation updated' },
            400: { description: 'Invalid action' },
          },
        },
      },
      '/v1/projects/{project_id}/context': {
        get: {
          operationId: 'getProjectContext',
          summary: 'Get shared project memory',
          parameters: [
            {
              name: 'project_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'format',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['json', 'text'] },
            },
          ],
          responses: {
            200: {
              description: 'Prompt-ready context and raw actions',
              content: {
                'application/json': {},
                'text/plain': {},
              },
            },
          },
        },
      },
      '/v1/projects/{project_id}/agents': {
        get: {
          operationId: 'getProjectAgents',
          summary: 'Get project agent genomes and current scores',
          parameters: [
            {
              name: 'project_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description:
                'Agent reputation plus verified average output ratings',
            },
          },
        },
      },
      '/scoring-policy': {
        get: {
          operationId: 'getScoringPolicy',
          summary: 'Get the active public scoring policy',
          responses: {
            200: {
              description: 'Versioned policy and verified prompt hash',
            },
          },
        },
      },
    },
  };
}

function enrichAgentsWithRatings(agents, actions) {
  return agents
    .map((agent) => {
      const ratings = actions
        .filter(isVerifiedRating)
        .filter(
          (action) =>
            action.genome_object_id === agent.genome_object_id ||
            (!action.genome_object_id &&
              action.agent_id === agent.agent_name),
        )
        .map((action) => Number(action.score_delta));
      const ratingTotal = ratings.reduce((total, score) => total + score, 0);

      return {
        ...agent,
        average_rating:
          ratings.length > 0 ? ratingTotal / ratings.length : null,
        verified_rating_count: ratings.length,
      };
    })
    .sort(
      (a, b) =>
        (b.average_rating ?? -Infinity) - (a.average_rating ?? -Infinity) ||
        (b.reputation_score ?? 0) - (a.reputation_score ?? 0),
    );
}

function isVerifiedRating(action) {
  if (action.score_status) {
    return action.score_status === 'scored';
  }

  return (
    action.score_automatic === true &&
    !String(action.score_reasoning || '').includes('unavailable')
  );
}

async function loadProjectContext(projectId) {
  const { context } = await loadProjectData(projectId);
  return context;
}

export async function resolveActionScore(
  action,
  {
    contextLoader = loadProjectContext,
    scorer = scoreAction,
  } = {},
) {
  try {
    const projectContext = await contextLoader(action.project_id);
    const { score_delta: _ignoredScoreDelta, ...scorableAction } = action;
    return await scorer(scorableAction, projectContext);
  } catch (error) {
    console.warn('Scorer unavailable, using neutral score');
    if (process.env.NODE_ENV === 'development') {
      console.warn('[scorer]', error.message);
    }
    return signScoreResult(neutralScore(), action);
  }
}

async function loadProjectData(projectId) {
  const [blobIds, receipts] = await Promise.all([
    getProjectBlobIds(projectId),
    getProjectActionReceipts(projectId),
  ]);
  console.log(`[context] Loading ${blobIds.length} blobs for ${projectId}`);
  const results = await Promise.allSettled(
    blobIds.map(async (blobId) => {
      const bytes = await downloadBlob(blobId);
      const action = JSON.parse(new TextDecoder().decode(bytes));
      const receipt = receipts[action.action_id] || {};
      return {
        ...action,
        blob_id: blobId,
        tx_digest: receipt.tx_digest || null,
      };
    }),
  );
  const actions = [];
  const failedBlobIds = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      actions.push(result.value);
    } else {
      const blobId = blobIds[index];
      failedBlobIds.push(blobId);
      console.error(`[context] Failed to read blob ${blobId}`, result.reason);
    }
  });
  actions.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

  return {
    actions,
    failedBlobIds,
    context: formatProjectContext(projectId, actions),
  };
}
