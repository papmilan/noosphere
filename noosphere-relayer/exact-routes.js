import express from 'express';

export function createExactRouter({ service, limits, submitSnapshot } = {}) {
  const router = express.Router();

  router.get('/acp/capabilities', route(async (_req, res) => {
    res.json({ success: true, ...await service.getCapabilities(), limits });
  }));

  router.post('/projects/:project_id/acp/snapshots', route(async (req, res) => {
    const capabilities = await service.getCapabilities();
    res.set('X-Relayer-Index-Id', capabilities.relayer_index_id);
    const operation = submitSnapshot
      ? await submitSnapshot(req.params.project_id, req.body?.envelope, req.body?.expected_heads_digest)
      : await service.putSnapshot(req.params.project_id, req.body?.envelope, req.body?.expected_heads_digest);
    const result = operation?.result || operation;
    const status = operation?.status || (result.created ? 201 : 200);
    res.status(status).json({ success: true, ...result });
  }));

  router.get('/projects/:project_id/acp/heads', route(async (req, res) => {
    const [heads, capabilities] = await Promise.all([
      service.getHeads(req.params.project_id), service.getCapabilities(),
    ]);
    res.set('X-Relayer-Index-Id', capabilities.relayer_index_id).json({
      success: true,
      ...capabilities,
      limits,
      ...heads,
    });
  }));

  router.get('/projects/:project_id/acp/snapshots/:snapshot_id', route(async (req, res) => {
    const [result, capabilities] = await Promise.all([
      service.getSnapshot(req.params.project_id, req.params.snapshot_id), service.getCapabilities(),
    ]);
    res.set('X-Relayer-Index-Id', capabilities.relayer_index_id)
      .set('ETag', `"${result.snapshot_id}"`).type('application/json').send(result.bytes);
  }));

  router.get('/projects/:project_id/acp/history', route(async (req, res) => {
    const limit = parseBoundedHistoryLimit(req.query.limit, 1, limits.ancestryEnvelopes);
    const [history, capabilities] = await Promise.all([
      service.getHistory(req.params.project_id, { head: req.query.head, limit }),
      service.getCapabilities(),
    ]);
    res.set('X-Relayer-Index-Id', capabilities.relayer_index_id).json({ success: true, history });
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
  if (receipt) {
    const {
      expected_heads_digest: storedDigest,
      submission_project_id: storedProjectId,
      canonical_envelope: storedCanonicalEnvelope,
      ...storedResult
    } = receipt;
    if ((storedProjectId !== undefined && storedProjectId !== projectId)
      || (storedCanonicalEnvelope !== undefined && storedCanonicalEnvelope !== canonicalEnvelope)) {
      throw httpError('snapshot-submission-conflict', 409);
    }
    if (storedCanonicalEnvelope === undefined
      && storedDigest !== undefined && storedDigest !== expectedHeadsDigest) {
      throw httpError('stale-heads', 409);
    }
    return { status: 200, result: { ...storedResult, created: false, deduplicated: true } };
  }
  const pending = await store.getPending(key);
  if (pending) {
    const sameSubmission = pending.projectId === projectId
      && pending.canonicalEnvelope === canonicalEnvelope;
    if (pending.terminal && pending.terminalError?.code === 'stale-heads'
      && sameSubmission && pending.expectedHeadsDigest !== expectedHeadsDigest) {
      const revived = await store.reviveStalePending(key, {
        kind: 'acp-snapshot', projectId, snapshotId, canonicalEnvelope, expectedHeadsDigest,
      });
      if (revived.revived) return { status: 202, result: queuedSnapshot(revived.pending) };
      if (!revived.pending) {
        return submitExactSnapshot({
          projectId, envelope, canonicalEnvelope, expectedHeadsDigest, service, store,
        });
      }
      if (revived.pending.terminal) throw terminalError(revived.pending);
      if (revived.pending.projectId === projectId
        && revived.pending.canonicalEnvelope === canonicalEnvelope
        && revived.pending.expectedHeadsDigest === expectedHeadsDigest) {
        return { status: 202, result: queuedSnapshot(revived.pending) };
      }
      throw httpError('snapshot-submission-conflict', 409);
    }
    if (pending.terminal) throw terminalError(pending);
    if (!sameSubmission || pending.expectedHeadsDigest !== expectedHeadsDigest) {
      throw httpError('snapshot-submission-conflict', 409);
    }
    return { status: 202, result: queuedSnapshot(pending) };
  }

  try {
    const result = await service.putSnapshot(projectId, envelope, expectedHeadsDigest);
    await completeSnapshot(store, key, {
      expectedHeadsDigest, projectId, canonicalEnvelope,
    }, result);
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
  if (job.terminal) throw terminalError(job);
  try {
    const envelope = JSON.parse(job.canonicalEnvelope);
    const result = await service.putSnapshot(job.projectId, envelope, job.expectedHeadsDigest);
    await completeSnapshot(store, job.key, {
      expectedHeadsDigest: job.expectedHeadsDigest,
      projectId: job.projectId,
      canonicalEnvelope: job.canonicalEnvelope,
    }, result);
    return result;
  } catch (error) {
    if (!isRetryableExactError(error)) await store.markTerminal(job.key, error);
    throw error;
  }
}

function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = responseStatus(error);
      const generic = isUnknownServerError(error, status);
      if (status >= 500) {
        console.error('[exact-state-error]', {
          status,
          code: generic ? 'internal-server-error' : error.code,
        });
      }
      res.status(status).json({
        success: false,
        error: generic ? 'internal-server-error' : error.code || error.message || 'exact-state-error',
        ...(generic || error.details === undefined ? {} : { details: error.details }),
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

export function isRetryableExactError(error) {
  if (error?.retryable === true) return true;
  return [502, 503, 504].includes(Number(error?.status));
}

function completeSnapshot(store, key, submission, result) {
  return store.complete(key, {
    ...result,
    expected_heads_digest: submission.expectedHeadsDigest,
    submission_project_id: submission.projectId,
    canonical_envelope: submission.canonicalEnvelope,
  });
}

function terminalError(job) {
  return httpError(job.terminalError?.code || 'exact-state-terminal', job.terminalError?.status || 409);
}

function isUnknownServerError(error, status) {
  return status >= 500 && !['project-byte-limit', 'snapshot-index-limit'].includes(error?.code);
}

function queuedSnapshot(job) {
  return {
    pending: true,
    snapshot_id: job.snapshotId,
    message: 'Accepted into the durable ACP snapshot queue',
  };
}
