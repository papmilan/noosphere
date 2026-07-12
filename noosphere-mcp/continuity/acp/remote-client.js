import {
  ACP_LIMITS,
  RECONCILIATION_POLICY_VERSION,
  SYNC_PROTOCOL_VERSION,
} from '@noosphere/acp-protocol';

const DIGEST_ID = /^sha256:[0-9a-f]{64}$/;

export class RemoteStateError extends Error {
  constructor(code, { status = 0, details, cause } = {}) {
    super(code, { cause });
    this.name = 'RemoteStateError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export class RemoteStateClient {
  constructor({ baseUrl, token, fetchImpl = fetch, timeoutMs = 8_000 }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async capabilities() {
    const result = await this.request('/v1/acp/capabilities');
    if (result.sync_protocol_version !== SYNC_PROTOCOL_VERSION
      || result.reconciliation_policy_version !== RECONCILIATION_POLICY_VERSION) {
      throw new RemoteStateError('unsupported-capabilities');
    }
    if (!DIGEST_ID.test(result.relayer_index_id)) throw new RemoteStateError('invalid-relayer-index-id');
    return result;
  }

  async putSnapshot(projectId, envelope, expectedHeadsDigest) {
    const body = JSON.stringify({ envelope, expected_heads_digest: expectedHeadsDigest });
    if (Buffer.byteLength(body, 'utf8') > ACP_LIMITS.snapshotBytes) {
      throw new RemoteStateError('request-too-large');
    }
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/acp/snapshots`, {
      method: 'POST',
      body,
    });
  }

  getHeads(projectId) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/acp/heads`);
  }

  async getSnapshot(projectId, snapshotId) {
    assertSnapshotId(snapshotId);
    return this.withResponse(
      `/v1/projects/${encodeURIComponent(projectId)}/acp/snapshots/${encodeURIComponent(snapshotId)}`,
      {},
      async (response) => {
        if (!response.ok) throw await responseError(response, ACP_LIMITS.snapshotBytes);
        const bytes = await readBounded(response, ACP_LIMITS.snapshotBytes);
        const etag = response.headers.get('etag');
        if (etag !== `"${snapshotId}"`) throw new RemoteStateError('snapshot-mismatch', { status: response.status });
        return {
          bytes,
          etag,
          relayer_index_id: response.headers.get('x-relayer-index-id'),
          headers: response.headers,
        };
      },
    );
  }

  getHistory(projectId, { head, limit = ACP_LIMITS.ancestryEnvelopes } = {}) {
    if (head !== undefined) assertSnapshotId(head);
    if (!Number.isInteger(limit) || limit < 1 || limit > ACP_LIMITS.ancestryEnvelopes) {
      throw new RemoteStateError('history-limit');
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (head !== undefined) query.set('head', head);
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/acp/history?${query}`);
  }

  async request(path, options = {}) {
    return this.withResponse(path, options, async (response) => {
      if (!response.ok) throw await responseError(response, ACP_LIMITS.snapshotBytes);
      const bytes = await readBounded(response, ACP_LIMITS.snapshotBytes);
      try { return JSON.parse(bytes.toString('utf8')); } catch (cause) {
        throw new RemoteStateError('malformed-json', { status: response.status, cause });
      }
    });
  }

  async withResponse(path, options, consume) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RemoteStateError('request-timeout'));
      }, this.timeoutMs);
    });
    try {
      const operation = (async () => {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...options,
          headers: {
            accept: 'application/json',
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...options.headers,
          },
          signal: controller.signal,
        });
        return consume(response);
      })();
      return await Promise.race([operation, timeout]);
    } catch (cause) {
      if (cause instanceof RemoteStateError) throw cause;
      if (controller.signal.aborted) throw new RemoteStateError('request-timeout', { cause });
      throw new RemoteStateError('network-error', { cause });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function responseError(response, limit) {
  let parsed = {};
  try { parsed = JSON.parse((await readBounded(response, limit)).toString('utf8')); } catch (error) {
    if (error instanceof RemoteStateError && error.code === 'response-too-large') return error;
  }
  return new RemoteStateError(parsed.error || 'remote-http-error', {
    status: response.status,
    details: parsed.details,
  });
}

async function readBounded(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new RemoteStateError('response-too-large', { status: response.status });
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RemoteStateError('response-too-large', { status: response.status });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function assertSnapshotId(snapshotId) {
  if (!DIGEST_ID.test(snapshotId)) throw new RemoteStateError('invalid-snapshot-id');
}
