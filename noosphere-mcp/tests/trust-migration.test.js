import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { confirmationPhrase } from '../continuity/internal/approval-service.js';
import { migrateTrustInventory } from '../continuity/internal/migration-service.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { isSlotAuthoritative } from '../continuity/trust-store.js';
import { putSlotRecord } from '../continuity/trust-store-internal.js';
import { writePhase4bApproval } from './helpers/phase4b-trust-fixture.js';

const temporary = [];
const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const MASTER = 'legacy master prompt\n';
const INSTRUCTIONS = 'legacy protocol instructions\n';

after(async () => {
  await Promise.all(temporary.map(directory =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-migrate-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-migrate-project-'));
  temporary.push(home, project);
  const env = {
    NOOSPHERE_HOME: home,
    NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
  };
  await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
  await fs.writeFile(path.join(project, '.noosphere', 'master-prompt.md'), MASTER);
  await fs.writeFile(path.join(project, '.noosphere', 'instructions.md'), INSTRUCTIONS);
  await putSlotRecord({
    projectRoot: project,
    slot: 'master-prompt',
    rawBytes: MASTER,
    env,
  });
  await putSlotRecord({
    projectRoot: project,
    slot: 'instructions',
    rawBytes: INSTRUCTIONS,
    env,
  });
  return { env, home, project };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const MACOS_MIGRATION_PTY_DRIVER = `
set timeout 30
spawn -noecho /usr/bin/script -q /dev/null \
  $env(TEST_PTY_NODE) $env(TEST_PTY_CLI) trust migrate --path $env(TEST_PTY_PROJECT)
expect -exact "> "
send -- "$env(TEST_PTY_CONFIRMATION_1)\\r"
expect -exact "> "
send -- "$env(TEST_PTY_CONFIRMATION_2)\\r"
expect eof
set result [wait]
exit [lindex $result 3]
`;

function migrationPhrases() {
  return [
    confirmationPhrase(
      'master-prompt',
      crypto.createHash('sha256').update(MASTER).digest('hex'),
    ),
    confirmationPhrase(
      'instructions',
      crypto.createHash('sha256').update(INSTRUCTIONS).digest('hex'),
    ),
  ];
}

// Emitted once per slot, immediately before that slot's prompt. Counting these
// is how the driver knows a prompt is on screen.
const PROMPT_MARKER = 'to approve, anything else to abort.';

/**
 * Drives `noosphere trust migrate` through a real PTY, sending each slot's
 * phrase only AFTER that slot's prompt has been displayed — which is the only
 * way a human can answer, and the only way the ceremony accepts an answer.
 *
 * Writing both phrases up front does NOT work, and must not: each prompt reads
 * from a fresh reader, so input typed before a prompt was shown is discarded
 * with it. See the type-ahead test below, which pins that as a property.
 *
 * Linux drives `script` from Node so no `expect` binary is required on the
 * runner; macOS keeps the expect driver because its `script` takes a different
 * command form.
 */
async function runMigrationInGenuinePty(context, { phrases = migrationPhrases() } = {}) {
  const command = [
    process.execPath,
    CLI,
    'trust',
    'migrate',
    '--path',
    context.project,
  ];
  if (process.platform === 'darwin') {
    const child = execFileAsync('/usr/bin/expect', ['-c', MACOS_MIGRATION_PTY_DRIVER], {
      cwd: context.project,
      env: {
        ...process.env,
        ...context.env,
        TEST_PTY_NODE: process.execPath,
        TEST_PTY_CLI: CLI,
        TEST_PTY_PROJECT: context.project,
        TEST_PTY_CONFIRMATION_1: phrases[0],
        TEST_PTY_CONFIRMATION_2: phrases[1],
      },
    });
    child.child.stdin.end('');
    return child;
  }
  return driveLinuxPty(context, command, (transcript, sent) =>
    countOccurrences(transcript, PROMPT_MARKER) > sent ? phrases[sent] : null);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Runs `command` under `script(1)` and feeds stdin from `next(transcript, sent)`,
 * which returns the string to send or null to keep waiting. Resolves
 * `{ stdout, code }`; rejects like execFile on a non-zero exit.
 */
function driveLinuxPty(context, command, next, expected = 2) {
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-q', '-e', '-c', command.map(shellQuote).join(' '), '/dev/null'], {
      cwd: context.project,
      env: { ...process.env, ...context.env },
    });
    let transcript = '';
    let sent = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      transcript += chunk;
      for (;;) {
        const line = next(transcript, sent);
        if (line === null) break;
        child.stdin.write(`${line}\n`);
        sent += 1;
        // script(1) blocks reading its own stdin after the child exits, so the
        // pipe must be closed once there is nothing left to type.
        if (sent === expected) child.stdin.end();
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      child.stdin.destroy();
      if (code === 0) resolve({ stdout: transcript, code });
      else reject(Object.assign(new Error(`migrate exited ${code}`), { code, stdout: transcript }));
    });
  });
}

describe('SEC-05 Phase 4C — fresh per-slot migration approval', () => {
  it('requires distinct confirmations through a genuine PTY for two eligible slots', async function () {
    // Windows has neither script(1) nor expect, and Node cannot allocate a PTY
    // without a native addon. The ceremony's Windows terminal behaviour is
    // therefore NOT verified by this suite — recorded as unverified in
    // docs/security/SEC-05-PHASE-4C-VERIFICATION.md rather than hidden behind a
    // green job. The TTY refusal itself IS verified on every platform by
    // 'checks both TTY streams before inventory or mutation'.
    if (process.platform === 'win32') {
      return this.skip('not applicable: no PTY allocator on Windows runners');
    }
    const context = await fixture();
    await runMigrationInGenuinePty(context);

    assert.equal(await isSlotAuthoritative({
      projectRoot: context.project,
      slot: 'master-prompt',
      rawBytes: MASTER,
      env: context.env,
    }), true);
    assert.equal(await isSlotAuthoritative({
      projectRoot: context.project,
      slot: 'instructions',
      rawBytes: INSTRUCTIONS,
      env: context.env,
    }), true);
  });

  // Found by a Linux-only CI failure of the test above: the previous driver
  // wrote both phrases before the ceremony started, and only the first slot was
  // approved. That is correct behaviour, not a bug — a phrase typed before its
  // prompt was displayed answers a question the owner has not yet been asked,
  // and each prompt reads from a fresh reader, so pre-typed input is discarded
  // with the previous one. Pinned here so a future refactor to a single shared
  // stdin reader (which would make type-ahead work) fails loudly.
  it('discards input typed before its prompt was displayed', async function () {
    if (process.platform !== 'linux') return this.skip('needs script(1) with -c');
    const context = await fixture();
    const phrases = migrationPhrases();
    const command = [process.execPath, CLI, 'trust', 'migrate', '--path', context.project];

    // Send BOTH phrases immediately, before either prompt exists.
    const failure = await driveLinuxPty(context, command, (_transcript, sent) =>
      (sent < phrases.length ? phrases[sent] : null)).then(
      () => null,
      (error) => error,
    );

    assert.notEqual(failure, null, 'type-ahead approved a prompt the owner never saw');
    assert.equal(failure.code, 3, 'expected the owner-refusal exit code');
    assert.match(failure.stdout, /approval was not confirmed/);
    // The first slot — whose prompt WAS displayed before its phrase was read —
    // committed. The second did not.
    assert.equal(await isSlotAuthoritative({
      projectRoot: context.project,
      slot: 'master-prompt',
      rawBytes: MASTER,
      env: context.env,
    }), true);
    assert.equal(await isSlotAuthoritative({
      projectRoot: context.project,
      slot: 'instructions',
      rawBytes: INSTRUCTIONS,
      env: context.env,
    }), false);
  });

  it('requires a distinct normal approval for every eligible slot', async () => {
    const context = await fixture();
    const confirmations = [];
    const result = await migrateTrustInventory({
      projectRoot: context.project,
      env: context.env,
      confirm: details => {
        confirmations.push(details);
        return true;
      },
    });

    assert.deepEqual(
      confirmations.map(details => [details.action, details.slot]),
      [
        ['migration-approval', 'master-prompt'],
        ['migration-approval', 'instructions'],
      ],
    );
    assert.notEqual(confirmations[0].rawHash, confirmations[1].rawHash);
    assert.deepEqual(result.slots, {
      'master-prompt': 'migrated',
      instructions: 'migrated',
      baseline: 'absent',
    });
    assert.equal(await isSlotAuthoritative({
      projectRoot: context.project,
      slot: 'master-prompt',
      rawBytes: MASTER,
      env: context.env,
    }), true);
    assert.equal(await isSlotAuthoritative({
      projectRoot: context.project,
      slot: 'instructions',
      rawBytes: INSTRUCTIONS,
      env: context.env,
    }), true);
  });

  it('resumes after interruption without reapproving a committed slot', async () => {
    const context = await fixture();
    let attempts = 0;
    await assert.rejects(
      migrateTrustInventory({
        projectRoot: context.project,
        env: context.env,
        confirm: () => {
          attempts += 1;
          return attempts === 1;
        },
      }),
      error => error.code === 'approval-declined',
    );

    const resumed = [];
    const result = await migrateTrustInventory({
      projectRoot: context.project,
      env: context.env,
      confirm: details => {
        resumed.push(details.slot);
        return true;
      },
    });
    assert.deepEqual(resumed, ['instructions']);
    assert.equal(result.slots['master-prompt'], 'already-migrated');
    assert.equal(result.slots.instructions, 'migrated');
  });

  it('never restarts invalid current Phase 4C history from legacy inventory', async () => {
    const context = await fixture();
    await migrateTrustInventory({
      projectRoot: context.project,
      env: context.env,
      confirm: () => true,
    });
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.project);
    const manifestFile = store.manifestPath(binding, 'master-prompt');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.currentGeneration += 1;
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const before = await fs.readFile(manifestFile);
    let prompted = false;

    await assert.rejects(
      migrateTrustInventory({
        projectRoot: context.project,
        env: context.env,
        confirm: () => {
          prompted = true;
          return true;
        },
      }),
      error => error.code === 'record-noncanonical' ||
        error.code === 'record-invalid' ||
        error.code === 'record-mac-invalid' ||
        error.code === 'manifest-invalid',
    );

    assert.equal(prompted, false);
    assert.deepEqual(await fs.readFile(manifestFile), before);
  });

  it('never prompts over a current authenticated tombstone', async () => {
    const context = await fixture();
    const store = createFormatV2Store({ env: context.env });
    const binding = await store.createProjectBinding(context.project);
    await store.commitApproval({
      binding,
      slot: 'master-prompt',
      rawBytes: MASTER,
      sourceOrigin: 'cli:trust-approve:master-prompt',
    });
    await store.commitRevocation({
      binding,
      slot: 'master-prompt',
      sourceOrigin: 'cli:trust-revoke:master-prompt',
    });
    const prompted = [];
    const result = await migrateTrustInventory({
      projectRoot: context.project,
      env: context.env,
      confirm: details => {
        prompted.push(details.slot);
        return true;
      },
    });

    assert.equal(result.slots['master-prompt'], 'revoked');
    assert.equal(prompted.includes('master-prompt'), false);
    assert.equal((await store.classifySlot({
      binding,
      slot: 'master-prompt',
    })).state, 'revoked');
  });

  it('migrates a valid pre-4C format-2 slot only after fresh approval', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4b-home-'));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4b-project-'));
    temporary.push(home, project);
    const env = {
      NOOSPHERE_HOME: home,
      NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
    };
    const baseline = 'legacy phase4b baseline';
    await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
    await fs.writeFile(
      path.join(project, '.noosphere', 'baseline.md'),
      `# Noosphere project baseline\n\n${baseline}\n`,
    );
    await writePhase4bApproval({
      home,
      project,
      env,
      slot: 'baseline',
      rawBytes: baseline,
    });
    const confirmations = [];

    const result = await migrateTrustInventory({
      projectRoot: project,
      env,
      confirm: details => {
        confirmations.push(details);
        return true;
      },
    });

    assert.deepEqual(confirmations.map(value => value.slot), ['baseline']);
    assert.deepEqual(confirmations[0].legacyFormats, ['phase4b-format-2']);
    assert.equal(result.slots.baseline, 'migrated');
    assert.equal(await isSlotAuthoritative({
      projectRoot: project,
      slot: 'baseline',
      rawBytes: baseline,
      env,
    }), true);
    await fs.access(path.join(home, 'trust-v2-retired-phase4b'));
  });

  it('leaves a declined pre-4C format-2 store byte-for-byte active and untrusted', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4b-decline-home-'));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4b-decline-project-'));
    temporary.push(home, project);
    const env = {
      NOOSPHERE_HOME: home,
      NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
    };
    const baseline = 'declined legacy baseline';
    await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
    await fs.writeFile(
      path.join(project, '.noosphere', 'baseline.md'),
      `# Noosphere project baseline\n\n${baseline}\n`,
    );
    await writePhase4bApproval({
      home,
      project,
      env,
      slot: 'baseline',
      rawBytes: baseline,
    });
    const before = await fs.readdir(path.join(home, 'trust-v2'), { recursive: true });

    await assert.rejects(
      migrateTrustInventory({
        projectRoot: project,
        env,
        confirm: () => false,
      }),
      error => error.code === 'approval-declined',
    );

    assert.deepEqual(
      await fs.readdir(path.join(home, 'trust-v2'), { recursive: true }),
      before,
    );
    await assert.rejects(
      fs.access(path.join(home, 'trust-v2-retired-phase4b')),
      error => error.code === 'ENOENT',
    );
    assert.equal(await isSlotAuthoritative({
      projectRoot: project,
      slot: 'baseline',
      rawBytes: baseline,
      env,
    }), false);
  });

  it('is idempotent after a pre-4C format-2 slot has migrated', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4b-repeat-home-'));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4b-repeat-project-'));
    temporary.push(home, project);
    const env = {
      NOOSPHERE_HOME: home,
      NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
    };
    const baseline = 'repeatable legacy baseline';
    await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
    await fs.writeFile(
      path.join(project, '.noosphere', 'baseline.md'),
      `# Noosphere project baseline\n\n${baseline}\n`,
    );
    await writePhase4bApproval({
      home,
      project,
      env,
      slot: 'baseline',
      rawBytes: baseline,
    });
    await migrateTrustInventory({
      projectRoot: project,
      env,
      confirm: () => true,
    });
    const store = createFormatV2Store({ env });
    const binding = await store.readProjectBinding(project);
    const before = await store.readManifest(binding, 'baseline');
    const prompted = [];

    const repeated = await migrateTrustInventory({
      projectRoot: project,
      env,
      confirm: details => {
        prompted.push(details.slot);
        return true;
      },
    });

    assert.deepEqual(prompted, []);
    assert.equal(repeated.slots.baseline, 'already-migrated');
    assert.deepEqual(await store.readManifest(binding, 'baseline'), before);
  });

  it('checks both TTY streams before inventory or mutation', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-migrate-nontty-'));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-migrate-project-'));
    temporary.push(home, project);
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    output.isTTY = false;

    await assert.rejects(
      migrateTrustInventory({
        projectRoot: project,
        env: {
          NOOSPHERE_HOME: home,
          NOOSPHERE_OWNER_SCOPE: 'phase4c-owner',
        },
        input,
        output,
      }),
      error => error.code === 'migration-requires-tty',
    );
    await assert.rejects(fs.access(path.join(home, 'trust-v2')));
  });
});
