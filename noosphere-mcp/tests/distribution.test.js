import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
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
      assert.equal(
        await readFile(path.join(relayerRoot, 'env.example'), 'utf8'),
        await readFile(path.join(relayerRoot, '.env.example'), 'utf8'),
        'The public and npm-safe environment templates must stay identical',
      );

      const mcpTarball = await pack(mcpRoot, temporaryRoot, cache);
      const relayerTarball = await pack(relayerRoot, temporaryRoot, cache);
      await mkdir(packedMcp, { recursive: true });
      await mkdir(packedRelayer, { recursive: true });
      await extract(mcpTarball, packedMcp);
      await extract(relayerTarball, packedRelayer);

      await access(path.join(packedMcp, 'LICENSE'));
      await access(path.join(packedRelayer, 'LICENSE'));
      await access(path.join(packedRelayer, 'env.example'));
      await access(path.join(packedRelayer, 'npm-shrinkwrap.json'));
      await assert.rejects(access(path.join(packedMcp, 'tests')));

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
            NOOSPHERE_SKIP_NPM: '1',
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
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

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
