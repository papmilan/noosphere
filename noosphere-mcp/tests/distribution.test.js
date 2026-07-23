import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const mcpRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repositoryRoot = path.resolve(mcpRoot, '..');
const relayerRoot = path.join(repositoryRoot, 'noosphere-relayer');
const protocolRoot = path.join(repositoryRoot, 'noosphere-acp-protocol');

async function waitForOutput(stream, chunks, message) {
  while (!Buffer.concat(chunks).toString().includes(message)) {
    await once(stream, 'data');
  }
}

it('waits for the complete installed-relayer readiness message across stdout chunks', async () => {
  const stdout = new PassThrough();
  const chunks = [];
  stdout.on('data', (chunk) => chunks.push(chunk));

  const ready = waitForOutput(stdout, chunks, 'Noosphere is live');
  stdout.write('booting\nNoosphere ');
  await Promise.resolve();
  assert.equal(await Promise.race([ready.then(() => true), Promise.resolve(false)]), false);

  stdout.write('is live\n');
  await ready;
});

describe('published package distribution', () => {
  it('installs from packed artifacts without repository-only files', async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-distribution-'),
    );
    const cache = path.join(temporaryRoot, 'npm-cache');
    const packageRoot = path.join(temporaryRoot, 'node_modules');
    const packedMcp = path.join(packageRoot, 'noosphere-continuity');
    const packedRelayer = path.join(packageRoot, 'noosphere-relayer');
    const fakeHome = path.join(temporaryRoot, 'home');
    const noosphereHome = path.join(fakeHome, '.noosphere');

    try {
      const mcpTarball = await pack(mcpRoot, temporaryRoot, cache);
      const relayerTarball = await pack(relayerRoot, temporaryRoot, cache);
      await mkdir(packedMcp, { recursive: true });
      await mkdir(packedRelayer, { recursive: true });
      await extract(mcpTarball, packedMcp);
      await extract(relayerTarball, packedRelayer);

      await access(path.join(packedMcp, 'LICENSE'));
      assert.equal(
        await readFile(path.join(packedMcp, 'CSP.md'), 'utf8'),
        await readFile(path.join(repositoryRoot, 'CSP.md'), 'utf8'),
      );
      assert.match(
        await readFile(path.join(packedMcp, 'README.md'), 'utf8'),
        /\[CSP specification\]\(CSP\.md\)/u,
      );
      await access(path.join(packedRelayer, 'LICENSE'));
      await access(path.join(packedRelayer, 'env.example'));
      await access(path.join(packedRelayer, 'npm-shrinkwrap.json'));
      await access(path.join(packedRelayer, 'durability.js'));
      await access(path.join(packedRelayer, 'vendor', 'acp-protocol', 'schema.json'));
      const dockerfile = await readFile(path.join(relayerRoot, 'Dockerfile'), 'utf8');
      assert.match(dockerfile, /COPY --chown=node:node vendor\/acp-protocol \.\/vendor\/acp-protocol/);
      const protocolManifest = JSON.parse(await readFile(path.join(protocolRoot, 'package.json'), 'utf8'));
      for (const source of [...protocolManifest.files, 'package.json']) {
        assert.equal(
          await readFile(path.join(relayerRoot, 'vendor', 'acp-protocol', source), 'utf8'),
          await readFile(path.join(protocolRoot, source), 'utf8'),
          `Docker-context protocol mirror drifted: ${source}`,
        );
      }
      const dockerContext = path.join(temporaryRoot, 'docker-context');
      await mkdir(dockerContext);
      await Promise.all([
        copyFile(path.join(relayerRoot, 'package.json'), path.join(dockerContext, 'package.json')),
        copyFile(path.join(relayerRoot, 'npm-shrinkwrap.json'), path.join(dockerContext, 'npm-shrinkwrap.json')),
        cp(path.join(relayerRoot, 'vendor'), path.join(dockerContext, 'vendor'), { recursive: true }),
      ]);
      await runNpm(['ci', '--omit=dev', '--ignore-scripts'], {
        cwd: dockerContext,
        env: { ...process.env, npm_config_cache: cache },
        maxBuffer: 2_000_000,
      });
      await execFileAsync(process.execPath, [
        '--input-type=module', '-e', "const p = await import('@noosphere/acp-protocol'); if (!p.SYNC_PROTOCOL_VERSION) process.exit(2);",
      ], { cwd: dockerContext, maxBuffer: 2_000_000 });
      for (const module of [
        'acp-protocol.js', 'exact-routes.js', 'exact-state.js',
        'relayer-origins.js', 'snapshot-backend.js',
        'walrus-snapshot-backend.js',
      ]) await access(path.join(packedRelayer, module));
      for (const module of [
        'git-state.js', 'reconcile.js', 'remote-client.js', 'sync-metadata.js', 'sync.js',
      ]) await access(path.join(packedMcp, 'continuity', 'acp', module));
      for (const bundled of ['package.json', 'index.js', 'schema.json']) {
        await access(path.join(packedMcp, 'node_modules', '@noosphere', 'acp-protocol', bundled));
      }
      await execFileAsync(process.execPath, [
        '--input-type=module', '-e',
        "await import('./continuity/acp/sync.js'); const p = await import('@noosphere/acp-protocol'); if (!p.SYNC_PROTOCOL_VERSION) process.exit(2);",
      ], { cwd: packedMcp, maxBuffer: 2_000_000 });
      await assert.rejects(access(path.join(packedMcp, 'tests')));
      for (const forbidden of [
        path.join(packedRelayer, '.env'),
        path.join(packedRelayer, '.noosphere-runtime'),
        path.join(packedMcp, '.noosphere'),
        path.join(packedMcp, 'tests', 'fixtures'),
      ]) await assert.rejects(access(forbidden));

      const installer = path.join(
        packedMcp,
        'lifecycle',
        'install.js',
      );
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [installer, 'install'],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            NOOSPHERE_HOME: noosphereHome,
            NOOSPHERE_TEST_PLATFORM: process.platform,
            NOOSPHERE_SKIP_SYSTEMCTL: '1',
            NOOSPHERE_SKIP_LAUNCHCTL: '1',
            NOOSPHERE_SKIP_SCHTASKS: '1',
            NOOSPHERE_SKIP_CLAUDE_HOOK: '1',
            XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
          },
          maxBuffer: 2_000_000,
        },
      );

      assert.match(stdout, new RegExp(`Noosphere installed for this ${platformName()} user`));
      assert.doesNotMatch(stderr, /ENOENT/);
      await access(
        path.join(
          noosphereHome,
          'app',
          'noosphere-relayer',
          'npm-shrinkwrap.json',
        ),
      );
      const installedEnv = await readFile(
        path.join(noosphereHome, 'app', 'noosphere-relayer', '.env'),
        'utf8',
      );
      assert.match(installedEnv, /MEMWAL_ACCOUNT_ID=/);

      // The lifecycle runtime must be self-contained: it cannot fall back to
      // the packed source tree that install:user was invoked from.
      const unavailableSource = path.join(temporaryRoot, 'packed-source-gone');
      await rename(packedMcp, unavailableSource);
      const installedMcp = path.join(noosphereHome, 'app', 'noosphere-mcp');
      const installedRelayer = path.join(noosphereHome, 'app', 'noosphere-relayer');
      const installedRelayerManifest = JSON.parse(
        await readFile(path.join(installedRelayer, 'package.json'), 'utf8'),
      );
      for (const runtimeEntry of installedRelayerManifest.files) {
        await access(path.join(installedRelayer, runtimeEntry));
      }
      const secureFs = path.join(
        installedMcp,
        'node_modules',
        '@noosphere',
        'secure-fs',
      );
      const acpProtocol = path.join(
        installedMcp,
        'node_modules',
        '@noosphere',
        'acp-protocol',
      );
      await access(path.join(secureFs, 'index.js'));
      await access(path.join(secureFs, 'windows-owner-only.ps1'));
      await access(path.join(acpProtocol, 'index.js'));
      assert.equal(await isPathInside(installedMcp, secureFs), true);
      assert.equal(await isPathInside(installedMcp, acpProtocol), true);
      await execFileAsync(process.execPath, [
        '--input-type=module', '-e',
        "await import('./continuity/secure-fs.js'); await import('@noosphere/secure-fs');",
      ], { cwd: installedMcp, maxBuffer: 2_000_000 });
      const helperResult = JSON.parse((await execFileAsync(process.execPath, [
        '--input-type=module', '-e', installedHelperProbe(),
      ], {
        cwd: installedMcp,
        env: {
          ...process.env,
          NOOSPHERE_HELPER_TEST_ROOT: path.join(fakeHome, 'installed-helper'),
        },
        maxBuffer: 2_000_000,
      })).stdout);
      assert.equal(helperResult.value, 'installed-runtime-secret');
      assert.equal(await isPathInside(installedMcp, helperResult.jsPath), true);
      assert.equal(await isPathInside(installedMcp, helperResult.helperPath), true);
      assert.equal(helperResult.jsPath.includes(unavailableSource), false);
      assert.equal(helperResult.helperPath.includes(unavailableSource), false);
      if (process.platform === 'win32') {
        assert.deepEqual(
          helperResult.sids.sort(),
          [helperResult.currentSid, 'S-1-5-18', 'S-1-5-32-544'].sort(),
        );
      } else {
        assert.deepEqual(helperResult.sids, []);
      }
      const { stdout: help } = await execFileAsync(
        process.execPath,
        [path.join(installedMcp, 'continuity', 'index.js'), 'help'],
        { cwd: installedMcp, maxBuffer: 2_000_000 },
      );
      assert.match(help, /Noosphere continuity/);
      await startInstalledRelayer(installedRelayer, fakeHome);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

async function isPathInside(root, candidate) {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ]);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function installedHelperProbe() {
  return `
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    import { mkdir, rm } from 'node:fs/promises';
    import {
      atomicOwnerOnlyWrite,
      currentWindowsSid,
      readOwnerOnlyFile,
      verifyOwnerOnlyWindows,
    } from '@noosphere/secure-fs';
    const root = process.env.NOOSPHERE_HELPER_TEST_ROOT;
    const file = path.join(root, 'sensitive.txt');
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    try {
      await atomicOwnerOnlyWrite(file, 'installed-runtime-secret', { root });
      const value = (await readOwnerOnlyFile(file, { root })).toString();
      const jsPath = fileURLToPath(import.meta.resolve('@noosphere/secure-fs'));
      const helperPath = path.join(path.dirname(jsPath), 'windows-owner-only.ps1');
      console.log(JSON.stringify({
        currentSid: currentWindowsSid(),
        helperPath,
        jsPath,
        sids: verifyOwnerOnlyWindows(file),
        value,
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  `;
}

async function startInstalledRelayer(installedRelayer, fakeHome) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: installedRelayer,
    env: {
      ...process.env,
      HOME: fakeHome,
      NOOSPHERE_MEMORY_BACKEND: 'local-file',
      NOOSPHERE_STATE_PATH: path.join(fakeHome, 'relayer-state.json'),
      NOOSPHERE_SNAPSHOT_PATH: path.join(fakeHome, 'relayer-snapshots'),
      PORT: '39181',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const closed = once(child, 'close');
  const started = Promise.race([
    waitForOutput(child.stdout, stdout, 'Noosphere is live'),
    closed.then(([code]) => {
      throw new Error(`installed relayer exited ${code}: ${Buffer.concat(stderr)}`);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('installed relayer did not start')), 15_000)),
  ]);
  try {
    await started;
    assert.match(Buffer.concat(stdout).toString(), /Noosphere is live/);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

async function pack(root, destination, cache) {
  const { stdout } = await runNpm(
    ['pack', '--pack-destination', destination, '--json'],
    {
      cwd: root,
      env: { ...process.env, npm_config_cache: cache },
      maxBuffer: 2_000_000,
    },
  );
  const result = JSON.parse(stdout);
  return path.join(destination, result[0].filename);
}

function runNpm(args, options) {
  return execFileAsync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    { ...options, shell: process.platform === 'win32' },
  );
}

function platformName() {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

async function extract(tarball, destination) {
  await execFileAsync(
    'tar',
    ['-xzf', tarball, '--strip-components=1', '-C', destination],
  );
}
