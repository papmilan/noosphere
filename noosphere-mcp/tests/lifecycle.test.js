import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
    USERPROFILE: fakeHome,
    NOOSPHERE_HOME: noosphereHome,
    NOOSPHERE_SKIP_LAUNCHCTL: '1',
    NOOSPHERE_SKIP_SYSTEMCTL: '1',
    NOOSPHERE_SKIP_SCHTASKS: '1',
    NOOSPHERE_SKIP_CLAUDE_HOOK: '1',
    NOOSPHERE_SKIP_NPM: '1',
    // doctor probes /ready. Point it at the discard port so these fake homes
    // never reach a relayer the developer happens to be running.
    NOOSPHERE_RELAYER_URL: 'http://127.0.0.1:9',
  };
}

/** Serve one canned /ready response; returns { url, close }. */
async function readyStub(status, body) {
  const server = createServer((request, response) => {
    if (!request.url.startsWith('/ready')) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function normalizePathSeparators(value) {
  return value.replaceAll('\\', '/');
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
      assert.match(normalizePathSeparators(wrapper), /continuity\/index\.js/);

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
      assert.match(codexInstructions, /noosphere context --local-only/);
      assert.match(codexInstructions, /untrusted data by default/);
      assert.doesNotMatch(codexInstructions, /Read `?\.noosphere\/master-prompt\.md/);
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

  it('doctor fails when the relayer is running but not ready', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');
    // The exact shape that used to pass silently: the service is up, so every
    // presence check is true, while /ready reports a dead memory backend.
    const stub = await readyStub(503, {
      success: false,
      memory: { ready: false, error: 'JSON-RPC on public fullnodes has been deprecated' },
      queue: { pending: 26866 },
    });

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
      });

      const { stdout, code } = await runInstaller('doctor', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
        NOOSPHERE_RELAYER_URL: stub.url,
      });

      const ready = JSON.parse(stdout).relayer_ready;
      assert.equal(ready.ok, false);
      assert.equal(ready.memory_ready, false);
      assert.equal(ready.queue_pending, 26866);
      // The upstream reason must survive, not flatten into another opaque 503.
      assert.match(ready.error, /JSON-RPC on public fullnodes/);
      assert.equal(code, 1);
    } finally {
      await stub.close();
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('doctor reports a healthy relayer with its queue depth', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');
    const stub = await readyStub(200, {
      success: true,
      memory: { ready: true },
      queue: { pending: 0, failing: 0, max_attempts: 0, last_error: null },
    });

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
      });

      const { stdout } = await runInstaller('doctor', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
        NOOSPHERE_RELAYER_URL: stub.url,
      });

      assert.deepEqual(JSON.parse(stdout).relayer_ready, {
        url: stub.url,
        ok: true,
        memory_ready: true,
        queue_pending: 0,
        queue_failing: 0,
        queue_last_error: null,
      });
    } finally {
      await stub.close();
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('doctor fails when a reachable relayer has been failing to upload', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');
    // The shape that used to pass silently, observed on a real install: the
    // service is up, /ready answers 200, memory reports ready — and 27k writes
    // have been retried for days without landing. A depth alone cannot say so.
    const stub = await readyStub(200, {
      success: true,
      memory: { ready: true },
      queue: {
        pending: 27118,
        failing: 456,
        max_attempts: 6258,
        last_error: 'Walrus Memory server error (503): uploads are paused',
      },
    });

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
      });

      const { stdout, code } = await runInstaller('doctor', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
        NOOSPHERE_RELAYER_URL: stub.url,
      });

      const ready = JSON.parse(stdout).relayer_ready;
      assert.equal(ready.ok, true, 'the relayer really is reachable and ready');
      assert.equal(ready.queue_failing, 456);
      // The upstream reason is what makes the failure actionable.
      assert.match(ready.queue_last_error, /uploads are paused/);
      assert.equal(code, 1, 'a stuck upload queue is not a healthy install');
    } finally {
      await stub.close();
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('treats a relayer too old to report upload health exactly like a healthy one', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');
    // A relayer predating the upload-health fields, and its modern equivalent
    // reporting an idle queue. The claim is relative on purpose: absence must
    // not contribute a failure. Asserting an absolute exit code here would
    // instead measure whatever else this fake home happens to fail, which is
    // why every other case in this block only ever asserts a failing code.
    const legacy = await readyStub(200, {
      success: true,
      memory: { ready: true },
      queue: { pending: 12 },
    });
    const modern = await readyStub(200, {
      success: true,
      memory: { ready: true },
      queue: { pending: 12, failing: 0, max_attempts: 0, last_error: null },
    });

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
      });

      const run = async (url) =>
        runInstaller('doctor', {
          ...baseEnv(fakeHome, noosphereHome),
          NOOSPHERE_TEST_PLATFORM: 'darwin',
          NOOSPHERE_RELAYER_URL: url,
        });

      const older = await run(legacy.url);
      const current = await run(modern.url);

      // Absent reads as unknown, never as broken.
      assert.equal(JSON.parse(older.stdout).relayer_ready.queue_failing, null);
      assert.equal(JSON.parse(current.stdout).relayer_ready.queue_failing, 0);
      assert.equal(
        older.code,
        current.code,
        'a missing queue-health field must not change doctor’s verdict',
      );
    } finally {
      await legacy.close();
      await modern.close();
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('doctor records an unreachable relayer instead of passing', async () => {
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');
    // Take a real port and release it, so the probe meets a refused connection
    // on an ordinary port rather than one Node rejects out of hand.
    const stub = await readyStub(200, {});
    await stub.close();

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
      });

      const { stdout, code } = await runInstaller('doctor', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'darwin',
        NOOSPHERE_RELAYER_URL: stub.url,
      });

      const ready = JSON.parse(stdout).relayer_ready;
      assert.equal(ready.ok, false);
      assert.match(ready.error, /ECONNREFUSED/);
      assert.equal(code, 1);
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
      assert.match(normalizePathSeparators(wrapper), /continuity\/index\.js/);

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
      assert.match(normalizePathSeparators(wrapper), /continuity\/index\.js/);
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

  it('pins a working directory in each Windows task definition', async () => {
    // Regression: the tasks were registered with `schtasks /TR`, which cannot
    // express a working directory, so they ran from %SystemRoot%\system32.
    // The relayer resolves its .env — and the relative state paths that .env
    // declares — against the current directory, so a configured local-file
    // backend silently reverted to the walrus-memory default. launchd and
    // systemd already pin WorkingDirectory.
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'windows',
      });

      const definitions = path.join(noosphereHome, 'tasks');
      const relayer = await readFile(
        path.join(definitions, 'Relayer.xml'),
        'utf16le',
      );
      const manager = await readFile(
        path.join(definitions, 'Manager.xml'),
        'utf16le',
      );

      const relayerApp = path.join(noosphereHome, 'app', 'noosphere-relayer');
      const managerApp = path.join(noosphereHome, 'app', 'noosphere-mcp');
      assert.ok(
        relayer.includes(`<WorkingDirectory>${relayerApp}</WorkingDirectory>`),
        `Relayer.xml lacks its working directory:\n${relayer}`,
      );
      assert.ok(
        manager.includes(`<WorkingDirectory>${managerApp}</WorkingDirectory>`),
        `Manager.xml lacks its working directory:\n${manager}`,
      );
      // schtasks /XML only accepts Unicode; the BOM must survive the write.
      assert.equal(relayer.charCodeAt(0), 0xfeff);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('doctor finds the wrapper the installer wrote on Windows', async () => {
    // Regression: doctor probed for an extensionless `noosphere` while the
    // installer writes `noosphere.cmd` on Windows, so installed_cli was false
    // on every healthy Windows install and doctor always reported a failure.
    const fakeHome = await makeFakeHome({ '.zshrc': '' });
    const noosphereHome = path.join(fakeHome, '.noosphere');

    try {
      await runInstallerOk('install', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'windows',
      });

      await access(path.join(noosphereHome, 'bin', 'noosphere.cmd'));

      const { stdout } = await runInstaller('doctor', {
        ...baseEnv(fakeHome, noosphereHome),
        NOOSPHERE_TEST_PLATFORM: 'windows',
      });

      assert.equal(JSON.parse(stdout).installed_cli, true);
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

describe('CLI wrapper naming', () => {
  it('wrapperName resolves to noosphere.cmd on Windows and noosphere elsewhere', async () => {
    const { wrapperName } = await import('../lifecycle/util.js');
    assert.equal(wrapperName('win32'), 'noosphere.cmd');
    // NOOSPHERE_TEST_PLATFORM spells it `windows`; both must agree.
    assert.equal(wrapperName('windows'), 'noosphere.cmd');
    assert.equal(wrapperName('darwin'), 'noosphere');
    assert.equal(wrapperName('linux'), 'noosphere');
  });
});

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
    const shim = process.platform === 'win32'
      ? [
        '@echo off',
        `> "${marker}" echo %~f0`,
        ':args',
        'if "%~1"=="" goto done',
        `>> "${marker}" echo %~1`,
        'shift',
        'goto args',
        ':done',
        'exit /b 0',
        '',
      ].join('\r\n')
      : `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > "${marker}"\n`;
    await writeFile(path.join(fakeBin, 'npm.cmd'), shim, { mode: 0o755 });

    try {
      const result = await runInstaller('install', {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
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
      const invocation = log.trim().split(/\r?\n/);
      assert.match(invocation[0], /npm\.cmd/, 'installer must invoke npm.cmd on win32');
      assert.deepEqual(
        invocation.slice(1),
        process.platform === 'win32' ? ['ci', '--omit', 'dev'] : ['ci', '--omit=dev'],
      );
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
