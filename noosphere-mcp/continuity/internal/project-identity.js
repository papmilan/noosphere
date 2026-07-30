import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { canonicalize } from '../trust-store-internal.js';
import { AUTH_DOMAINS } from './authenticated-records.js';

const HEX_64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
      binding.domain !== AUTH_DOMAINS.projectBinding ||
      binding.type !== 'project-binding' ||
      !UUID_V4.test(binding.projectIdentity)) {
    throw new TypeError('project binding identity is invalid');
  }
  if (typeof binding.ownerScope !== 'string' || binding.ownerScope.length === 0) {
    throw new TypeError('owner scope is invalid');
  }
  if (!HEX_64.test(binding.keyId)) {
    throw new TypeError('machine key identity is invalid');
  }
  if (!HEX_64.test(binding.realpathHash)) {
    throw new TypeError('binding realpath hash is invalid');
  }
}

function validateCanonicalBindingBytes(canonicalBindingBytes, binding) {
  if (!Buffer.isBuffer(canonicalBindingBytes)) {
    throw new TypeError('binding bytes must be a buffer');
  }
  let decoded;
  try {
    decoded = UTF8_FATAL.decode(canonicalBindingBytes);
  } catch {
    throw new TypeError('binding bytes are not valid UTF-8');
  }
  if (decoded !== canonicalize(binding)) {
    throw new TypeError('binding bytes are not canonical');
  }
}

export function canonicalProjectIdentity({
  canonicalBindingBytes,
  canonicalRealpath,
  binding,
}) {
  validateBinding(binding);
  validateCanonicalBindingBytes(canonicalBindingBytes, binding);
  if (typeof canonicalRealpath !== 'string' || canonicalRealpath.length === 0) {
    throw new TypeError('canonical realpath is invalid');
  }
  const realpathHash = sha256(Buffer.from(canonicalRealpath, 'utf8'));
  if (realpathHash !== binding.realpathHash) {
    throw new TypeError('canonical realpath does not match binding');
  }
  return Object.freeze({
    bindingIdentifier: `sha256:${sha256(canonicalBindingBytes)}`,
    canonicalFilesystemIdentity: `sha256:${realpathHash}`,
    identitySchema: 'noosphere.sec05.project-identity',
    identityVersion: 1,
    machineKeyIdentity: binding.keyId,
    ownerScope: binding.ownerScope,
    projectIdentity: binding.projectIdentity,
  });
}

export function projectIdentityDigest(identity) {
  return `sha256:${sha256(Buffer.from(canonicalize(identity), 'utf8'))}`;
}
