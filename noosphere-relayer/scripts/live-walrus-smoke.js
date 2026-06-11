import { randomUUID } from 'node:crypto';

import { WalrusMemoryAdapter } from '../walrus-memory.js';

const adapter = new WalrusMemoryAdapter();
const marker = `Noosphere live workflow ${randomUUID()}`;
const namespace = `noosphere-live-${Date.now()}`;

const stored = await adapter.remember(marker, namespace);
const recalled = await adapter.recall(marker, 5, namespace);
if (!recalled.results?.some((result) => result.text?.includes(marker))) {
  throw new Error(`Stored blob ${stored.blob_id} was not recalled`);
}

console.log(
  JSON.stringify({
    success: true,
    blob_id: stored.blob_id,
    namespace,
  }),
);
