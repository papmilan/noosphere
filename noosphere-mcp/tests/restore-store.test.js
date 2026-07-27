import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';

import {
  cleanupExpiredCandidates,
  listRestoreCandidates,
  showRestoreCandidate,
  stageRestoreCandidate,
} from '../continuity/internal/restore/candidate-store.js';
import { recallRestoreSource } from '../continuity/internal/restore/recall.js';

const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-restore-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-restore-project-'));
  temporary.push(home, project);
  await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
  return {
    env: {
      NOOSPHERE_HOME: home,
      NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
    },
    home,
    project,
  };
}

async function candidateDirectory(context, candidateId) {
  const projectsRoot = path.join(context.home, 'trust-v2', 'projects');
  const [projectIdentity] = await fs.readdir(projectsRoot);
  return path.join(
    projectsRoot,
    projectIdentity,
    'restore',
    'candidates',
    candidateId,
  );
}

function ttyStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  return { input, output };
}

describe('SEC-05 Phase 4C — fixed recall selectors', () => {
  for (const [slot, expected] of Object.entries({
    baseline: {
      query: 'project baseline git history',
      filters: { action_type: 'project-baseline' },
      limit: 1,
    },
    'master-prompt': {
      query: 'master prompt original project instruction',
      filters: { action_type: 'master-prompt' },
      limit: 1,
    },
    instructions: {
      query: 'project protocol instructions',
      filters: { action_type: 'project-instructions' },
      limit: 1,
    },
  })) {
    it(`uses the exact ${slot} selector and first ranked result`, async () => {
      const requests = [];
      const source = await recallRestoreSource({
        slot,
        recall: async request => {
          requests.push(request);
          return {
            memories: [
              {
                action_id: 'first',
                action_type: expected.filters.action_type,
                agent_id: 'remote-agent',
                timestamp: '2026-07-27T00:00:00.000Z',
                content: 'exact first result',
              },
              {
                action_id: 'second',
                action_type: expected.filters.action_type,
                content: 'must not be selected',
              },
            ],
          };
        },
      });
      assert.deepEqual(requests, [expected]);
      assert.deepEqual(source.content, Buffer.from('exact first result'));
      assert.equal(source.metadata.actionId, 'first');
    });
  }
});

describe('SEC-05 Phase 4C — authenticated restore candidate staging', () => {
  it('stages one authenticated candidate without changing project files', async () => {
    const context = await fixture();
    const io = ttyStreams();
    const destination = path.join(
      context.project,
      '.noosphere',
      'master-prompt.md',
    );
    await fs.writeFile(destination, 'existing owner bytes');

    const result = await stageRestoreCandidate({
      projectRoot: context.project,
      slot: 'master-prompt',
      env: context.env,
      ...io,
      randomBytes: size => Buffer.alloc(size, 0x5a),
      now: () => new Date('2026-07-27T00:00:00.000Z'),
      recall: async () => ({
        memories: [{
          action_id: 'remote-1',
          action_type: 'master-prompt',
          agent_id: 'remote-agent',
          timestamp: '2026-07-26T00:00:00.000Z',
          content: 'proposed remote bytes',
        }],
      }),
    });

    assert.equal(result.status, 'staged');
    assert.equal(result.candidate.trustLabel, 'untrusted');
    assert.deepEqual(result.candidate.content, Buffer.from('proposed remote bytes'));
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing owner bytes');
    const listed = await listRestoreCandidates({
      projectRoot: context.project,
      env: context.env,
      now: () => new Date('2026-07-27T00:01:00.000Z'),
    });
    assert.deepEqual(listed.map(value => value.candidateId), [
      result.candidate.candidateId,
    ]);
    assert.equal('content' in listed[0], false);
    const shown = await showRestoreCandidate({
      projectRoot: context.project,
      env: context.env,
      candidateId: result.candidate.candidateId,
    });
    assert.deepEqual(shown.content, Buffer.from('proposed remote bytes'));
  });

  it('returns no-candidate without creating owner-local state', async () => {
    const context = await fixture();
    const result = await stageRestoreCandidate({
      projectRoot: context.project,
      slot: 'baseline',
      env: context.env,
      ...ttyStreams(),
      recall: async () => ({ memories: [] }),
    });
    assert.deepEqual(result, { status: 'no-candidate' });
    await assert.rejects(fs.access(path.join(context.home, 'trust-v2')));
  });

  it('checks both TTY streams before recall or mutation', async () => {
    const context = await fixture();
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    output.isTTY = false;
    let recalled = false;
    await assert.rejects(
      stageRestoreCandidate({
        projectRoot: context.project,
        slot: 'baseline',
        env: context.env,
        input,
        output,
        recall: async () => {
          recalled = true;
          return { memories: [] };
        },
      }),
      error => error.code === 'restore-stage-requires-tty',
    );
    assert.equal(recalled, false);
    await assert.rejects(fs.access(path.join(context.home, 'trust-v2')));
  });

  it('rejects an invalid top-ranked result without selecting a lower rank', async () => {
    const context = await fixture();
    await assert.rejects(
      stageRestoreCandidate({
        projectRoot: context.project,
        slot: 'instructions',
        env: context.env,
        ...ttyStreams(),
        recall: async () => ({
          memories: [
            {
              action_id: 'wrong-type',
              action_type: 'master-prompt',
              content: 'wrong',
            },
            {
              action_id: 'valid-lower-rank',
              action_type: 'project-instructions',
              content: 'must not be selected',
            },
          ],
        }),
      }),
      error => error.code === 'restore-source-action-type-mismatch',
    );
    await assert.rejects(fs.access(path.join(context.home, 'trust-v2')));
  });

  it('rejects empty, oversized, malformed UTF-8, and malformed metadata', async () => {
    for (const memory of [
      { action_type: 'project-baseline', content: '' },
      {
        action_type: 'project-baseline',
        content: 'x'.repeat(1_048_577),
      },
      { action_type: 'project-baseline', content: '\ud800' },
      {
        action_type: 'project-baseline',
        action_id: 42,
        content: 'valid content with invalid metadata',
      },
    ]) {
      const context = await fixture();
      await assert.rejects(
        stageRestoreCandidate({
          projectRoot: context.project,
          slot: 'baseline',
          env: context.env,
          ...ttyStreams(),
          recall: async () => ({ memories: [memory] }),
        }),
        error => String(error.code).startsWith('restore-source-'),
      );
      await assert.rejects(fs.access(path.join(context.home, 'trust-v2')));
    }
  });

  it('retries an exclusive-create collision with fresh randomness', async () => {
    const context = await fixture();
    const recall = async () => ({
      memories: [{
        action_type: 'master-prompt',
        content: 'collision-safe content',
      }],
    });
    const first = await stageRestoreCandidate({
      projectRoot: context.project,
      slot: 'master-prompt',
      env: context.env,
      ...ttyStreams(),
      randomBytes: size => Buffer.alloc(size, 0x11),
      recall,
    });
    let calls = 0;
    const second = await stageRestoreCandidate({
      projectRoot: context.project,
      slot: 'master-prompt',
      env: context.env,
      ...ttyStreams(),
      randomBytes: size => {
        calls += 1;
        return Buffer.alloc(size, calls === 1 ? 0x11 : 0x22);
      },
      recall,
    });
    assert.equal(calls, 2);
    assert.notEqual(
      first.candidate.candidateId,
      second.candidate.candidateId,
    );
  });

  it('fails closed on payload tampering and unsafe candidate-shaped entries', async () => {
    const context = await fixture();
    const result = await stageRestoreCandidate({
      projectRoot: context.project,
      slot: 'instructions',
      env: context.env,
      ...ttyStreams(),
      recall: async () => ({
        memories: [{
          action_type: 'project-instructions',
          content: 'authenticated candidate',
        }],
      }),
    });
    const directory = await candidateDirectory(
      context,
      result.candidate.candidateId,
    );
    await fs.writeFile(path.join(directory, 'payload.bin'), 'tampered');
    await assert.rejects(
      showRestoreCandidate({
        projectRoot: context.project,
        env: context.env,
        candidateId: result.candidate.candidateId,
      }),
      error => error.code === 'restore-candidate-content-invalid',
    );

    await fs.rm(directory, { recursive: true });
    const invalidName = `${'a'.repeat(51)}b`;
    await fs.mkdir(path.join(path.dirname(directory), invalidName));
    await assert.rejects(
      listRestoreCandidates({
        projectRoot: context.project,
        env: context.env,
      }),
      error => error.code === 'restore-candidate-invalid-name',
    );
  });

  it('keeps the 64 KiB envelope separate from a maximum-size payload', async () => {
    const context = await fixture();
    const content = 'x'.repeat(1_048_576);
    const result = await stageRestoreCandidate({
      projectRoot: context.project,
      slot: 'master-prompt',
      env: context.env,
      ...ttyStreams(),
      recall: async () => ({
        memories: [{ action_type: 'master-prompt', content }],
      }),
    });
    const directory = await candidateDirectory(
      context,
      result.candidate.candidateId,
    );
    assert.equal((await fs.stat(path.join(directory, 'payload.bin'))).size, 1_048_576);
    assert.ok((await fs.stat(path.join(directory, 'envelope.json'))).size < 65_536);
  });

  it('omits expired candidates and removes only unreferenced active state', async () => {
    const context = await fixture();
    const result = await stageRestoreCandidate({
      projectRoot: context.project,
      slot: 'baseline',
      env: context.env,
      ...ttyStreams(),
      now: () => new Date('2026-07-20T00:00:00.000Z'),
      recall: async () => ({
        memories: [{
          action_type: 'project-baseline',
          content: '# Noosphere project baseline\n\nstaged body\n',
        }],
      }),
    });
    const afterExpiry = () => new Date('2026-07-27T00:00:00.001Z');
    assert.deepEqual(result.candidate.derivedSlotBytes, Buffer.from('staged body'));
    assert.deepEqual(await listRestoreCandidates({
      projectRoot: context.project,
      env: context.env,
      now: afterExpiry,
    }), []);
    assert.equal(await cleanupExpiredCandidates({
      projectRoot: context.project,
      env: context.env,
      now: afterExpiry,
    }), 1);
    await assert.rejects(
      showRestoreCandidate({
        projectRoot: context.project,
        env: context.env,
        candidateId: result.candidate.candidateId,
      }),
      error => error.code === 'restore-candidate-missing',
    );
  });

  it('retains expired active candidates conservatively when later restore state exists', async () => {
    const context = await fixture();
    const result = await stageRestoreCandidate({
      projectRoot: context.project,
      slot: 'instructions',
      env: context.env,
      ...ttyStreams(),
      now: () => new Date('2026-07-20T00:00:00.000Z'),
      recall: async () => ({
        memories: [{
          action_type: 'project-instructions',
          content: 'expired but referenced candidate',
        }],
      }),
    });
    const directory = await candidateDirectory(
      context,
      result.candidate.candidateId,
    );
    const restoreRoot = path.dirname(path.dirname(directory));
    await fs.mkdir(path.join(restoreRoot, 'confirmations'), { recursive: true });
    await fs.writeFile(
      path.join(restoreRoot, 'confirmations', 'later-phase-fact'),
      'reference',
    );
    assert.equal(await cleanupExpiredCandidates({
      projectRoot: context.project,
      env: context.env,
      now: () => new Date('2026-07-28T00:00:00.000Z'),
    }), 0);
    await fs.access(directory);
  });
});
