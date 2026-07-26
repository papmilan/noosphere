// SEC-05 Phase 4B-R4 — the repository-controlled read boundary.
//
// Every file this product reads out of a working tree is content, type, and size
// controlled by whatever can write to that tree. This suite pins the five
// properties that follow from that:
//
//   1. no filesystem object can BLOCK a read (FIFO, socket, device);
//   2. no file can be large enough to exhaust memory before it is refused;
//   3. absent, present-and-usable, and present-but-unusable stay three distinct
//      states through every renderer and output contract;
//   4. present-but-unusable never selects remote content;
//   5. a symlinked slot FILE is refused; a symlinked PARENT DIRECTORY is not.
//
// Each test drives the production path (the CLI as a child process, or the
// exported refreshContext / watchProject), never a re-implementation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { configureProjectAdapters, refreshContext, watchProject } from '../continuity/index.js';
import {
  MAX_SLOT_SOURCE_BYTES,
  UNUSABLE_SOURCE_CODES,
  resolveSlotSource,
  resolveSlotSourceForRead,
} from '../continuity/slot-sources.js';
import { readBoundedRegularFile } from '../continuity/secure-fs.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const MASTER = 'Pinned prompt for the read-boundary suite.\n';
const REMOTE_BAIT = 'REMOTE-BAIT-THAT-MUST-NEVER-RENDER';
const temporary = [];

after(async () => {
  for (const dir of temporary) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function fresh({ master = MASTER, instructions } = {}) {
  const homeParent = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-r4-home-'));
  const home = path.join(homeParent, 'home');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-r4-project-'));
  temporary.push(homeParent, project);
  await fs.mkdir(path.join(project, '.noosphere'), { recursive: true, mode: 0o700 });
  if (master !== null) await fs.writeFile(path.join(project, '.noosphere', 'master-prompt.md'), master);
  if (instructions !== undefined) await fs.writeFile(path.join(project, '.noosphere', 'instructions.md'), instructions);
  return { home, project, env: { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'r4-owner' } };
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

// Recall bait for the two slot types under test; everything else answers empty
// so an unrelated recall cannot be mistaken for a restoration.
async function stubRelayer(project, recalled = [], { failContext = () => false, bait = true } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname.endsWith('/recall')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      recalled.push(body.action_type);
      const baited = bait && ['project-baseline', 'master-prompt'].includes(body.action_type);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ memories: baited ? [{ content: REMOTE_BAIT }] : [] }));
      return;
    }
    if (req.method === 'POST') {
      for await (const chunk of req) void chunk;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ action_id: 'stub-action', blob_id: null }));
      return;
    }
    if (failContext()) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('relayer unavailable\n');
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
      project_id: 'r4-read-boundary',
      relayer_url: `http://127.0.0.1:${port}`,
      privacy: { capture_master_prompt: true },
    }),
    'utf8',
  );
  return server;
}

// POSIX-only. Node cannot create a FIFO, and the mkfifo shipped on the Windows
// runners produces something Windows treats as an ordinary file — the blocking
// property under test does not exist there. Verify a real FIFO resulted.
async function mkfifo(file) {
  if (process.platform === 'win32') return false;
  await execFileAsync('mkfifo', [file]).catch(() => undefined);
  const stats = await fs.lstat(file).catch(() => null);
  return Boolean(stats?.isFIFO());
}

async function trySymlink(target, file) {
  try {
    await fs.symlink(target, file);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return false;
    throw error;
  }
}

// An oversized fixture, sparse wherever the filesystem supports it.
//
// On APFS and ext4 `truncate` reserves the logical length without writing
// blocks, so the fixture costs milliseconds and no disk — and a refusal that had
// to read the file would have had to materialise gigabytes, which is the failure
// mode under test. NTFS allocates on `ftruncate` instead (a 64 GiB request
// returns ENOSPC on a CI runner), so there the fixture falls back to
// `bound + 1` real bytes: the bound is still exceeded, only the low-disk
// evidence is weaker. Returns { size, sparse } so a test can assert which it got.
async function oversizedFile(file, bound) {
  const hole = bound * 4096;
  const handle = await fs.open(file, 'w');
  try {
    try {
      await handle.truncate(hole);
      const stats = await fs.stat(file);
      const allocated = typeof stats.blocks === 'number' ? stats.blocks * 512 : 0;
      if (stats.size === hole && allocated < hole / 1000) return { size: hole, sparse: true };
    } catch (error) {
      if (error.code !== 'ENOSPC') throw error;
    }
    await handle.truncate(0);
    await handle.writeFile(Buffer.alloc(bound + 1, 0x61));
    return { size: bound + 1, sparse: false };
  } finally {
    await handle.close();
  }
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} (exceeded ${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(condition, ms, message) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`${message} (waited ${ms}ms)`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd });
}

describe('SEC-05 Phase 4B-R4 — no repository-controlled read can block refresh', () => {
  it('completes a refresh when followups.jsonl is a FIFO', async (t) => {
    const { project } = await fresh();
    const recalled = [];
    const server = await stubRelayer(project, recalled);
    try {
      const file = path.join(project, '.noosphere', 'followups.jsonl');
      if (!await mkfifo(file)) {
        t.skip('this platform cannot create a FIFO');
        return;
      }
      // Termination is the property. A bare readFile here never returns and
      // never produces an error code, so refresh would hang rather than fail.
      const output = await withTimeout(
        refreshContext(project),
        10_000,
        'refreshContext blocked on a FIFO at .noosphere/followups.jsonl',
      );
      assert.match(output, /## Follow-up user instructions/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('completes a refresh when journal.md is a FIFO', async (t) => {
    const { project } = await fresh();
    const recalled = [];
    const server = await stubRelayer(project, recalled);
    try {
      const file = path.join(project, '.noosphere', 'journal.md');
      if (!await mkfifo(file)) {
        t.skip('this platform cannot create a FIFO');
        return;
      }
      const output = await withTimeout(
        refreshContext(project),
        10_000,
        'refreshContext blocked on a FIFO at .noosphere/journal.md',
      );
      assert.match(output, /## Local public work journal/);
      assert.match(output, /No entries yet/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('completes a refresh when the project config is a FIFO — and refuses it rather than downgrading', async (t) => {
    const { project } = await fresh();
    const recalled = [];
    const server = await stubRelayer(project, recalled);
    try {
      const config = path.join(project, '.noosphere', 'config.json');
      await fs.rm(config);
      if (!await mkfifo(config)) {
        t.skip('this platform cannot create a FIFO');
        return;
      }
      // Present-but-unusable config must NOT read as absent: absent is what
      // selects the legacy .noosphere.json, which would be a downgrade a tree
      // writer could trigger.
      await fs.writeFile(
        path.join(project, '.noosphere.json'),
        JSON.stringify({ project_id: 'legacy-downgrade' }),
        'utf8',
      );
      await withTimeout(
        assert.rejects(refreshContext(project), /could not be read/),
        10_000,
        'refreshContext blocked on a FIFO at .noosphere/config.json',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('resets the watcher refresh guard after a failed refresh', async (t) => {
    if (process.platform === 'win32') {
      t.skip('the in-process SIGINT stop path is POSIX-only here');
      return;
    }
    const { project } = await fresh();
    let contextFails = true;
    const recalled = [];
    const server = await stubRelayer(project, recalled, { failContext: () => contextFails });
    const contextFile = path.join(project, '.noosphere', 'context.md');
    let watching;
    try {
      await git(project, ['init', '--quiet']);
      await git(project, ['config', 'user.email', 'r4@example.test']);
      await git(project, ['config', 'user.name', 'R4']);
      await fs.writeFile(path.join(project, 'README.md'), '# r4\n');
      await git(project, ['add', '.']);
      await git(project, ['commit', '--quiet', '-m', 'seed']);

      // The first refresh — and several timer refreshes — fail. If the guard is
      // not reset in a finally, the watcher stays alive but never refreshes
      // again, so context.md never appears no matter how long we wait.
      watching = watchProject(project, { refreshMs: 60, debounceMs: 3_600_000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        await fs.stat(contextFile).then(() => true, () => false),
        false,
        'the failing refresh should not have produced a context file',
      );

      contextFails = false;
      await waitFor(
        () => fs.stat(contextFile).then(() => true, () => false),
        10_000,
        'the watcher never refreshed again after a failed refresh',
      );
    } finally {
      process.emit('SIGINT');
      await watching?.catch(() => undefined);
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('SEC-05 Phase 4B-R4 — the source-size bound', () => {
  it('refuses an oversized sparse slot before allocating it', async () => {
    const { project } = await fresh({ master: null });
    const file = path.join(project, '.noosphere', 'master-prompt.md');
    const fixture = await oversizedFile(file, MAX_SLOT_SOURCE_BYTES);
    // POSIX must produce a real hole. If it ever silently stopped doing so this
    // test would still pass while proving far less, so demand it there.
    if (process.platform !== 'win32') {
      assert.equal(fixture.sparse, true, 'the POSIX fixture was not sparse');
    }

    await withTimeout(
      assert.rejects(resolveSlotSource(project, 'master-prompt'), (error) => error.code === 'slot-too-large'),
      10_000,
      'the oversized slot read did not fail fast',
    );
    // The read path degrades: present, unusable, empty — never absent.
    const source = await resolveSlotSourceForRead(project, 'master-prompt');
    assert.equal(source.present, true);
    assert.equal(source.unusable, true);
    assert.equal(source.reason, 'slot-too-large');
    assert.equal(source.bytes.length, 0);
    assert.ok(UNUSABLE_SOURCE_CODES.has('slot-too-large'));
  });

  it('accepts a slot of exactly the bound and refuses one byte more', async () => {
    const { project } = await fresh({ master: null });
    const file = path.join(project, '.noosphere', 'master-prompt.md');
    await fs.writeFile(file, Buffer.alloc(MAX_SLOT_SOURCE_BYTES, 0x61));
    const exact = await resolveSlotSource(project, 'master-prompt');
    assert.equal(exact.bytes.length, MAX_SLOT_SOURCE_BYTES);
    assert.equal(exact.present, true);

    await fs.writeFile(file, Buffer.alloc(MAX_SLOT_SOURCE_BYTES + 1, 0x61));
    await assert.rejects(resolveSlotSource(project, 'master-prompt'), (error) => error.code === 'slot-too-large');
  });

  it('refuses an oversized slot BEFORE the owner is asked to confirm and before any trust state exists', async () => {
    const { env, project } = await fresh({ master: null });
    const file = path.join(project, '.noosphere', 'master-prompt.md');
    await oversizedFile(file, MAX_SLOT_SOURCE_BYTES);

    const { approveSlot } = await import('../continuity/internal/approval-service.js');
    let asked = false;
    await assert.rejects(
      approveSlot({
        projectRoot: project,
        slot: 'master-prompt',
        env,
        confirm: () => { asked = true; return true; },
      }),
      (error) => error.code === 'slot-too-large',
    );
    assert.equal(asked, false, 'the owner was asked to confirm bytes that were never read');
    // Nothing was created under NOOSPHERE_HOME: no binding, no key, no manifest.
    assert.equal(await fs.stat(env.NOOSPHERE_HOME).then(() => true, () => false), false);
  });

  it('lets --replace repair an oversized pinned master prompt without reading it', async () => {
    const { env, project } = await fresh({ master: null });
    const recalled = [];
    const server = await stubRelayer(project, recalled);
    try {
      const file = path.join(project, '.noosphere', 'master-prompt.md');
      const fixture = await oversizedFile(file, MAX_SLOT_SOURCE_BYTES);

      // Without --replace the oversized file counts as EXISTING, so the capture
      // is refused rather than silently overwriting the owner's pinned prompt.
      const refused = await run(['master-prompt', '--content', 'REPAIRED PROMPT'], { env, project });
      assert.equal(refused.code, 0, refused.stderr);
      assert.equal((await fs.stat(file)).size, fixture.size, 'the oversized file was overwritten without --replace');

      const repaired = await withTimeout(
        run(['master-prompt', '--replace', '--content', 'REPAIRED PROMPT'], { env, project }),
        30_000,
        '--replace read the oversized file instead of skipping it',
      );
      assert.equal(repaired.code, 0, repaired.stderr);
      assert.equal(await fs.readFile(file, 'utf8'), 'REPAIRED PROMPT');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('bounds sibling repository inputs too, and keeps unknown I/O errors visible', async () => {
    const { project } = await fresh();
    const journal = path.join(project, '.noosphere', 'journal.md');
    await oversizedFile(journal, 8 * 1024 * 1024);
    const recalled = [];
    const server = await stubRelayer(project, recalled);
    try {
      const output = await withTimeout(
        refreshContext(project),
        15_000,
        'refreshContext tried to read a 64 GiB journal',
      );
      assert.match(output, /## Local public work journal/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // The bound is the primitive's, not a per-call-site reimplementation, and an
    // unrecognised failure still propagates instead of degrading to empty.
    await assert.rejects(
      readBoundedRegularFile(journal, { maxBytes: 1024 }),
      (error) => error.code === 'state-file-too-large',
    );
    await assert.rejects(
      readBoundedRegularFile(journal, { maxBytes: -1 }),
      (error) => error.code === 'state-read-bound-invalid',
    );
  });
});

describe('SEC-05 Phase 4B-R4 — printProtocol keeps one strict output contract', () => {
  it('exits nonzero with a diagnostic when the instructions slot is absent', async () => {
    const { env, project } = await fresh({ instructions: undefined });
    const result = await run(['protocol'], { env, project });
    assert.notEqual(result.code, 0, 'an absent protocol exited 0');
    assert.equal(result.stdout, '', 'an absent protocol emitted bytes');
    assert.match(result.stderr, /instructions\.md does not exist/);
  });

  it('exits nonzero for malformed, non-regular and unreadable instructions too', async (t) => {
    const shapes = [
      ['malformed', async (file) => { await fs.writeFile(file, Buffer.from([0xc3, 0x28])); return true; }],
      ['directory', async (file) => { await fs.mkdir(file); return true; }],
      ['oversized', async (file) => { await oversizedFile(file, MAX_SLOT_SOURCE_BYTES); return true; }],
      ['fifo', async (file) => mkfifo(file)],
      ['symlink', async (file) => trySymlink(os.devNull, file)],
    ];
    let asserted = 0;
    for (const [label, plant] of shapes) {
      const { env, project } = await fresh({ instructions: undefined });
      const file = path.join(project, '.noosphere', 'instructions.md');
      if (!await plant(file)) continue;
      asserted += 1;
      const result = await withTimeout(
        run(['protocol'], { env, project }),
        30_000,
        `\`noosphere protocol\` blocked on a ${label} instructions slot`,
      );
      assert.notEqual(result.code, 0, `${label} exited 0`);
      assert.equal(result.stdout, '', `${label} emitted bytes`);
      assert.match(result.stderr, /Noosphere continuity: /, label);
    }
    const required = process.platform === 'win32' ? 3 : shapes.length;
    assert.ok(asserted >= required, `only ${asserted} of ${shapes.length} shapes were exercised`);
    t.diagnostic(`asserted ${asserted} shapes`);
  });

  it('still emits exactly the recorded bytes for an ordinary instructions file', async () => {
    const body = 'Follow the protocol.\nSecond line.\n';
    const { env, project } = await fresh({ instructions: body });
    const result = await run(['protocol'], { env, project });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, body);
  });

  it('keeps the pre-Phase-4B behaviour for a present-but-empty file: zero bytes, exit 0', async () => {
    const { env, project } = await fresh({ instructions: '' });
    const result = await run(['protocol'], { env, project });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  });
});

describe('SEC-05 Phase 4B-R4 — present-but-unusable survives rendering', () => {
  const corruptions = [
    ['slot-invalid-utf8', async (file) => { await fs.writeFile(file, Buffer.concat([Buffer.from('PINNED\n'), Buffer.from([0xff])])); return true; }],
    ['slot-too-large', async (file) => { await oversizedFile(file, MAX_SLOT_SOURCE_BYTES); return true; }],
    ['EISDIR', async (file) => { await fs.mkdir(file); return true; }],
    ['slot-not-regular-file', async (file) => mkfifo(file)],
  ];

  it('never renders a present-but-unusable master prompt as "No master prompt has been recorded"', async () => {
    let asserted = 0;
    for (const [reason, corrupt] of corruptions) {
      const { project } = await fresh({ master: null });
      // A real baseline, so the only slot in a degraded state is the one under
      // test and a legitimate baseline restoration cannot be mistaken for one.
      await fs.writeFile(path.join(project, '.noosphere', 'baseline.md'), '# Noosphere project baseline\n\nseeded\n');
      const file = path.join(project, '.noosphere', 'master-prompt.md');
      if (!await corrupt(file)) continue;
      asserted += 1;
      const recalled = [];
      const server = await stubRelayer(project, recalled);
      try {
        const output = await withTimeout(refreshContext(project), 15_000, `refresh blocked on ${reason}`);
        assert.doesNotMatch(output, /No master prompt has been recorded/, reason);
        assert.match(output, /This slot EXISTS but could not be read/, reason);
        assert.match(output, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), reason);
        assert.match(output, /NOT authoritative/, reason);
        // No Walrus restoration for content that is present, and no remote bait
        // anywhere in the render.
        assert.ok(!recalled.includes('master-prompt'), `${reason} recalled: ${recalled.join(',')}`);
        assert.doesNotMatch(output, new RegExp(REMOTE_BAIT), reason);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
    const required = process.platform === 'win32' ? 3 : corruptions.length;
    assert.ok(asserted >= required, `only ${asserted} of ${corruptions.length} corruptions were exercised`);
  });

  it('does not leak the unusable slot bytes into the diagnostic', async () => {
    const { project } = await fresh({ master: null });
    const hostile = 'SECRET-BYTES-FROM-A-CORRUPT-SLOT';
    await fs.writeFile(
      path.join(project, '.noosphere', 'master-prompt.md'),
      Buffer.concat([Buffer.from(`${hostile}\n`), Buffer.from([0xff])]),
    );
    const server = await stubRelayer(project, []);
    try {
      const output = await refreshContext(project);
      assert.doesNotMatch(output, new RegExp(hostile));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('distinguishes an absent baseline from an unusable one, and restores only the absent one', async () => {
    // No bait: the point here is which slot is RECALLED, not what comes back.
    const absent = await fresh({ master: null });
    const absentRecalled = [];
    const absentServer = await stubRelayer(absent.project, absentRecalled, { bait: false });
    try {
      const output = await refreshContext(absent.project);
      assert.match(output, /No onboarding baseline has been created/);
      assert.ok(absentRecalled.includes('project-baseline'), `recalled: ${absentRecalled.join(',')}`);
    } finally {
      await new Promise((resolve) => absentServer.close(resolve));
    }

    const broken = await fresh({ master: null });
    await fs.mkdir(path.join(broken.project, '.noosphere', 'baseline.md'));
    const brokenRecalled = [];
    const brokenServer = await stubRelayer(broken.project, brokenRecalled, { bait: false });
    try {
      const output = await refreshContext(broken.project);
      assert.doesNotMatch(output, /No onboarding baseline has been created/);
      assert.match(output, /This slot EXISTS but could not be read \(EISDIR\)/);
      assert.ok(!brokenRecalled.includes('project-baseline'), `recalled: ${brokenRecalled.join(',')}`);
    } finally {
      await new Promise((resolve) => brokenServer.close(resolve));
    }
  });
});

describe('SEC-05 Phase 4B-R4 — the symlink policy is deliberate', () => {
  it('refuses a symlinked slot FILE, whatever it points at', async (t) => {
    const targets = [];
    const { project } = await fresh({ master: null });
    const decoy = path.join(project, 'decoy.md');
    await fs.writeFile(decoy, 'BYTES FROM SOMEWHERE ELSE\n');
    const file = path.join(project, '.noosphere', 'master-prompt.md');
    if (!await trySymlink(decoy, file)) {
      t.skip('this platform cannot create symlinks without elevation');
      return;
    }
    targets.push(decoy);

    await assert.rejects(
      resolveSlotSource(project, 'master-prompt'),
      (error) => error.code === 'slot-not-regular-file',
    );
    const source = await resolveSlotSourceForRead(project, 'master-prompt');
    assert.equal(source.unusable, true);
    assert.equal(source.text, '', 'a symlinked slot file was followed');
  });

  it('refuses a symlinked slot file at the kernel even if the classification is bypassed', async (t) => {
    const { project } = await fresh({ master: null });
    const decoy = path.join(project, 'decoy.md');
    await fs.writeFile(decoy, 'BYTES FROM SOMEWHERE ELSE\n');
    const file = path.join(project, '.noosphere', 'master-prompt.md');
    if (!await trySymlink(decoy, file)) {
      t.skip('this platform cannot create symlinks without elevation');
      return;
    }
    if (process.platform === 'win32') {
      t.skip('O_NOFOLLOW does not exist on Windows; the documented residual applies there');
      return;
    }
    // The primitive is the guarantee, not the lstat that precedes it: called
    // directly it still refuses, because O_NOFOLLOW refuses in open(2).
    await assert.rejects(
      readBoundedRegularFile(file, { maxBytes: MAX_SLOT_SOURCE_BYTES }),
      (error) => error.code === 'state-file-symlink',
    );
  });

  it('SUPPORTS a symlinked parent directory — that distinction is the policy', async (t) => {
    const { project } = await fresh({ master: null });
    const real = path.join(project, 'real-noosphere');
    await fs.mkdir(real, { recursive: true });
    await fs.writeFile(path.join(real, 'master-prompt.md'), MASTER);
    await fs.rm(path.join(project, '.noosphere'), { recursive: true, force: true });
    if (!await trySymlink(real, path.join(project, '.noosphere'))) {
      t.skip('this platform cannot create symlinks without elevation');
      return;
    }
    const source = await resolveSlotSource(project, 'master-prompt');
    assert.equal(source.text, MASTER, 'a symlinked parent directory was rejected');
    assert.equal(source.present, true);
  });

  it('states the policy where a user would look for it', async () => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const security = await fs.readFile(path.join(repoRoot, 'SECURITY.md'), 'utf8');
    assert.match(security, /symlinked slot file/i);
    assert.match(security, /symlinked parent director/i);
    // A compatibility change has to be announced, not just implemented.
    assert.match(security, /compatibility/i);
  });
});

describe('SEC-05 Phase 4B-R4 — ordinary files are untouched by all of this', () => {
  it('reads a normal slot byte-for-byte, including multi-byte UTF-8', async () => {
    const body = `plain ascii\n${String.fromCodePoint(0x1f600)} ${String.fromCodePoint(0x00e9)}\n`;
    const { project } = await fresh({ master: body });
    const source = await resolveSlotSource(project, 'master-prompt');
    assert.equal(source.text, body);
    assert.deepEqual(source.bytes, Buffer.from(body, 'utf8'));
    assert.equal(source.present, true);
  });

  it('renders an ordinary project exactly as before', async () => {
    const { project } = await fresh();
    await fs.writeFile(
      path.join(project, '.noosphere', 'journal.md'),
      '# journal\n\n## 2026-07-26 — entry\n\nsomething happened\n',
    );
    await fs.writeFile(
      path.join(project, '.noosphere', 'followups.jsonl'),
      `${JSON.stringify({ timestamp: '2026-07-26T00:00:00Z', content: 'do the thing' })}\n`,
    );
    const server = await stubRelayer(project, []);
    try {
      const output = await refreshContext(project);
      assert.match(output, /## Pinned master prompt/);
      assert.doesNotMatch(output, /This slot EXISTS but could not be read/);
      assert.match(output, /something happened/);
      assert.match(output, /do the thing/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reads an ordinary file through the primitive with no change in bytes', async () => {
    const { project } = await fresh();
    const file = path.join(project, '.noosphere', 'master-prompt.md');
    const bytes = await readBoundedRegularFile(file, { maxBytes: MAX_SLOT_SOURCE_BYTES });
    assert.deepEqual(bytes, Buffer.from(MASTER, 'utf8'));
    assert.equal(await readBoundedRegularFile(path.join(project, 'nope.md'), { maxBytes: 16 }), null);
  });
});

// SEC-05 Phase 4B-R4 — the read-modify-write callers.
//
// The bounded read collapses "present but unreadable" to empty text for the many
// callers whose only correct answer is empty. A caller that WRITES what it read
// back cannot use that convention: for it, empty means "the file had nothing in
// it", and acting on that destroys whatever the user actually wrote. The adapter
// files are the reachable case — `CLAUDE.md -> AGENTS.md` is an ordinary setup
// and pre-Phase-4B `readFile` followed it — so the whole of the user's AGENTS.md
// would be replaced by the managed block alone.
describe('SEC-05 Phase 4B-R4 — a read-modify-write never rewrites a file it could not read', () => {
  const USER_CONTENT = '# My AGENTS file\n\nIMPORTANT user instructions that must not be lost.\n';

  async function adapterProject() {
    const { project } = await fresh();
    await fs.writeFile(
      path.join(project, '.noosphere', 'config.json'),
      JSON.stringify({ project_id: 'r4-adapters', relayer_url: 'http://127.0.0.1:1' }),
      'utf8',
    );
    return project;
  }

  it('preserves user content around the managed block (the guard is falsifiable)', async () => {
    const project = await adapterProject();
    const agents = path.join(project, 'AGENTS.md');
    await fs.writeFile(agents, USER_CONTENT, 'utf8');
    await configureProjectAdapters(project, ['codex']);
    const written = await fs.readFile(agents, 'utf8');
    assert.match(written, /IMPORTANT user instructions that must not be lost/);
    assert.match(written, /noosphere:continuity:start/);
  });

  it('refuses a symlinked adapter file instead of overwriting its target', async () => {
    const project = await adapterProject();
    const agents = path.join(project, 'AGENTS.md');
    await fs.writeFile(agents, USER_CONTENT, 'utf8');
    if (!await trySymlink('AGENTS.md', path.join(project, 'CLAUDE.md'))) return;

    await assert.rejects(
      configureProjectAdapters(project, ['claude']),
      /CLAUDE\.md exists but could not be read \(state-file-symlink\); refusing to replace it/,
    );
    // The symlink target keeps every byte the user wrote, and the link is intact.
    assert.equal(await fs.readFile(agents, 'utf8'), USER_CONTENT);
    assert.equal((await fs.lstat(path.join(project, 'CLAUDE.md'))).isSymbolicLink(), true);
  });

  it('refuses a non-regular adapter file instead of replacing it', async () => {
    const project = await adapterProject();
    const gemini = path.join(project, 'GEMINI.md');
    if (!await mkfifo(gemini)) return;

    await assert.rejects(
      configureProjectAdapters(project, ['gemini']),
      /GEMINI\.md exists but could not be read \(state-file-not-regular\); refusing to replace it/,
    );
    assert.equal((await fs.lstat(gemini)).isFIFO(), true);
  });

  it('does not create Cursor directories through a symlinked parent', async () => {
    const project = await adapterProject();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-r6-outside-'));
    temporary.push(outside);
    if (!await trySymlink(outside, path.join(project, '.cursor'))) return;

    await assert.rejects(
      configureProjectAdapters(project, ['cursor']),
      (error) => error.code === 'state-dir-symlink',
    );
    assert.deepEqual(await fs.readdir(outside), []);
  });

  it('does not remove Cursor configuration through a symlinked parent', async () => {
    const project = await adapterProject();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-r6-remove-outside-'));
    temporary.push(outside);
    await fs.mkdir(path.join(outside, 'rules'));
    const outsideMcp = path.join(outside, 'mcp.json');
    const outsideRule = path.join(outside, 'rules', 'noosphere.mdc');
    const mcp = JSON.stringify({ mcpServers: { noosphere: { command: 'outside' } } });
    await fs.writeFile(outsideMcp, mcp);
    await fs.writeFile(outsideRule, 'outside rule\n');
    if (!await trySymlink(outside, path.join(project, '.cursor'))) return;

    await assert.rejects(
      configureProjectAdapters(project, []),
      (error) => error.code === 'state-dir-symlink',
    );
    assert.equal(await fs.readFile(outsideMcp, 'utf8'), mcp);
    assert.equal(await fs.readFile(outsideRule, 'utf8'), 'outside rule\n');
  });
});

describe('SEC-05 Phase 4B-R6 — shipped ingress and mutation paths stay on safe primitives', () => {
  it('does not reintroduce direct repository reads or appends in the reviewed modules', async () => {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    for (const relative of [
      'hooks/capture-prompt.js',
      'hooks/post-session.js',
      'continuity/credentials-cli.js',
      'continuity/csp/summary.js',
      'continuity/acp/execution-store.js',
    ]) {
      const source = await fs.readFile(path.join(packageRoot, relative), 'utf8');
      assert.doesNotMatch(source, /\breadFile(?:Sync)?\s*\(/, relative);
    }
    const entry = await fs.readFile(path.join(packageRoot, 'continuity/index.js'), 'utf8');
    assert.doesNotMatch(entry, /\bappendFile\s*\(/);
    assert.doesNotMatch(entry, /\bwriteFile\s*\(/);
  });
});
