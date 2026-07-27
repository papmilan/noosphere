import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { canonicalize } from '../continuity/trust-store-internal.js';
import {
  canonicalProjectIdentity,
  projectIdentityDigest,
} from '../continuity/internal/project-identity.js';

const PROJECT_IDENTITY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_ID = 'b'.repeat(64);
const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const canonicalRealpath = '/srv/Project/é';
  const binding = Object.freeze({
    domain: 'noosphere/sec05/v2/project-binding',
    format: 2,
    type: 'project-binding',
    projectIdentity: PROJECT_IDENTITY,
    ownerScope: 'uid:1000',
    realpathHash: sha256(Buffer.from(canonicalRealpath, 'utf8')),
    keyId: KEY_ID,
    mac: 'c'.repeat(64),
  });
  return {
    binding,
    canonicalBindingBytes: Buffer.from(canonicalize(binding), 'utf8'),
    canonicalRealpath,
  };
}

describe('SEC-05 Phase 4C — canonical project identity', () => {
  it('contains exactly the normative fields and authenticated binding values', () => {
    const input = fixture();
    const identity = canonicalProjectIdentity(input);

    assert.deepEqual(identity, {
      bindingIdentifier: `sha256:${sha256(input.canonicalBindingBytes)}`,
      canonicalFilesystemIdentity:
        `sha256:${sha256(Buffer.from(input.canonicalRealpath, 'utf8'))}`,
      identitySchema: 'noosphere.sec05.project-identity',
      identityVersion: 1,
      machineKeyIdentity: KEY_ID,
      ownerScope: 'uid:1000',
      projectIdentity: PROJECT_IDENTITY,
    });
    assert.match(projectIdentityDigest(identity), /^sha256:[0-9a-f]{64}$/);
    assert.equal(
      projectIdentityDigest(identity),
      `sha256:${sha256(Buffer.from(canonicalize(identity), 'utf8'))}`,
    );
  });

  it('hashes exact realpath UTF-8 bytes without normalization or case folding', () => {
    const input = fixture();
    const identity = canonicalProjectIdentity(input);
    const changed = {
      ...input,
      canonicalRealpath: input.canonicalRealpath.normalize('NFD').toLowerCase(),
    };

    assert.notEqual(changed.canonicalRealpath, input.canonicalRealpath);
    assert.throws(
      () => canonicalProjectIdentity(changed),
      /canonical realpath does not match binding/,
    );
    assert.equal(
      identity.canonicalFilesystemIdentity,
      `sha256:${input.binding.realpathHash}`,
    );
  });

  it('rejects noncanonical binding bytes and invalid authenticated binding fields', () => {
    const input = fixture();
    assert.throws(
      () => canonicalProjectIdentity({
        ...input,
        canonicalBindingBytes: Buffer.from(` ${canonicalize(input.binding)}`, 'utf8'),
      }),
      /binding bytes are not canonical/,
    );
    assert.throws(
      () => canonicalProjectIdentity({
        ...input,
        binding: { ...input.binding, keyId: 'not-a-key-id' },
      }),
      /machine key identity is invalid/,
    );
  });

  it('derives the canonical identity from the authenticated production binding', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-4c-home-'));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-4c-project-'));
    temporary.push(home, project);
    const store = createFormatV2Store({
      env: {
        NOOSPHERE_HOME: home,
        NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
      },
    });

    const binding = await store.createProjectBinding(project);
    const identity = await store.readCanonicalProjectIdentity(project);

    assert.equal(binding.domain, 'noosphere/sec05/v2/project-binding');
    assert.equal(identity.projectIdentity, binding.projectIdentity);
    assert.equal(identity.ownerScope, binding.ownerScope);
    assert.equal(identity.machineKeyIdentity, binding.keyId);
    assert.equal(
      await store.canonicalProjectIdentityDigest(project),
      projectIdentityDigest(identity),
    );
  });
});
