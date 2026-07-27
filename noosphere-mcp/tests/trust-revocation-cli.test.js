import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { revokeSlot } from '../continuity/internal/revocation-service.js';
import {
  SecurityCliError,
  exitCodeForError,
} from '../continuity/internal/security-cli-error.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { TrustStoreError } from '../continuity/trust-store-internal.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const temporary = [];
const ORIGINAL = Buffer.from('approved original', 'utf8');
const CHANGED = Buffer.from('approved changed', 'utf8');

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-revoke-cli-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-revoke-cli-project-'));
  temporary.push(home, project);
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
  };
  const store = createFormatV2Store({ env });
  const binding = await store.createProjectBinding(project);
  await store.commitApproval({
    binding,
    slot: 'baseline',
    rawBytes: ORIGINAL,
    sourceOrigin: 'cli:trust-approve:baseline',
  });
  return { binding, env, home, project, store };
}

async function runCli(args, context) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, ...args, '--path', context.project],
      {
        cwd: context.project,
        env: { ...process.env, ...context.env },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

describe('SEC-05 Phase 4C — typed security CLI exits', () => {
  it('maps usage, owner refusal, validation refusal, and defects to 2, 3, 4, and 1', () => {
    assert.equal(exitCodeForError(new SecurityCliError(
      'ERR_CLI_USAGE',
      'usage',
      2,
    )), 2);
    assert.equal(exitCodeForError(new TrustStoreError(
      'approval-declined',
      'declined',
    )), 3);
    assert.equal(exitCodeForError(new TrustStoreError(
      'revocation-requires-tty',
      'noninteractive',
    )), 4);
    assert.equal(exitCodeForError(new Error('defect')), 1);
  });

  it('rejects malformed trust grammar before creating security state', async () => {
    for (const args of [
      ['trust', 'revoke'],
      ['trust', 'revoke', 'baseline', 'extra'],
      ['trust', 'migrate', 'baseline'],
      ['trust', 'migrate', '--'],
      ['trust', 'approve', 'followups'],
    ]) {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-usage-home-'));
      const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-usage-project-'));
      temporary.push(home, project);
      const result = await runCli(args, {
        home,
        project,
        env: {
          NOOSPHERE_HOME: home,
          NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
        },
      });
      assert.equal(result.code, 2, args.join(' '));
      await assert.rejects(fs.access(path.join(home, 'trust-v2')));
    }
  });
});

describe('SEC-05 Phase 4C — interactive revocation service', () => {
  it('revokes only the exact state shown to the owner', async () => {
    const context = await fixture();
    let shown;
    const result = await revokeSlot({
      projectRoot: context.project,
      slot: 'baseline',
      env: context.env,
      confirm: details => {
        shown = details;
        return true;
      },
    });

    assert.equal(shown.slot, 'baseline');
    assert.equal(shown.generation, 1);
    assert.match(shown.projectIdentityDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(shown.recordHash, /^[0-9a-f]{64}$/);
    assert.equal(result.status, 'revoked');
    assert.equal(result.generation.generation, 2);
  });

  it('refuses if current state changes after confirmation', async () => {
    const context = await fixture();
    await assert.rejects(
      revokeSlot({
        projectRoot: context.project,
        slot: 'baseline',
        env: context.env,
        confirm: async () => {
          await context.store.commitApproval({
            binding: context.binding,
            slot: 'baseline',
            rawBytes: CHANGED,
            sourceOrigin: 'cli:trust-approve:baseline',
          });
          return true;
        },
      }),
      error => error.code === 'revocation-state-changed',
    );
    assert.equal((await context.store.classifySlot({
      binding: context.binding,
      slot: 'baseline',
    })).state, 'approved');
  });

  it('returns already-revoked without prompting or appending another generation', async () => {
    const context = await fixture();
    await context.store.commitRevocation({
      binding: context.binding,
      slot: 'baseline',
      sourceOrigin: 'cli:trust-revoke:baseline',
    });
    const manifestFile = context.store.manifestPath(context.binding, 'baseline');
    const before = await fs.readFile(manifestFile);
    let prompted = false;

    const result = await revokeSlot({
      projectRoot: context.project,
      slot: 'baseline',
      env: context.env,
      confirm: () => {
        prompted = true;
        return true;
      },
    });

    assert.equal(result.status, 'already-revoked');
    assert.equal(result.generation.generation, 2);
    assert.equal(prompted, false);
    assert.deepEqual(await fs.readFile(manifestFile), before);
  });

  it('noninteractive revocation exits 4 and changes no authority bytes', async () => {
    const context = await fixture();
    const manifestFile = context.store.manifestPath(context.binding, 'baseline');
    const before = await fs.readFile(manifestFile);
    const result = await runCli(['trust', 'revoke', 'baseline'], context);

    assert.equal(result.code, 4);
    assert.deepEqual(await fs.readFile(manifestFile), before);
    assert.equal((await context.store.classifySlot({
      binding: context.binding,
      slot: 'baseline',
    })).state, 'approved');
  });

  it('checks both TTY streams before reading trust state', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-nontty-home-'));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-nontty-project-'));
    temporary.push(home, project);
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = false;
    output.isTTY = true;

    await assert.rejects(
      revokeSlot({
        projectRoot: project,
        slot: 'baseline',
        env: {
          NOOSPHERE_HOME: home,
          NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
        },
        input,
        output,
      }),
      error => error.code === 'revocation-requires-tty',
    );
    await assert.rejects(fs.access(path.join(home, 'trust-v2')));
  });
});
