import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  mkdtemp,
  mkdir,
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
const continuityCli = path.join(packageRoot, 'continuity', 'index.js');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the installer with the given action and environment overrides.
 * Returns { code, stdout, stderr }.
 */
async function runInstaller(action, env) {
  const child = spawn(process.execPath, [installer, action], {
    env: {
      ...process.env,
      NOOSPHERE_SKIP_CLAUDE_HOOK: '1',
      NOOSPHERE_SKIP_NPM: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve) => child.once('close', resolve));
  return {
    code,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}

/** Assert exit code 0, printing stderr+stdout on failure. */
async function runInstallerOk(action, env) {
  const result = await runInstaller(action, env);
  assert.equal(
    result.code,
    0,
    `Installer exited ${result.code}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`,
  );
  return result;
}

async function runContinuity(action, env) {
  const child = spawn(process.execPath, [continuityCli, action], {
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve) => child.once('close', resolve));
  return {
    code,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}

/** Create a temp fake home directory. */
async function makeFakeHome(extraFiles = {}) {
  const fakeHome = await mkdtemp(
    path.join(os.tmpdir(), 'noosphere-installer-home-'),
  );
  for (const [rel, content] of Object.entries(extraFiles)) {
    const file = path.join(fakeHome, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return fakeHome;
}

/** Base env vars shared across platforms. */
function baseEnv(fakeHome, noosphereHome) {
  return {
    HOME: fakeHome,
    NOOSPHERE_HOME: noosphereHome,
    NOOSPHERE_SKIP_LAUNCHCTL: '1',
    NOOSPHERE_SKIP_SYSTEMCTL: '1',
    NOOSPHERE_SKIP_SCHTASKS: '1',
    NOOSPHERE_SKIP_CLAUDE_HOOK: '1',
    NOOSPHERE_SKIP_NPM: '1',
  };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// macOS tests
// ---------------------------------------------------------------------------

describe('Noosphere macOS lifecycle installer', () => {
  it('installs a global CLI, shell hook, and both LaunchAgents', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '# existing settings\n' });
    const noosphereHome = path.join(fakeHome, '.noosphere');

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
      });

      // CLI wrapper
      const wrapper = await readFile(
        path.join(noosphereHome, 'bin', 'noosphere'),
        'utf8',
      );
      assert.match(wrapper, /continuity\/index\.js/);

      // zsh shell fragment
      const shell = await readFile(path.join(noosphereHome, 'shell.zsh'), 'utf8');
      assert.match(shell, /add-zsh-hook chpwd/);
      assert.match(shell, /noosphere activate --quiet/);

      // .zshrc injection
      const zshrc = await readFile(path.join(fakeHome, '.zshrc'), 'utf8');
      assert.match(zshrc, />>> noosphere >>>/);

      // Global Codex adapter keeps the per-project footprint vendor-neutral.
      const codexInstructions = await readFile(
        path.join(fakeHome, '.codex', 'AGENTS.md'),
        'utf8',
      );
      assert.match(codexInstructions, /Noosphere automatic continuity/);
      assert.match(codexInstructions, /\.noosphere\/master-prompt\.md/);
      assert.match(codexInstructions, /\.noosphere\/followups\.jsonl/);
      const codexHooks = JSON.parse(
        await readFile(
          path.join(fakeHome, '.codex', 'hooks.json'),
          'utf8',
        ),
      );
      assert.match(
        codexHooks.hooks.UserPromptSubmit[0].hooks[0].command,
        /capture-prompt\.js/,
      );

      // LaunchAgent plists
      const relayerPlist = await readFile(
        path.join(fakeHome, 'Library', 'LaunchAgents', 'xyz.noosphere.relayer.plist'),
        'utf8',
      );
      const managerPlist = await readFile(
        path.join(fakeHome, 'Library', 'LaunchAgents', 'xyz.noosphere.manager.plist'),
        'utf8',
      );
      assert.match(relayerPlist, /xyz\.noosphere\.relayer/);
      assert.match(relayerPlist, /RunAtLoad/);
      assert.match(managerPlist, /xyz\.noosphere\.manager/);
      assert.match(managerPlist, /KeepAlive/);

      // Relayer was copied
      await access(path.join(noosphereHome, 'app', 'noosphere-relayer', 'index.js'));

      // Uninstall
      await runInstallerOk('uninstall', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
      });
      await assert.rejects(access(noosphereHome));
      assert.doesNotMatch(
        await readFile(path.join(fakeHome, '.zshrc'), 'utf8'),
        />>> noosphere >>>/,
      );
      await assert.rejects(
        access(path.join(fakeHome, '.codex', 'AGENTS.md')),
      );
      await assert.rejects(
        access(path.join(fakeHome, '.codex', 'hooks.json')),
      );
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('doctor reports expected shape for macOS', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
      });

      const { stdout } = await runInstaller('doctor', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
      });

      const report = JSON.parse(stdout);
      assert.ok(typeof report.node === 'string');
      assert.equal(report.platform, 'darwin');
      assert.ok('installed_cli' in report);
      assert.ok('relayer_service' in report);
      assert.ok('manager_service' in report);
      assert.ok('credentials' in report);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Linux tests
// ---------------------------------------------------------------------------

describe('Noosphere Linux lifecycle installer', () => {
  it('writes systemd user service files and injects shell blocks', async () => {
    const fakeHome = await makeFakeHome({
      '.zshrc': '# existing\n',
      '.bashrc': '# existing\n',
    });
    const noosphereHome = path.join(fakeHome, '.noosphere');
    // Provide a fake XDG_CONFIG_HOME so services land under fakeHome
    const xdgConfig = path.join(fakeHome, '.config');

    // Create config.fish so the installer injects a shell block into it
    const fishConfig = path.join(xdgConfig, 'fish', 'config.fish');
    await mkdir(path.dirname(fishConfig), { recursive: true });
    await writeFile(fishConfig, '# existing fish config\n');

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'linux',
        XDG_CONFIG_HOME: xdgConfig,
        // No XDG_RUNTIME_DIR — systemctl will be skipped by the guard
      });

      // Systemd service files
      const serviceDir = path.join(xdgConfig, 'systemd', 'user');
      const relayerService = await readFile(
        path.join(serviceDir, 'xyz.noosphere.relayer.service'),
        'utf8',
      );
      const managerService = await readFile(
        path.join(serviceDir, 'xyz.noosphere.manager.service'),
        'utf8',
      );

      assert.match(relayerService, /Description=Noosphere Relayer/);
      assert.match(relayerService, /Type=simple/);
      assert.match(relayerService, /Restart=always/);
      assert.match(relayerService, /WantedBy=default\.target/);
      assert.match(relayerService, /index\.js/);

      assert.match(managerService, /Description=Noosphere Manager/);
      assert.match(managerService, /manager\.js/);

      // CLI wrapper (POSIX)
      const wrapper = await readFile(
        path.join(noosphereHome, 'bin', 'noosphere'),
        'utf8',
      );
      assert.match(wrapper, /continuity\/index\.js/);

      // Shell fragments
      const shellZsh = await readFile(path.join(noosphereHome, 'shell.zsh'), 'utf8');
      const shellBash = await readFile(path.join(noosphereHome, 'shell.bash'), 'utf8');
      assert.match(shellZsh, /add-zsh-hook chpwd/);
      assert.match(shellBash, /PROMPT_COMMAND/);

      // RC file injection — zshrc, bashrc, and fish all exist
      const zshrc = await readFile(path.join(fakeHome, '.zshrc'), 'utf8');
      const bashrc = await readFile(path.join(fakeHome, '.bashrc'), 'utf8');
      assert.match(zshrc, />>> noosphere >>>/);
      assert.match(bashrc, />>> noosphere >>>/);
      assert.match(await readFile(fishConfig, 'utf8'), />>> noosphere >>>/);

      // Relayer copied
      await access(path.join(noosphereHome, 'app', 'noosphere-relayer', 'index.js'));

      // Uninstall
      await runInstallerOk('uninstall', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'linux',
        XDG_CONFIG_HOME: xdgConfig,
      });

      // Home dir removed
      await assert.rejects(access(noosphereHome));

      // Service files removed
      assert.equal(
        await exists(path.join(serviceDir, 'xyz.noosphere.relayer.service')),
        false,
      );
      assert.equal(
        await exists(path.join(serviceDir, 'xyz.noosphere.manager.service')),
        false,
      );

      // Shell blocks removed
      assert.doesNotMatch(
        await readFile(path.join(fakeHome, '.zshrc'), 'utf8'),
        />>> noosphere >>>/,
      );
      assert.doesNotMatch(
        await readFile(path.join(fakeHome, '.bashrc'), 'utf8'),
        />>> noosphere >>>/,
      );
      assert.doesNotMatch(
        await readFile(fishConfig, 'utf8'),
        />>> noosphere >>>/,
      );
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('fish config is injected when config.fish exists', async () => {
    const fakeHome = await makeFakeHome();
    const noosphereHome = path.join(fakeHome, '.noosphere');
    const xdgConfig = path.join(fakeHome, '.config');

    // Create fish config file
    const fishConfig = path.join(xdgConfig, 'fish', 'config.fish');
    await mkdir(path.dirname(fishConfig), { recursive: true });
    await writeFile(fishConfig, '# existing fish config\n');

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'linux',
        XDG_CONFIG_HOME: xdgConfig,
      });

      const shellFish = await readFile(path.join(noosphereHome, 'shell.fish'), 'utf8');
      assert.match(shellFish, /function cd/);
      assert.match(shellFish, /_noosphere_auto_activate/);

      const fishRc = await readFile(fishConfig, 'utf8');
      assert.match(fishRc, />>> noosphere >>>/);
      assert.match(fishRc, /shell\.fish/);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('doctor returns expected shape for Linux', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');
    const xdgConfig = path.join(fakeHome, '.config');

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'linux',
        XDG_CONFIG_HOME: xdgConfig,
      });

      const { stdout } = await runInstaller('doctor', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'linux',
        XDG_CONFIG_HOME: xdgConfig,
      });

      const report = JSON.parse(stdout);
      assert.ok(typeof report.node === 'string');
      assert.equal(report.platform, 'linux');
      assert.ok('installed_cli' in report);
      assert.ok('relayer_service' in report);
      assert.ok('manager_service' in report);
      assert.ok('credentials' in report);

      const cliResult = await runContinuity('doctor', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'linux',
        XDG_CONFIG_HOME: xdgConfig,
      });
      assert.equal(cliResult.code, 1);
      assert.match(cliResult.stdout, /"installed_cli": true/);
      assert.match(
        cliResult.stderr,
        /doctor reported one or more failed checks/,
      );
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Windows tests
// ---------------------------------------------------------------------------

describe('Noosphere Windows lifecycle installer', () => {
  it('writes a CMD wrapper, PowerShell fragment, and shell blocks', async () => {
    const fakeHome = await makeFakeHome({
      '.zshrc': '# existing\n',
      '.bashrc': '# existing\n',
    });
    const noosphereHome = path.join(fakeHome, '.noosphere');

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'windows',
      });

      // Windows uses .cmd wrapper
      const wrapper = await readFile(
        path.join(noosphereHome, 'bin', 'noosphere.cmd'),
        'utf8',
      );
      assert.match(wrapper, /continuity.index\.js/);
      assert.match(wrapper, /@echo off/);

      // PowerShell fragment
      const shellPs1 = await readFile(
        path.join(noosphereHome, 'shell.ps1'),
        'utf8',
      );
      assert.match(shellPs1, /Invoke-NoosphereActivate/);
      assert.match(shellPs1, /Set-Location/);

      // zsh and bash fragments still written (cross-shell)
      const shellZsh = await readFile(path.join(noosphereHome, 'shell.zsh'), 'utf8');
      const shellBash = await readFile(path.join(noosphereHome, 'shell.bash'), 'utf8');
      assert.match(shellZsh, /noosphere activate --quiet/);
      assert.match(shellBash, /PROMPT_COMMAND/);

      // RC files get injected if they exist
      const zshrc = await readFile(path.join(fakeHome, '.zshrc'), 'utf8');
      const bashrc = await readFile(path.join(fakeHome, '.bashrc'), 'utf8');
      assert.match(zshrc, />>> noosphere >>>/);
      assert.match(bashrc, />>> noosphere >>>/);

      // Relayer copied
      await access(path.join(noosphereHome, 'app', 'noosphere-relayer', 'index.js'));

      // Uninstall
      await runInstallerOk('uninstall', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'windows',
      });

      await assert.rejects(access(noosphereHome));
      assert.doesNotMatch(
        await readFile(path.join(fakeHome, '.zshrc'), 'utf8'),
        />>> noosphere >>>/,
      );
      assert.doesNotMatch(
        await readFile(path.join(fakeHome, '.bashrc'), 'utf8'),
        />>> noosphere >>>/,
      );
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('doctor returns expected shape for Windows', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'windows',
      });

      const { stdout } = await runInstaller('doctor', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'windows',
      });

      const report = JSON.parse(stdout);
      assert.ok(typeof report.node === 'string');
      assert.equal(report.platform, 'windows');
      assert.ok('installed_cli' in report);
      assert.ok('relayer_service' in report);
      assert.ok('manager_service' in report);
      assert.ok('credentials' in report);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('skips schtasks and still succeeds with NOOSPHERE_SKIP_SCHTASKS=1', async () => {
    // Confirms the guard works: install should complete without schtasks.exe
    const fakeHome = await makeFakeHome();
    const noosphereHome = path.join(fakeHome, '.noosphere');

    try {
      const result = await runInstaller('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'windows',
        NOOSPHERE_SKIP_SCHTASKS: '1',
      });
      assert.equal(
        result.code,
        0,
        `STDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`,
      );
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-platform shell integration tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cross-platform npm spawn (regression: Windows ENOENT)
// ---------------------------------------------------------------------------

describe('npm child-process invocation', () => {
  it('npmCommand resolves to npm.cmd on win32 and npm elsewhere', async () => {
    const { npmCommand, npmStyleCommand } = await import(
      '../lifecycle/util.js'
    );
    assert.equal(npmCommand('win32'), 'npm.cmd');
    assert.equal(npmCommand('darwin'), 'npm');
    assert.equal(npmCommand('linux'), 'npm');
    assert.equal(npmStyleCommand('npx', 'win32'), 'npx.cmd');
    assert.equal(npmStyleCommand('pnpm', 'darwin'), 'pnpm');
  });

  it('npmSpawnOptions sets shell:true on win32 only (CVE-2024-27980)', async () => {
    const { npmSpawnOptions } = await import('../lifecycle/util.js');
    assert.deepEqual(npmSpawnOptions('win32'), { shell: true });
    assert.deepEqual(npmSpawnOptions('darwin'), { shell: false });
    assert.deepEqual(npmSpawnOptions('linux'), { shell: false });
  });

  it('installer on win32 spawns npm.cmd (not npm), so no ENOENT', async () => {
    const fakeHome = await makeFakeHome();
    const noosphereHome = path.join(fakeHome, '.noosphere');
    const fakeBin = path.join(fakeHome, 'fake-bin');
    await mkdir(fakeBin, { recursive: true });

    // Shim records its own executable path so we can prove the right
    // filename was looked up. On Windows, only npm.cmd resolves through
    // PATHEXT; npm (extensionless) yields ENOENT.
    const marker = path.join(fakeHome, 'npm-shim.log');
    const shim =
      `#!/bin/sh\n` +
      `printf '%s\\n' "$0" "$@" > "${marker}"\n`;
    await writeFile(path.join(fakeBin, 'npm.cmd'), shim, { mode: 0o755 });

    try {
      const result = await runInstaller('install', {
        HOME: fakeHome,
        NOOSPHERE_HOME: noosphereHome,
        NOOSPHERE_TEST_PLATFORM: 'win32',
        NOOSPHERE_SKIP_SCHTASKS: '1',
        NOOSPHERE_SKIP_CLAUDE_HOOK: '1',
        NOOSPHERE_SKIP_NPM: '0',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      });
      assert.equal(
        result.code,
        0,
        `Installer exited ${result.code}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`,
      );
      const log = await readFile(marker, 'utf8');
      assert.match(log, /npm\.cmd/, 'installer must invoke npm.cmd on win32');
      assert.match(log, /^ci$/m);
      assert.match(log, /^--omit=dev$/m);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Windows: scheduled task creation blocked by AV/UAC (regression)
// ---------------------------------------------------------------------------

describe('Windows scheduled task creation failure', () => {
  it('emits actionable EPERM + foreground fallback message', async () => {
    const fakeHome = await makeFakeHome();
    const noosphereHome = path.join(fakeHome, '.noosphere');
    const fakeBin = path.join(fakeHome, 'fake-bin');
    await mkdir(fakeBin, { recursive: true });

    // Shim simulates Bitdefender blocking the spawn before schtasks even
    // runs. POSIX `sh -c 'exit 1'` produces a non-zero exit status with no
    // stdout, which mirrors the Windows experience well enough for the
    // installer to take the EPERM-flavoured branch.
    const shim = `#!/bin/sh\nexit 1\n`;
    await writeFile(path.join(fakeBin, 'schtasks.exe'), shim, { mode: 0o755 });

    try {
      const result = await runInstaller('install', {
        HOME: fakeHome,
        NOOSPHERE_HOME: noosphereHome,
        NOOSPHERE_TEST_PLATFORM: 'win32',
        NOOSPHERE_SKIP_NPM: '1',
        NOOSPHERE_SKIP_CLAUDE_HOOK: '1',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      });
      assert.notEqual(
        result.code,
        0,
        'installer must fail when schtasks fails',
      );
      assert.match(result.stderr, /noosphere run-relayer/);
      assert.match(result.stderr, /noosphere run-manager/);
      assert.match(result.stderr, /schtasks\.exe \/Create/);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('Shell integration — block injection idempotency', () => {
  it('replaces the block on a second install without duplicating it', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '# line1\n' });
    const noosphereHome = path.join(fakeHome, '.noosphere');

    try {
      const env = {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'linux',
        XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
      };

      await runInstallerOk('install', env);
      await runInstallerOk('install', env);

      const zshrc = await readFile(path.join(fakeHome, '.zshrc'), 'utf8');
      const matches = [...zshrc.matchAll(/>>> noosphere >>>/g)];
      assert.equal(matches.length, 1, 'Block must appear exactly once after two installs');
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
