import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decodeCanonicalCandidateId,
  encodeLowerBase32,
  generateCandidateId,
  parseRestoreArgs,
} from '../continuity/internal/restore/cli.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const temporary = [];

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

function hasCode(code) {
  return error => error?.code === code;
}

async function runCli(args) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-restore-cli-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-restore-cli-project-'));
  temporary.push(home, project);
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI, ...args, '--path', project],
      {
        cwd: project,
        env: {
          ...process.env,
          NOOSPHERE_HOME: home,
          NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
        },
      },
    );
    return { code: 0, stdout, stderr, home };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      home,
    };
  }
}

describe('SEC-05 Phase 4C — exact restore grammar and candidate identifiers', () => {
  it('accepts only the four normative restore productions', () => {
    const candidateId = `${'a'.repeat(51)}q`;
    const accepted = [
      [['stage', 'master-prompt'], { verb: 'stage', slot: 'master-prompt' }],
      [['stage', 'instructions'], { verb: 'stage', slot: 'instructions' }],
      [['stage', 'baseline'], { verb: 'stage', slot: 'baseline' }],
      [['list'], { verb: 'list' }],
      [['show', candidateId], { verb: 'show', candidateId }],
      [['apply', candidateId], { verb: 'apply', candidateId }],
    ];
    for (const [argv, expected] of accepted) {
      assert.deepEqual(parseRestoreArgs(argv), expected);
    }
  });

  it('rejects aliases, options, unsupported slots, and malformed arity', () => {
    for (const argv of [
      [],
      ['restore'],
      ['stage'],
      ['stage', 'followups'],
      ['stage', 'baseline', 'extra'],
      ['stage', '--', 'baseline'],
      ['list', 'x'],
      ['show'],
      ['apply'],
      ['--'],
      ['stage-baseline'],
      ['stage', '--force'],
    ]) {
      assert.throws(() => parseRestoreArgs(argv), hasCode('ERR_CLI_USAGE'));
    }
  });

  it('encodes and round-trips all 256 random bits canonically', () => {
    const id = generateCandidateId(size => {
      assert.equal(size, 32);
      return Buffer.alloc(size, 0xff);
    });
    assert.equal(id.length, 52);
    assert.match(id, /^[a-z2-7]{51}[aq]$/);
    assert.equal(encodeLowerBase32(decodeCanonicalCandidateId(id)), id);
  });

  it('rejects every candidate-id alias before it can become a path component', () => {
    const valid = generateCandidateId(size => Buffer.alloc(size, 0));
    for (const value of [
      '',
      '.',
      '..',
      valid.toUpperCase(),
      `${valid}=`,
      valid.slice(1),
      `${valid}a`,
      `${valid.slice(0, -1)}b`,
      `${valid.slice(0, -1)}2`,
      ` ${valid}`,
      `${valid} `,
      `${valid.slice(0, 20)}/${valid.slice(21)}`,
      `${valid.slice(0, 20)}\\${valid.slice(21)}`,
      `${valid.slice(0, 20)}%2f${valid.slice(23)}`,
      `${valid.slice(0, 20)}\0${valid.slice(21)}`,
      `${valid.slice(0, -1)}é`,
    ]) {
      assert.throws(
        () => decodeCanonicalCandidateId(value),
        hasCode('ERR_CLI_USAGE'),
        JSON.stringify(value),
      );
    }
  });

  it('parses production CLI usage before recall or owner-local mutation', async () => {
    for (const args of [
      ['restore'],
      ['restore', 'stage'],
      ['restore', 'stage', 'followups'],
      ['restore', 'list', 'extra'],
      ['restore', 'show', 'not-an-id'],
      ['restore', 'stage', 'baseline', '--force'],
    ]) {
      const result = await runCli(args);
      assert.equal(result.code, 2, args.join(' '));
      await assert.rejects(fs.access(path.join(result.home, 'trust-v2')));
    }
  });

  it('refuses noninteractive stage with exit 4 before config, recall, or mutation', async () => {
    const result = await runCli(['restore', 'stage', 'baseline']);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /interactive terminal/i);
    await assert.rejects(fs.access(path.join(result.home, 'trust-v2')));
  });

  it('allows noninteractive list and reports an empty active store', async () => {
    const result = await runCli(['restore', 'list']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No active restore candidates/);
    await assert.rejects(fs.access(path.join(result.home, 'trust-v2')));
  });
});
