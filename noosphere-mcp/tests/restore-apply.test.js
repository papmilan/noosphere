import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';

import { applyRestoreCandidate } from '../continuity/internal/restore/apply-service.js';
import {
  readCandidateState,
  stageRestoreCandidate,
} from '../continuity/internal/restore/candidate-store.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { isSlotAuthoritative } from '../continuity/trust-store.js';
import * as secureFs from '../continuity/secure-fs.js';

const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

function ttyStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  return { input, output };
}

async function fixture({
  slot = 'baseline',
  content = '# Noosphere project baseline\n\nrestored body\n',
} = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-apply-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-apply-project-'));
  temporary.push(home, project);
  await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
  };
  const actionType = {
    baseline: 'project-baseline',
    instructions: 'project-instructions',
    'master-prompt': 'master-prompt',
  }[slot];
  const staged = await stageRestoreCandidate({
    projectRoot: project,
    slot,
    env,
    ...ttyStreams(),
    recall: async () => ({
      memories: [{ action_type: actionType, content }],
    }),
  });
  return {
    candidate: staged.candidate,
    content,
    env,
    home,
    project,
    slot,
  };
}

function destination(context) {
  const name = context.slot === 'master-prompt'
    ? 'master-prompt.md'
    : `${context.slot}.md`;
  return path.join(context.project, '.noosphere', name);
}

describe('SEC-05 Phase 4C — final restore apply barrier', () => {
  it('runs the complete final barrier before the first temporary write', async () => {
    const context = await fixture();
    await fs.writeFile(destination(context), 'old destination');
    const events = [];
    const recordingSecureFs = {
      ...secureFs,
      prepareOwnerOnlyReplacement: async (...args) => {
        events.push('temporary-write');
        return secureFs.prepareOwnerOnlyReplacement(...args);
      },
    };

    await applyRestoreCandidate({
      projectRoot: context.project,
      env: context.env,
      candidateId: context.candidate.candidateId,
      confirm: () => true,
      onBarrier: () => events.push('barrier'),
      secureFs: recordingSecureFs,
    });

    assert.deepEqual(events.slice(0, 2), ['barrier', 'temporary-write']);
    assert.equal(await fs.readFile(destination(context), 'utf8'), context.content);
  });

  it('refuses a destination change after confirmation before any temporary write', async () => {
    const context = await fixture();
    await fs.writeFile(destination(context), 'observed destination');
    const events = [];
    await assert.rejects(
      applyRestoreCandidate({
        projectRoot: context.project,
        env: context.env,
        candidateId: context.candidate.candidateId,
        confirm: () => true,
        afterConfirmation: async () => {
          await fs.writeFile(destination(context), 'changed after confirmation');
        },
        secureFs: {
          ...secureFs,
          prepareOwnerOnlyReplacement: async (...args) => {
            events.push('temporary-write');
            return secureFs.prepareOwnerOnlyReplacement(...args);
          },
        },
      }),
      error => error.code === 'ERR_RESTORE_FINAL_BARRIER',
    );
    assert.deepEqual(events, []);
    assert.equal(
      await fs.readFile(destination(context), 'utf8'),
      'changed after confirmation',
    );
  });

  it('classifies an unsafe destination as a security refusal before issuing state', async () => {
    const context = await fixture();
    const outside = path.join(context.project, 'outside');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, destination(context));

    await assert.rejects(
      applyRestoreCandidate({
        projectRoot: context.project,
        env: context.env,
        candidateId: context.candidate.candidateId,
        confirm: () => true,
      }),
      error => error.code === 'ERR_RESTORE_FINAL_BARRIER',
    );
    const projectIdentity = context.candidate.projectIdentityDigest;
    assert.match(projectIdentity, /^sha256:/);
    const projectsRoot = path.join(context.home, 'trust-v2', 'projects');
    const [identityDirectory] = await fs.readdir(projectsRoot);
    await assert.rejects(
      fs.access(path.join(
        projectsRoot,
        identityDirectory,
        'restore',
        'confirmations',
      )),
    );
  });

  it('detects a destination race after the barrier before creating the temporary file', async () => {
    const context = await fixture();
    await fs.writeFile(destination(context), 'barrier-observed');
    const events = [];
    await assert.rejects(
      applyRestoreCandidate({
        projectRoot: context.project,
        env: context.env,
        candidateId: context.candidate.candidateId,
        confirm: () => true,
        onBarrier: async () => {
          events.push('barrier');
          await fs.writeFile(destination(context), 'raced after barrier');
        },
        secureFs: {
          ...secureFs,
          prepareOwnerOnlyReplacement: (file, bytes, options) =>
            secureFs.prepareOwnerOnlyReplacement(file, bytes, {
              ...options,
              writeExclusive: async (...args) => {
                events.push('temporary-write');
                return secureFs.writeOwnerOnlyFileExclusive(...args);
              },
            }),
        },
      }),
      error => error.code === 'ERR_RESTORE_APPLY_FAILED' &&
        /state-destination-changed/.test(error.message),
    );
    assert.deepEqual(events, ['barrier']);
    assert.equal(
      await fs.readFile(destination(context), 'utf8'),
      'raced after barrier',
    );
  });

  it('holds no slot lock during confirmation and consumes failed pre-write state', async () => {
    const context = await fixture();
    await fs.writeFile(destination(context), 'preserved');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.project);
    await assert.rejects(
      applyRestoreCandidate({
        projectRoot: context.project,
        env: context.env,
        candidateId: context.candidate.candidateId,
        confirm: async () => {
          assert.equal(await store.inspectLock(binding, context.slot), null);
          return true;
        },
        secureFs: {
          ...secureFs,
          prepareOwnerOnlyReplacement: async () => {
            const error = new Error('injected pre-write failure');
            error.code = 'EIO';
            throw error;
          },
        },
      }),
      error => error.code === 'ERR_RESTORE_APPLY_FAILED',
    );
    assert.equal((await readCandidateState({
      projectRoot: context.project,
      env: context.env,
      candidateId: context.candidate.candidateId,
    })).state, 'consumed');
    assert.equal(await fs.readFile(destination(context), 'utf8'), 'preserved');
  });

  it('refuses a manifest transition after confirmation before temporary write', async () => {
    const context = await fixture();
    await fs.writeFile(destination(context), 'destination');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.project);
    let wroteTemporary = false;
    await assert.rejects(
      applyRestoreCandidate({
        projectRoot: context.project,
        env: context.env,
        candidateId: context.candidate.candidateId,
        confirm: () => true,
        afterConfirmation: async () => {
          await store.commitApproval({
            binding,
            slot: context.slot,
            rawBytes: 'new approval',
            sourceOrigin: `cli:trust-approve:${context.slot}`,
          });
        },
        secureFs: {
          ...secureFs,
          prepareOwnerOnlyReplacement: async (...args) => {
            wroteTemporary = true;
            return secureFs.prepareOwnerOnlyReplacement(...args);
          },
        },
      }),
      error => error.code === 'ERR_RESTORE_FINAL_BARRIER',
    );
    assert.equal(wroteTemporary, false);
  });

  it('applies into a revoked slot without changing its tombstone or authority', async () => {
    const context = await fixture();
    await fs.writeFile(destination(context), 'previous approved bytes');
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.project);
    await store.commitApproval({
      binding,
      slot: context.slot,
      rawBytes: 'previous approved bytes',
      sourceOrigin: `cli:trust-approve:${context.slot}`,
    });
    await store.commitRevocation({
      binding,
      slot: context.slot,
      sourceOrigin: `cli:trust-revoke:${context.slot}`,
    });
    const manifestFile = store.manifestPath(binding, context.slot);
    const before = await fs.readFile(manifestFile);

    const result = await applyRestoreCandidate({
      projectRoot: context.project,
      env: context.env,
      candidateId: context.candidate.candidateId,
      confirm: () => true,
    });

    assert.equal(result.authoritative, false);
    assert.deepEqual(await fs.readFile(manifestFile), before);
    assert.equal((await store.classifySlot({
      binding,
      slot: context.slot,
    })).state, 'revoked');
  });

  it('recomputes authority from the live bytes and current manifest', async () => {
    for (const scenario of [
      { name: 'current-byte-identical', approved: 'restored body', expected: true },
      { name: 'historical-approved', approved: 'restored body', supersede: true, expected: false },
      { name: 'pristine-unapproved', expected: false },
      { name: 'normalized-equal-raw-different', approved: 'restored body\r\n', expected: false },
    ]) {
      const context = await fixture();
      const store = createFormatV2Store({ env: context.env });
      const binding = await store.readProjectBinding(context.project);
      if (scenario.approved !== undefined) {
        await store.commitApproval({
          binding,
          slot: context.slot,
          rawBytes: scenario.approved,
          sourceOrigin: `cli:trust-approve:${context.slot}`,
        });
      }
      if (scenario.supersede) {
        await store.commitApproval({
          binding,
          slot: context.slot,
          rawBytes: 'new current bytes',
          sourceOrigin: `cli:trust-approve:${context.slot}`,
        });
      }
      await fs.writeFile(destination(context), 'destination before restore');
      const result = await applyRestoreCandidate({
        projectRoot: context.project,
        env: context.env,
        candidateId: context.candidate.candidateId,
        confirm: () => true,
      });
      assert.equal(result.authoritative, scenario.expected, scenario.name);
      assert.equal(await isSlotAuthoritative({
        projectRoot: context.project,
        slot: context.slot,
        rawBytes: context.candidate.derivedSlotBytes,
        env: context.env,
      }), scenario.expected, scenario.name);
    }
  });
});
