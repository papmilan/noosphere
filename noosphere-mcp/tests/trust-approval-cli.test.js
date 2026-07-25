// SEC-05 Phase 4B — the CLI approval boundary, exercised as a real child process.
//
// The point of these tests is what CANNOT happen: a prompt-injected agent with
// shell access runs the approval command non-interactively and mints authority.
// Node's spawned stdio is a pipe, never a TTY, so these runs reproduce exactly
// the conditions such an agent has.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { isSlotAuthoritative } from '../continuity/trust-store.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const MASTER = 'Pinned prompt an agent would love to approve for you.\n';
const temporary = [];

after(async () => {
  for (const dir of temporary) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function fresh() {
  const homeParent = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-4b-cli-home-parent-'));
  const home = path.join(homeParent, 'home');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-4b-cli-project-'));
  temporary.push(homeParent, project);
  await fs.mkdir(path.join(project, '.noosphere'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(project, '.noosphere', 'master-prompt.md'), MASTER, 'utf8');
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
      assert.notEqual(result.code, 0, 'a piped approval must not succeed');
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
      assert.notEqual(result.code, 0, `${args.join(' ')} must fail`);
    }
    assert.equal(await mintedAnything(context), false);
    await assert.rejects(fs.lstat(context.home), (error) => error.code === 'ENOENT');
  });
});
