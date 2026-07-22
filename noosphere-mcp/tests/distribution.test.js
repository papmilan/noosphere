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
  rename,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

describe('published package distribution', () => {
  it('installs from packed artifacts without repository-only files', async () => {
    if (process.platform === 'win32') return;

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
      await execFileAsync('npm', ['ci', '--omit=dev', '--ignore-scripts'], {
        cwd: dockerContext,
        env: { ...process.env, npm_config_cache: cache },
        maxBuffer: 2_000_000,
      });
      await execFileAsync(process.execPath, [
        '--input-type=module', '-e', "const p = await import('@noosphere/acp-protocol'); if (!p.SYNC_PROTOCOL_VERSION) process.exit(2);",
      ], { cwd: dockerContext, maxBuffer: 2_000_000 });
      for (const module of [
        'acp-protocol.js', 'exact-routes.js', 'exact-state.js',
        'snapshot-backend.js', 'walrus-snapshot-backend.js',
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
            NOOSPHERE_TEST_PLATFORM: 'linux',
            NOOSPHERE_SKIP_SYSTEMCTL: '1',
            NOOSPHERE_SKIP_CLAUDE_HOOK: '1',
            XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
          },
          maxBuffer: 2_000_000,
        },
      );

      assert.match(stdout, /Noosphere installed for this Linux user/);
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
      const secureFs = path.join(
        installedMcp,
        'node_modules',
        '@noosphere',
        'secure-fs',
      );
      await access(path.join(secureFs, 'index.js'));
      await access(path.join(secureFs, 'windows-owner-only.ps1'));
      await execFileAsync(process.execPath, [
        '--input-type=module', '-e',
        "await import('./continuity/secure-fs.js'); await import('@noosphere/secure-fs');",
      ], { cwd: installedMcp, maxBuffer: 2_000_000 });
      const { stdout: help } = await execFileAsync(
        process.execPath,
        [path.join(installedMcp, 'continuity', 'index.js'), 'help'],
        { cwd: installedMcp, maxBuffer: 2_000_000 },
      );
      assert.match(help, /Noosphere continuity CLI/);
      await startInstalledRelayer(installedRelayer, fakeHome);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

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
    once(child.stdout, 'data').then(() => undefined),
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
  const { stdout } = await execFileAsync(
    'npm',
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

async function extract(tarball, destination) {
  await execFileAsync(
    'tar',
    ['-xzf', tarball, '--strip-components=1', '-C', destination],
  );
}
