import 'dotenv/config';

import { walrus } from '@mysten/walrus';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRelayerKeypair, suiClient } from './sui.js';

const demoMode = process.env.DEMO_MODE === 'true';
const directory = path.dirname(fileURLToPath(import.meta.url));
const demoBlobDirectory = path.join(directory, 'demo_blobs');
const aggregatorUrl = (
  process.env.WALRUS_AGGREGATOR_URL ||
  'https://aggregator.walrus-testnet.walrus.space'
).replace(/\/+$/, '');

const uploadRelayUrl = (
  process.env.WALRUS_UPLOAD_RELAY_URL ||
  'https://upload-relay.testnet.walrus.space'
).replace(/\/+$/, '');

// 200 epochs ≈ ~13 months at current epoch duration
// Long-term roadmap: automatic renewal via Sui contract
// funded by protocol fees
export const STORAGE_EPOCHS = parsePositiveInteger(
  process.env.WALRUS_EPOCHS || '200',
);

const walrusClient = suiClient.$extend(
  walrus({
    uploadRelay: {
      host: uploadRelayUrl,
      sendTip: { max: 1_000 },
    },
  }),
);

export async function uploadBlob(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Walrus upload expects a Uint8Array');
  }

  if (demoMode) {
    const blobId = `demo-${randomUUID()}`;
    await mkdir(demoBlobDirectory, { recursive: true });
    await writeFile(path.join(demoBlobDirectory, `${blobId}.json`), bytes);
    return blobId;
  }

  const result = await walrusClient.walrus.writeBlob({
    blob: bytes,
    deletable: false,
    epochs: STORAGE_EPOCHS,
    signer: getRelayerKeypair(),
  });

  return result.blobId;
}

export async function downloadBlob(blobId) {
  if (demoMode) {
    if (!blobId.startsWith('demo-')) {
      throw new Error(
        `Cannot fetch real blob "${blobId}" in demo mode; set DEMO_MODE=false to use Walrus`,
      );
    }
    return new Uint8Array(
      await readFile(path.join(demoBlobDirectory, `${blobId}.json`)),
    );
  }

  try {
    return await walrusClient.walrus.readBlob({ blobId });
  } catch (sdkError) {
    console.warn(
      `[walrus] SDK read failed for ${blobId}; trying aggregator`,
      sdkError.message,
    );

    const response = await fetch(
      `${aggregatorUrl}/v1/blobs/${encodeURIComponent(blobId)}`,
    );
    if (!response.ok) {
      throw new Error(
        `Walrus read failed (${response.status} ${response.statusText})`,
        { cause: sdkError },
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('WALRUS_EPOCHS must be a positive integer');
  }

  return parsed;
}
