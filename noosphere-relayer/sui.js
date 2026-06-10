import 'dotenv/config';

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { randomUUID } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { Transaction } from '@mysten/sui/transactions';

const rpcUrl =
  process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';

export const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: rpcUrl,
});

let relayerKeypair;
const demoMode = process.env.DEMO_MODE === 'true';

export function getRelayerKeypair() {
  if (relayerKeypair) {
    return relayerKeypair;
  }

  const encoded = process.env.RELAYER_PRIVATE_KEY;
  if (!encoded) {
    throw new Error('RELAYER_PRIVATE_KEY is required');
  }

  const decoded = decodeBase64(encoded);
  let scheme = 0;
  let secretKey = decoded;

  // Sui keystore entries prefix the 32-byte secret key with a scheme flag.
  if (decoded.length === 33) {
    [scheme] = decoded;
    secretKey = decoded.slice(1);
  } else if (decoded.length !== 32) {
    throw new Error(
      'RELAYER_PRIVATE_KEY must decode to a 32-byte key or 33-byte Sui keystore value',
    );
  }

  switch (scheme) {
    case 0:
      relayerKeypair = Ed25519Keypair.fromSecretKey(secretKey);
      break;
    case 1:
      relayerKeypair = Secp256k1Keypair.fromSecretKey(secretKey);
      break;
    case 2:
      relayerKeypair = Secp256r1Keypair.fromSecretKey(secretKey);
      break;
    default:
      throw new Error(`Unsupported Sui signature scheme flag: ${scheme}`);
  }

  return relayerKeypair;
}

export async function addDecision({
  genomeObjectId,
  blobId,
  scoreDelta,
  isPositive,
}) {
  if (demoMode) {
    return `demo-tx-${randomUUID()}`;
  }

  const packageId = process.env.PACKAGE_ID;
  if (!packageId) {
    throw new Error('PACKAGE_ID is required');
  }

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::noosphere::add_decision`,
    arguments: [
      tx.object(genomeObjectId),
      tx.pure.string(blobId),
      tx.pure.u64(BigInt(scoreDelta)),
      tx.pure.bool(isPositive),
      tx.object.clock(),
    ],
  });

  const result = await suiClient.core.signAndExecuteTransaction({
    transaction: tx,
    signer: getRelayerKeypair(),
    include: { effects: true },
  });

  if (result.FailedTransaction) {
    const err = result.FailedTransaction.status.error;
    const errMsg = err?.message ?? err?.$kind ?? 'unknown error';
    throw new Error(`Sui transaction failed: ${errMsg}`);
  }

  return result.Transaction.digest;
}

export async function getGenomeScores(genomeObjectIds) {
  if (genomeObjectIds.length === 0) {
    return [];
  }

  const { objects } = await suiClient.core.getObjects({
    objectIds: genomeObjectIds,
    include: { json: true },
  });

  return objects.map((object, index) => {
    const genomeObjectId = genomeObjectIds[index];
    if (object instanceof Error) {
      return {
        genome_object_id: genomeObjectId,
        error: object.message,
      };
    }

    const fields = object.json || {};
    return {
      genome_object_id: genomeObjectId,
      agent_name: fields.agent_name ?? null,
      project_id: fields.project_id ?? null,
      reputation_score: toSafeNumber(fields.reputation_score),
      decision_count: toSafeNumber(fields.decision_count),
    };
  });
}

function decodeBase64(value) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('RELAYER_PRIVATE_KEY is not valid base64');
  }

  return new Uint8Array(Buffer.from(normalized, 'base64'));
}

function toSafeNumber(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const number = Number(value);
  return Number.isSafeInteger(number) ? number : String(value);
}
