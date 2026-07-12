import { exactError } from './snapshot-backend.js';

export class WalrusSnapshotBackend {
  constructor({ adapter, exactCopy, indexHealth = async () => ({ durable: false }), shared = true }) {
    this.adapter = adapter;
    this.exactCopy = exactCopy;
    this.indexHealth = indexHealth;
    this.shared = shared;
    this.locators = new Map();
  }

  async put(projectId, snapshotId, canonicalBytes) {
    const exact = await this.exactCopy.put(projectId, snapshotId, canonicalBytes);
    const uploaded = await upload(this.adapter, canonicalBytes, projectId);
    const locator = uploaded?.blobId || uploaded?.blob_id || uploaded?.id || null;
    if (locator) this.locators.set(`${projectId}\0${snapshotId}`, locator);
    return { backend: 'walrus', locator, bytes: canonicalBytes.length, exact_copy: exact };
  }

  async get(projectId, snapshotId, storage = null) {
    const locator = storage?.locator || this.locators.get(`${projectId}\0${snapshotId}`);
    if (locator && typeof this.adapter.getByBlobId === 'function') {
      try {
        const result = await this.adapter.getByBlobId(locator);
        return Buffer.from(result?.bytes ?? result);
      } catch {
        // The exact local copy is authoritative when the shared replica is unavailable.
      }
    }
    return this.exactCopy.get(projectId, snapshotId);
  }

  async health() {
    const [fileHealth, indexHealth] = await Promise.all([this.exactCopy.health(), this.indexHealth()]);
    const exactWalrusRead = typeof this.adapter.getByBlobId === 'function';
    return {
      ready: Boolean(fileHealth.ready),
      durable: Boolean(fileHealth.durable),
      shared: this.shared,
      deployment_mode: 'walrus-backed/relayer-indexed',
      exact_bytes_durable: Boolean(fileHealth.durable),
      index_durable: Boolean(indexHealth.durable),
      cross_machine_recoverable: this.shared && Boolean(fileHealth.durable)
        && Boolean(indexHealth.shared) && Boolean(indexHealth.durable),
      walrus_exact_read: exactWalrusRead,
    };
  }
}

async function upload(adapter, bytes, projectId) {
  if (typeof adapter.put === 'function') return adapter.put(bytes, projectId);
  if (typeof adapter.remember === 'function') return adapter.remember(bytes.toString('base64'), `acp-exact:${projectId}`);
  throw exactError('walrus-upload-unavailable', 503);
}
