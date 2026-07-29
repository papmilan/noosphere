import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

import { readApplyJournal } from '../../continuity/internal/restore/apply-journal.js';
import {
  readCandidateState,
  stageRestoreCandidate,
} from '../../continuity/internal/restore/candidate-store.js';
import { createFormatV2Store } from '../../continuity/internal/trust-format-v2.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(packageRoot, 'continuity', 'index.js');
const CRASH_CHILD = fileURLToPath(new URL('./restore-crash-child.mjs', import.meta.url));

export const BOUNDARIES = [
  'prepared',
  'temporary-written',
  'destination-replaced',
  'receipt-committed',
  'consumed-marker-committed',
];
export const REPLACED = new Set(['destination-replaced', 'receipt-committed', 'consumed-marker-committed']);

const temporary = [];
after(async () => {
  await Promise.all(temporary.map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

function ttyStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  return { input, output };
}

export async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-cli-recovery-home-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-cli-recovery-project-'));
  temporary.push(home, projectRoot);
  await fs.mkdir(path.join(projectRoot, '.noosphere'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.noosphere', 'baseline.md'), 'before');
  const env = { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'phase4c-owner' };
  const content = '# Noosphere project baseline\n\nafter\n';
  const staged = await stageRestoreCandidate({
    projectRoot,
    slot: 'baseline',
    env,
    ...ttyStreams(),
    recall: async () => ({ memories: [{ action_type: 'project-baseline', content }] }),
  });
  return {
    projectRoot,
    env,
    content,
    candidateId: staged.candidate.candidateId,
    destination: path.join(projectRoot, '.noosphere', 'baseline.md'),
  };
}

/** Runs the real CLI. stdin/stdout are pipes, so no interactive verb can proceed. */
export function cli(context, args) {
  return spawnSync(process.execPath, [CLI, 'restore', ...args, '--path', context.projectRoot], {
    env: { ...process.env, ...context.env, NOOSPHERE_PROJECT_DIR: context.projectRoot },
    encoding: 'utf8',
    input: '',
    timeout: 300000,
  });
}

/** Crashes a genuine apply with SIGKILL at `boundary`, leaving the lock held. */
export function crash(context, boundary) {
  const result = spawnSync(process.execPath, [CRASH_CHILD], {
    env: {
      ...process.env,
      CRASH_HOME: context.env.NOOSPHERE_HOME,
      CRASH_PROJECT: context.projectRoot,
      CRASH_SCOPE: context.env.NOOSPHERE_OWNER_SCOPE,
      CRASH_CANDIDATE: context.candidateId,
      CRASH_AT: boundary,
    },
    timeout: 300000,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined, `crash child errored: ${result.error?.message}`);
  assert.ok(result.signal === 'SIGKILL' || result.status !== 0, 'child must die abruptly');
  return result;
}

export async function clearSlotLockAsOwner(context) {
  const store = createFormatV2Store({ env: context.env });
  const binding = await store.readProjectBinding(context.projectRoot);
  await fs.rm(store.lockPath(binding, 'baseline'));
}

export async function stateOf(context) {
  const journal = await readApplyJournal({
    projectRoot: context.projectRoot,
    env: context.env,
    candidateId: context.candidateId,
  });
  const candidate = await readCandidateState({
    projectRoot: context.projectRoot,
    env: context.env,
    candidateId: context.candidateId,
  });
  return { journal, candidate, bytes: await fs.readFile(context.destination) };
}
