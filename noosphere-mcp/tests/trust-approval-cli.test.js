// SEC-05 Phase 4B — the CLI approval boundary, exercised as real child processes.
//
// The point of these tests is what CANNOT happen: a prompt-injected agent with
// shell access runs the approval command non-interactively and mints authority.
// Node's spawned stdio is a pipe, never a TTY, so these runs reproduce exactly
// the conditions such an agent has. A final POSIX-only case allocates genuine
// PTYs and proves that the same production CLI can approve with an exact owner
// phrase; there is no production TTY bypass.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  confirmationPhrase,
  escapeBytesForTerminal,
} from '../continuity/internal/approval-service.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { isSlotAuthoritative } from '../continuity/trust-store.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const MASTER = 'Pinned prompt an agent would love to approve for you.\n';
const temporary = [];

after(async () => {
  for (const dir of temporary) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function fresh(source = MASTER) {
  const homeParent = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-4b-cli-home-parent-'));
  const home = path.join(homeParent, 'home');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-4b-cli-project-'));
  temporary.push(homeParent, project);
  await fs.mkdir(path.join(project, '.noosphere'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(project, '.noosphere', 'master-prompt.md'), source);
  return { home, project, env: { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'phase4b-cli-owner' } };
}

async function run(args, { env, project, stdin = '' }) {
  const child = execFileAsync(process.execPath, [CLI, ...args, '--path', project], {
    cwd: project,
    env: { ...process.env, ...env },
  });
  child.child.stdin.end(stdin);
  try {
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const MACOS_SCRIPT_DRIVER = `
set timeout 30
spawn -noecho /usr/bin/script -q /dev/null \
  $env(TEST_PTY_NODE) $env(TEST_PTY_CLI) trust approve master-prompt --path $env(TEST_PTY_PROJECT)
expect {
  -exact "> " {
    send -- "$env(TEST_PTY_CONFIRMATION)\\r"
  }
  timeout {
    exit 124
  }
  eof {
    set result [wait]
    exit [lindex $result 3]
  }
}
expect eof
set result [wait]
exit [lindex $result 3]
`;

async function runInGenuinePty(args, { env, project, stdin }) {
  const command = [process.execPath, CLI, ...args, '--path', project];
  const executable = process.platform === 'darwin' ? '/usr/bin/expect' : 'script';
  const scriptArgs = process.platform === 'darwin'
    ? ['-c', MACOS_SCRIPT_DRIVER]
    : ['-q', '-e', '-c', command.map(shellQuote).join(' '), '/dev/null'];
  const child = execFileAsync(executable, scriptArgs, {
    cwd: project,
    env: {
      ...process.env,
      ...env,
      ...(process.platform === 'darwin' ? {
        TEST_PTY_NODE: process.execPath,
        TEST_PTY_CLI: CLI,
        TEST_PTY_PROJECT: project,
        TEST_PTY_CONFIRMATION: stdin,
      } : {}),
    },
  });
  child.child.stdin.end(process.platform === 'darwin' ? '' : `${stdin}\n`);
  try {
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// A refused approval must leave the trust store completely untouched — not just
// unauthoritative. Anything under NOOSPHERE_HOME counts as a trace.
async function touchedTrustStore({ home }) {
  const entries = await fs.readdir(path.join(home, 'trust-v2'), { recursive: true }).catch(() => []);
  return entries.length > 0;
}

async function mintedAnything({ env, project }) {
  const store = createFormatV2Store({ env });
  const binding = await store.readProjectBinding(project).catch(() => null);
  if (!binding) return false;
  return await store.readManifest(binding, 'master-prompt').catch(() => null) !== null;
}

describe('SEC-05 Phase 4B — approval refuses every non-interactive path', () => {
  for (const [name, stdin] of Object.entries({
    'empty stdin': '',
    'a bare newline': '\n',
    'a yes-flood': 'y\n'.repeat(500),
    'the confirmation phrase itself': 'approve master-prompt deadbeef\n',
  })) {
    it(`refuses with ${name} and mints nothing`, async () => {
      const context = await fresh();
      const result = await run(['trust', 'approve', 'master-prompt'], { ...context, stdin });
      assert.equal(result.code, 3, 'a piped approval is an owner/TTY refusal');
      assert.match(result.stderr, /interactive terminal/i);
      assert.equal(await mintedAnything(context), false);
      assert.equal(await touchedTrustStore(context), false, 'a refused approval must not create trust state');
      await assert.rejects(fs.lstat(context.home), (error) => error.code === 'ENOENT');
      assert.equal(
        await isSlotAuthoritative({ projectRoot: context.project, slot: 'master-prompt', rawBytes: MASTER, env: context.env }),
        false,
      );
    });
  }

  it('has no unattended escape hatch', async () => {
    const context = await fresh();
    for (const extra of [['--yes'], ['--force'], ['--non-interactive'], ['--confirm', 'approve master-prompt']]) {
      const result = await run(['trust', 'approve', 'master-prompt', ...extra], { ...context, stdin: 'yes\n' });
      assert.notEqual(result.code, 0, `${extra.join(' ')} must not approve anything`);
    }
    for (const variable of ['NOOSPHERE_TRUST_APPROVE', 'NOOSPHERE_YES', 'NOOSPHERE_NON_INTERACTIVE', 'CI']) {
      const result = await run(['trust', 'approve', 'master-prompt'], {
        ...context,
        env: { ...context.env, [variable]: '1' },
        stdin: 'yes\n',
      });
      assert.notEqual(result.code, 0, `${variable} must not approve anything`);
    }
    assert.equal(await mintedAnything(context), false);
    await assert.rejects(fs.lstat(context.home), (error) => error.code === 'ENOENT');
  });

  it('rejects malformed invocations without touching the trust store', async () => {
    const context = await fresh();
    for (const args of [['trust'], ['trust', 'approve'], ['trust', 'revoke', 'master-prompt'], ['trust', 'approve', 'followups']]) {
      const result = await run(args, { ...context, stdin: '' });
      assert.equal(result.code, 2, `${args.join(' ')} must be a usage or slot error`);
    }
    assert.equal(await mintedAnything(context), false);
    await assert.rejects(fs.lstat(context.home), (error) => error.code === 'ENOENT');
  });

  it('accepts only the exact trust approval grammar before attempting TTY handling', async () => {
    const context = await fresh();
    const malformed = [
      ['trust', 'approve'],
      ['trust', 'approve', 'master-prompt', 'extra'],
      ['trust', 'approve', '--yes', 'master-prompt'],
      ['trust', 'approve', 'master-prompt', '--yes'],
      ['trust', 'approve', '--', 'master-prompt'],
      ['trust', 'approve', 'MASTER-PROMPT'],
    ];

    for (const args of malformed) {
      const result = await run(args, { ...context, stdin: 'approve master-prompt deadbeef\n' });
      assert.equal(result.code, 2, `${args.join(' ')} must be a usage or slot error`);
      assert.doesNotMatch(result.stderr, /interactive terminal/i, `${args.join(' ')} must fail before TTY handling`);
    }
    assert.equal(await mintedAnything(context), false);
    await assert.rejects(fs.lstat(context.home), (error) => error.code === 'ENOENT');
  });

  it('classifies malformed global --path usage as a trust usage error without touching trust state', async () => {
    const context = await fresh();
    for (const args of [
      ['trust', 'approve', 'master-prompt', '--path'],
      ['trust', 'approve', 'master-prompt', '--path', '--yes'],
    ]) {
      const result = await run(args, { ...context, stdin: 'approve master-prompt deadbeef\n' });
      assert.equal(result.code, 2, `${args.join(' ')} must be a usage error`);
      assert.doesNotMatch(result.stderr, /interactive terminal/i, `${args.join(' ')} must fail before TTY handling`);
    }
    assert.equal(await mintedAnything(context), false);
    await assert.rejects(fs.lstat(context.home), (error) => error.code === 'ENOENT');
  });
});

describe('SEC-05 Phase 4B — approval succeeds only through a genuine PTY', () => {
  it('approves exact escaped bytes end to end through a genuine PTY', {
    skip: process.platform === 'win32' ? 'requires POSIX script(1)' : false,
  }, async () => {
    const rawBytes = Buffer.from('PTY-visible bytes: \u001b[31m\\literal\r\n', 'utf8');
    const context = await fresh(rawBytes);
    const rawHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
    const phrase = confirmationPhrase('master-prompt', rawHash);

    const result = await runInGenuinePty(['trust', 'approve', 'master-prompt'], {
      ...context,
      stdin: phrase,
    });

    assert.equal(result.code, 0, JSON.stringify(result));
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(output.includes(`Type "${phrase}" to approve`), 'the PTY must show the exact prompt');
    assert.ok(
      output.includes(`Byte view:   ${escapeBytesForTerminal(rawBytes)}`),
      'the PTY must show a byte-faithful escaped source view',
    );

    const store = createFormatV2Store({ env: context.env });
    const binding = await store.readProjectBinding(context.project);
    const manifest = await store.readManifest(binding, 'master-prompt');
    assert.equal(manifest.format, 2);
    assert.equal(await store.verifyAuditChain(binding, 'master-prompt'), true);
    assert.equal(
      await isSlotAuthoritative({
        projectRoot: context.project,
        slot: 'master-prompt',
        rawBytes,
        env: context.env,
      }),
      true,
    );
    const mutated = Buffer.from(rawBytes);
    mutated[0] ^= 1;
    assert.equal(
      await isSlotAuthoritative({
        projectRoot: context.project,
        slot: 'master-prompt',
        rawBytes: mutated,
        env: context.env,
      }),
      false,
    );
  });
});
