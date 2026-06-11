import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const installer = path.join(packageRoot, 'lifecycle', 'install.js');

describe('Noosphere macOS lifecycle installer', () => {
  it('installs a global CLI, shell hook, and both LaunchAgents', async () => {
    const fakeHome = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-installer-home-'),
    );
    const noosphereHome = path.join(fakeHome, '.noosphere');
    await writeFile(path.join(fakeHome, '.zshrc'), '# existing settings\n');

    try {
      await runInstaller('install', fakeHome, noosphereHome);
      const wrapper = await readFile(
        path.join(noosphereHome, 'bin', 'noosphere'),
        'utf8',
      );
      const shell = await readFile(
        path.join(noosphereHome, 'shell.zsh'),
        'utf8',
      );
      const zshrc = await readFile(path.join(fakeHome, '.zshrc'), 'utf8');
      const relayerPlist = await readFile(
        path.join(
          fakeHome,
          'Library',
          'LaunchAgents',
          'xyz.noosphere.relayer.plist',
        ),
        'utf8',
      );
      const managerPlist = await readFile(
        path.join(
          fakeHome,
          'Library',
          'LaunchAgents',
          'xyz.noosphere.manager.plist',
        ),
        'utf8',
      );

      assert.match(wrapper, /continuity\/index\.js/);
      assert.match(shell, /add-zsh-hook chpwd/);
      assert.match(shell, /noosphere activate --quiet/);
      assert.match(zshrc, />>> noosphere >>>/);
      assert.match(relayerPlist, /xyz\.noosphere\.relayer/);
      assert.match(relayerPlist, /RunAtLoad/);
      assert.match(managerPlist, /xyz\.noosphere\.manager/);
      assert.match(managerPlist, /KeepAlive/);
      await access(
        path.join(
          noosphereHome,
          'app',
          'noosphere-relayer',
          'index.js',
        ),
      );

      await runInstaller('uninstall', fakeHome, noosphereHome);
      await assert.rejects(access(noosphereHome));
      assert.doesNotMatch(
        await readFile(path.join(fakeHome, '.zshrc'), 'utf8'),
        />>> noosphere >>>/,
      );
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

async function runInstaller(action, home, noosphereHome) {
  const child = spawn(process.execPath, [installer, action], {
    env: {
      ...process.env,
      HOME: home,
      NOOSPHERE_HOME: noosphereHome,
      NOOSPHERE_TEST_PLATFORM: 'darwin',
      NOOSPHERE_SKIP_LAUNCHCTL: '1',
      NOOSPHERE_SKIP_CLAUDE_HOOK: '1',
      NOOSPHERE_SKIP_NPM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(
    code,
    0,
    `${Buffer.concat(stderr).toString()}\n${Buffer.concat(stdout).toString()}`,
  );
}
