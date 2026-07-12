import express from 'express';

export function createExactRouter({ service, limits, submitSnapshot } = {}) {
  const router = express.Router();

  router.get('/acp/capabilities', route(async (_req, res) => {
    res.json({ success: true, ...await service.getCapabilities(), limits });
  }));

  router.post('/projects/:project_id/acp/snapshots', route(async (req, res) => {
    const operation = submitSnapshot
      ? await submitSnapshot(req.params.project_id, req.body?.envelope, req.body?.expected_heads_digest)
      : await service.putSnapshot(req.params.project_id, req.body?.envelope, req.body?.expected_heads_digest);
    const result = operation?.result || operation;
    const status = operation?.status || (result.created ? 201 : 200);
    res.status(status).json({ success: true, ...result });
  }));

  router.get('/projects/:project_id/acp/heads', route(async (req, res) => {
    res.json({ success: true, ...await service.getHeads(req.params.project_id) });
  }));

  router.get('/projects/:project_id/acp/snapshots/:snapshot_id', route(async (req, res) => {
    const result = await service.getSnapshot(req.params.project_id, req.params.snapshot_id);
    res.set('ETag', `"${result.snapshot_id}"`).type('application/json').send(result.bytes);
  }));

  router.get('/projects/:project_id/acp/history', route(async (req, res) => {
    const limit = parseBoundedHistoryLimit(req.query.limit, 1, limits.ancestryEnvelopes);
    const history = await service.getHistory(req.params.project_id, {
      head: req.query.head,
      limit,
    });
    res.json({ success: true, history });
  }));

  return router;
}

export function parseBoundedHistoryLimit(value, minimum = 1, maximum = 200) {
  if (value === undefined || value === null || value === '') return maximum;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < minimum || limit > maximum) {
    throw httpError('history-limit', 400);
  }
  return limit;
}

export async function submitExactSnapshot({
  projectId,
  envelope,
  canonicalEnvelope,
  expectedHeadsDigest,
  service,
  store,
}) {
  const snapshotId = envelope.snapshot_id;
  const key = `acp-snapshot:${snapshotId}`;
  const receipt = await store.getReceipt(key);
  if (receipt) return { status: 200, result: { ...receipt, created: false, deduplicated: true } };
  const pending = await store.getPending(key);
  if (pending) return { status: 202, result: queuedSnapshot(pending) };

  try {
    const result = await service.putSnapshot(projectId, envelope, expectedHeadsDigest);
    await store.complete(key, result);
    return { status: result.created ? 201 : 200, result };
  } catch (error) {
    if (!isRetryableExactError(error)) throw error;
    const job = await store.enqueue(key, {
      kind: 'acp-snapshot',
      projectId,
      snapshotId,
      canonicalEnvelope,
      expectedHeadsDigest,
    });
    return { status: 202, result: queuedSnapshot(job) };
  }
}

export async function processAcpSnapshotJob(job, { service, store }) {
  if (job.kind !== 'acp-snapshot') throw new Error(`unsupported-job-kind:${job.kind}`);
  const envelope = JSON.parse(job.canonicalEnvelope);
  const result = await service.putSnapshot(job.projectId, envelope, job.expectedHeadsDigest);
  await store.complete(job.key, result);
  return result;
}

function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = responseStatus(error);
      res.status(status).json({
        success: false,
        error: error.code || error.message || 'exact-state-error',
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }
  };
}

function responseStatus(error) {
  if (/^(invalid-|missing-|unsupported-|snapshot-mismatch|integrity-mismatch|project-id-mismatch)/.test(error.code || '')) {
    return 422;
  }
  if (error.status) return error.status;
  return 500;
}

function httpError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function isRetryableExactError(error) {
  if (error?.retryable) return true;
  if (Number(error?.status) >= 500) return true;
  return !error?.status && !String(error?.code || '').startsWith('snapshot-')
    && !['stale-heads', 'head-limit', 'project-byte-limit', 'project-id-mismatch'].includes(error?.code);
}

function queuedSnapshot(job) {
  return {
    pending: true,
    snapshot_id: job.snapshotId,
    message: 'Accepted into the durable ACP snapshot queue',
  };
}
