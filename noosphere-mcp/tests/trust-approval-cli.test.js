// SEC-05 Phase 4B — the CLI approval boundary, exercised as real child processes.
//
// The point of these tests is what CANNOT happen through ORDINARY
// non-interactive execution: piped, redirected, and scripted approval, plus
// every flag and environment bypass, must mint nothing. Node's spawned stdio is
// a pipe, never a TTY, so these runs reproduce those conditions exactly.
//
// The POSIX-only PTY case below is NOT a proof that only humans can approve. It
// allocates a real PTY from a test process and approves through it, which is
// precisely what a shell-capable adversary can also do. It is here to prove the
// production CLI still works for a real owner. The TTY gate is documented as a
// non-presence-proving control in SECURITY.md.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import http from 'node:http';
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

describe('SEC-05 Phase 4B — approval works through a genuine PTY (which an adversary can also allocate)', () => {
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

describe('SEC-05 Phase 4B — an unreadable master prompt still counts as existing', () => {
  // A tree writer plants one invalid byte. If a capture path mistakes that for
  // "no master prompt yet", it overwrites the owner's pinned prompt with
  // agent-chosen bytes — in the very slot `trust approve master-prompt` acts on.
  const PINNED = Buffer.concat([Buffer.from('OWNER PINNED PROMPT\n'), Buffer.from([0xff])]);

  async function freshMalformed() {
    const context = await fresh(MASTER);
    const file = path.join(context.project, '.noosphere', 'master-prompt.md');
    await fs.writeFile(file, PINNED);
    // The capture commands run behind loadConfig, so the fixture needs a
    // project config; nothing here contacts the relayer.
    await fs.writeFile(
      path.join(context.project, '.noosphere', 'config.json'),
      JSON.stringify({
        project_id: 'phase4b-capture-test',
        relayer_url: 'http://127.0.0.1:1',
        privacy: { capture_master_prompt: true },
      }),
      'utf8',
    );
    return { ...context, file };
  }

  it('refuses to overwrite it without --replace and leaves the bytes untouched', async () => {
    const context = await freshMalformed();
    const result = await run(['master-prompt', '--content', 'AGENT SUPPLIED PROMPT'], context);

    assert.notEqual(result.code, 0);
    assert.deepEqual(await fs.readFile(context.file), PINNED);
  });

  it('never reports it as absent', async () => {
    const context = await freshMalformed();
    const result = await run(['master-prompt', '--content', 'AGENT SUPPLIED PROMPT'], context);

    // "No master prompt has been captured" is the claim that would justify an
    // overwrite; an unreadable prompt must never produce it.
    assert.doesNotMatch(result.stdout, /No master prompt has been captured/i);
    assert.doesNotMatch(result.stderr, /No master prompt has been captured/i);
  });

  it('still replaces it when the owner passes --replace', async () => {
    const context = await freshMalformed();
    await run(['master-prompt', '--replace', '--content', 'OWNER CHOSEN REPLACEMENT'], context);

    // Exit status is not asserted: this fixture has no reachable relayer, and
    // the capture command reports that failure after writing. The replacement
    // itself is the --replace semantic under test.
    assert.equal(await fs.readFile(context.file, 'utf8'), 'OWNER CHOSEN REPLACEMENT');
  });
});

describe('SEC-05 Phase 4B — the TTY gate is documented as non-presence-proving', () => {
  // The gate stops ordinary non-interactive approval; it does NOT prove a human
  // is present, because a shell-capable adversary can allocate a PTY and compute
  // the phrase offline. Owners make trust decisions from this document, so an
  // overstated claim here is itself a security defect.
  const SECURITY_MD = fileURLToPath(new URL('../../SECURITY.md', import.meta.url));

  it('states the residual and does not claim shell access is insufficient', async () => {
    const text = await fs.readFile(SECURITY_MD, 'utf8');

    assert.match(text, /does not prove human presence/i);
    assert.match(text, /allocate a pseudo-terminal/i);
    assert.match(text, /does \*\*not\*\* need to observe the terminal\s+output/i);
    // The exact overstatement this replaced.
    assert.doesNotMatch(
      text,
      /non-interactive shell access cannot approve anything on your behalf/i,
    );
  });
});

describe('SEC-05 Phase 4B — unusable local slots never select remote content', () => {
  // A slot file that is present but unreadable must not look ABSENT to
  // refreshContext: absence is what triggers Walrus restoration, so a tree
  // writer who corrupts the local file could otherwise swap the rendered
  // baseline/master prompt for whatever sits in the relayer namespace.
  const REMOTE_BAIT = 'REMOTE CONTENT AN ATTACKER CONTROLS';

  async function withStubRelayer(project, recalled) {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname.endsWith('/recall')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        recalled.push(body.action_type);
        // Bait ONLY the two slot types under test. Followups legitimately
        // recall when none exist locally, and that is not what this proves.
        const baited = ['project-baseline', 'master-prompt'].includes(body.action_type);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ memories: baited ? [{ content: REMOTE_BAIT }] : [] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('stub context\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await fs.writeFile(
      path.join(project, '.noosphere', 'config.json'),
      JSON.stringify({
        project_id: 'phase4b-remote-test',
        relayer_url: `http://127.0.0.1:${port}`,
        privacy: { capture_master_prompt: true },
      }),
      'utf8',
    );
    return server;
  }

  it('does not recall a corrupt slot and never renders the remote bait', async () => {
    const context = await fresh(MASTER);
    const recalled = [];
    const server = await withStubRelayer(context.project, recalled);
    try {
      // Present but unusable, via two different classified failures.
      await fs.writeFile(
        path.join(context.project, '.noosphere', 'master-prompt.md'),
        Buffer.concat([Buffer.from('PINNED\n'), Buffer.from([0xff])]),
      );
      await fs.mkdir(path.join(context.project, '.noosphere', 'baseline.md'));

      const result = await run(['refresh'], context);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(!recalled.includes('master-prompt'), `recalled: ${recalled.join(',')}`);
      assert.ok(!recalled.includes('project-baseline'), `recalled: ${recalled.join(',')}`);

      const shared = await fs.readFile(path.join(context.project, '.noosphere', 'context.md'), 'utf8');
      assert.doesNotMatch(shared, new RegExp(REMOTE_BAIT));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('still recalls a genuinely absent slot', async () => {
    const context = await fresh(MASTER);
    const recalled = [];
    const server = await withStubRelayer(context.project, recalled);
    try {
      await fs.rm(path.join(context.project, '.noosphere', 'master-prompt.md'));

      const result = await run(['refresh'], context);
      assert.equal(result.code, 0, result.stderr);
      // Absence is the one state that legitimately restores from Walrus.
      assert.ok(recalled.includes('master-prompt'), `recalled: ${recalled.join(',')}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
