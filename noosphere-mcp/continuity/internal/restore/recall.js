import { secureRelayerFetch } from '../../relayer-authority.js';
import { TrustStoreError } from '../../trust-store-internal.js';
import {
  AUTHORITY_PAYLOAD_BYTES,
  OBSERVATION_PAYLOAD_BYTES,
  RESTORE_SLOTS,
} from './constants.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const REMOTE_METADATA_LIMIT = 4_096;

function restoreError(code, message) {
  return new TrustStoreError(code, message);
}

function validateMetadataValue(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') > REMOTE_METADATA_LIMIT) {
    throw restoreError(
      'restore-source-metadata-invalid',
      `restore source ${field} metadata is invalid`,
    );
  }
  return value;
}

function exactUtf8Bytes(value) {
  if (typeof value !== 'string') {
    throw restoreError(
      'restore-source-content-invalid',
      'restore source content must be a UTF-8 string',
    );
  }
  const bytes = Buffer.from(value, 'utf8');
  let decoded;
  try {
    decoded = UTF8.decode(bytes);
  } catch {
    throw restoreError(
      'restore-source-content-invalid',
      'restore source content is not valid UTF-8',
    );
  }
  if (decoded !== value) {
    throw restoreError(
      'restore-source-content-invalid',
      'restore source content is not canonical UTF-8 text',
    );
  }
  if (bytes.length === 0) {
    throw restoreError(
      'restore-source-empty',
      'restore source content is empty',
    );
  }
  if (bytes.length > AUTHORITY_PAYLOAD_BYTES) {
    throw restoreError(
      'restore-source-too-large',
      'restore source content exceeds the fixed authority payload limit',
    );
  }
  return bytes;
}

export async function recallRestoreSource({ slot, recall }) {
  const selector = RESTORE_SLOTS[slot];
  if (!selector || typeof recall !== 'function') {
    throw restoreError('restore-source-invalid', 'restore source request is invalid');
  }
  const response = await recall(Object.freeze({
    query: selector.query,
    filters: Object.freeze({ action_type: selector.actionType }),
    limit: 1,
  }));
  if (!response || typeof response !== 'object' ||
      !Array.isArray(response.memories)) {
    throw restoreError(
      'restore-source-response-invalid',
      'restore recall response is malformed',
    );
  }
  if (response.memories.length === 0) return null;
  const first = response.memories[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    throw restoreError(
      'restore-source-result-invalid',
      'top-ranked restore result is malformed',
    );
  }
  if (first.action_type !== selector.actionType) {
    throw restoreError(
      'restore-source-action-type-mismatch',
      'top-ranked restore result has the wrong action type',
    );
  }
  const content = exactUtf8Bytes(first.content);
  return Object.freeze({
    content,
    metadata: Object.freeze({
      actionId: validateMetadataValue(first.action_id, 'action_id'),
      actionType: selector.actionType,
      agentId: validateMetadataValue(first.agent_id, 'agent_id'),
      timestamp: validateMetadataValue(first.timestamp, 'timestamp'),
      blobId: validateMetadataValue(first.blob_id, 'blob_id'),
    }),
  });
}

async function readBoundedResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > OBSERVATION_PAYLOAD_BYTES) {
    throw restoreError(
      'restore-source-response-too-large',
      'restore recall response exceeds the fixed observation limit',
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > OBSERVATION_PAYLOAD_BYTES) {
      await reader.cancel();
      throw restoreError(
        'restore-source-response-too-large',
        'restore recall response exceeds the fixed observation limit',
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

export async function recallRestoreSourceHttp({ slot, config }) {
  return recallRestoreSource({
    slot,
    recall: async request => {
      const projectId = encodeURIComponent(config.project_id);
      let response;
      try {
        response = await secureRelayerFetch(
          `${config.relayer_url}/v1/projects/${projectId}/recall`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              query: request.query,
              action_type: request.filters.action_type,
              limit: request.limit,
            }),
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (error) {
        if (error instanceof TrustStoreError) throw error;
        throw restoreError(
          'restore-source-request-failed',
          `restore recall request failed: ${error.message}`,
        );
      }
      const bytes = await readBoundedResponse(response);
      let parsed;
      try {
        parsed = JSON.parse(UTF8.decode(bytes));
      } catch {
        throw restoreError(
          'restore-source-response-invalid',
          'restore recall response is not valid bounded UTF-8 JSON',
        );
      }
      if (!response.ok) {
        throw restoreError(
          'restore-source-request-failed',
          parsed?.error || `restore recall failed with status ${response.status}`,
        );
      }
      return parsed;
    },
  });
}
