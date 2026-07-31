import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CredentialStore } from '../credentials.js';

function decodePsScript(args) {
  const idx = args.indexOf('-EncodedCommand');
  if (idx === -1) return '';
  return Buffer.from(args[idx + 1], 'base64').toString('utf16le');
}

// PowerShell 5.1 does not auto-load System.Security, so any script that
// references [System.Security.Cryptography.ProtectedData] MUST first run
// `Add-Type -AssemblyName System.Security` or the type lookup fails with
// "Unable to find type". This assertion guards that ordering everywhere
// we shell out to PowerShell from CredentialStore.
function assertAddTypeBeforeProtectedData(script, label) {
  const addTypeIdx = script.indexOf('Add-Type -AssemblyName System.Security');
  const protectedDataIdx = script.indexOf('ProtectedData');
  assert.notEqual(
    addTypeIdx,
    -1,
    `${label}: script must call Add-Type -AssemblyName System.Security`,
  );
  if (protectedDataIdx !== -1) {
    assert.ok(
      addTypeIdx < protectedDataIdx,
      `${label}: Add-Type must precede the first ProtectedData reference`,
    );
  }
}

// Builds a fake spawnSync that emulates Windows powershell.exe just enough
// to exercise the CredentialStore code paths on any host platform.
//
//   behavior: 'ok'        -> writes ciphertext atomically (tmp -> dpapi)
//   behavior: 'zero-byte' -> creates the dpapi file at 0 bytes and exits 0
//                            (reproduces the bug we are fixing)
//   behavior: 'throw'     -> exits non-zero with stderr (Access Denied, AV, ...)
function makeFakePowerShell({ behavior = 'ok' } = {}) {
  return function fakeSpawnSync(command, args, opts = {}) {
    if (!String(command).toLowerCase().includes('powershell')) {
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    const script = decodePsScript(args);
    const env = opts.env || {};
    const dpapiPath = env.NOOSPHERE_CREDENTIAL_PATH;
    const isWrite = Boolean(env.NOOSPHERE_CREDENTIAL_SECRET_B64);

    if (isWrite) {
      assert.ok(
        script.includes('$ErrorActionPreference = "Stop"'),
        'PowerShell write script must hard-fail on non-terminating errors',
      );
      assert.ok(
        script.includes('NOOSPHERE_CREDENTIAL_SECRET_B64'),
        'secret must travel via env var, not stdin',
      );
      assertAddTypeBeforeProtectedData(script, 'write');
      if (behavior === 'zero-byte') {
        fs.writeFileSync(dpapiPath, '');
        return { status: 0, stdout: '', stderr: '', error: null };
      }
      if (behavior === 'throw') {
        return {
          status: 1,
          stdout: '',
          stderr: 'Access is denied (simulated AV block)',
          error: null,
        };
      }
      const secretB64 = env.NOOSPHERE_CREDENTIAL_SECRET_B64;
      const tmp = env.NOOSPHERE_CREDENTIAL_TMP;
      const ciphertext = Buffer.from(`dpapi:${secretB64}`).toString('base64');
      fs.writeFileSync(tmp, ciphertext);
      fs.renameSync(tmp, dpapiPath);
      return { status: 0, stdout: '', stderr: '', error: null };
    }

    // Read path
    assertAddTypeBeforeProtectedData(script, 'read');
    if (!fs.existsSync(dpapiPath)) {
      return { status: 1, stdout: '', stderr: 'not found', error: null };
    }
    const ciphertext = fs.readFileSync(dpapiPath, 'utf8').trim();
    const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
    if (!decoded.startsWith('dpapi:')) {
      return { status: 1, stdout: '', stderr: 'invalid ciphertext', error: null };
    }
    const secret = Buffer.from(decoded.slice('dpapi:'.length), 'base64').toString('utf8');
    return { status: 0, stdout: secret, stderr: '', error: null };
  };
}

describe('Windows DPAPI CredentialStore', () => {
  let home;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'creds-win-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('writes and reads a credential round-trip on the happy path', () => {
    const store = new CredentialStore('default', {
      platform: 'win32',
      home,
      run: makeFakePowerShell({ behavior: 'ok' }),
    });

    const payload = JSON.stringify({
      MEMWAL_ACCOUNT_ID: '0xabc',
      MEMWAL_PRIVATE_KEY: 'priv',
      MEMWAL_NETWORK: 'mainnet',
    });

    const result = store.setPassword(payload);
    assert.equal(result.backend, 'windows-dpapi');
    assert.equal(result.encryptedAtRest, true);

    const dpapiPath = path.join(home, '.noosphere', 'credentials-default.json.dpapi');
    const tmpPath = `${dpapiPath}.tmp`;
    const stat = fs.statSync(dpapiPath);
    assert.ok(stat.size > 0, 'dpapi file must be non-empty after write');
    assert.equal(fs.existsSync(tmpPath), false, 'temp file must be moved, not left behind');

    const read = store.getPassword();
    assert.equal(read, payload, 'read-after-write must round-trip the exact payload');
  });

  it('throws and removes the 0-byte file when PowerShell silently writes nothing', () => {
    const store = new CredentialStore('default', {
      platform: 'win32',
      home,
      run: makeFakePowerShell({ behavior: 'zero-byte' }),
    });

    assert.throws(
      () => store.setPassword('{"MEMWAL_ACCOUNT_ID":"0xabc"}'),
      /0-byte file/,
      'setPassword must reject a 0-byte ciphertext file',
    );

    const dpapiPath = path.join(home, '.noosphere', 'credentials-default.json.dpapi');
    assert.equal(
      fs.existsSync(dpapiPath),
      false,
      'no 0-byte dpapi file may be left on disk after a failed write',
    );
  });

  it('surfaces the PowerShell stderr when the script exits non-zero', () => {
    const store = new CredentialStore('default', {
      platform: 'win32',
      home,
      run: makeFakePowerShell({ behavior: 'throw' }),
    });

    assert.throws(
      () => store.setPassword('{"MEMWAL_ACCOUNT_ID":"0xabc"}'),
      /Access is denied/,
    );

    const dpapiPath = path.join(home, '.noosphere', 'credentials-default.json.dpapi');
    assert.equal(fs.existsSync(dpapiPath), false);
    assert.equal(fs.existsSync(`${dpapiPath}.tmp`), false);
  });

  it('treats a pre-existing 0-byte dpapi file as absent and removes it on read', () => {
    const credentialsDir = path.join(home, '.noosphere');
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const dpapiPath = path.join(credentialsDir, 'credentials-default.json.dpapi');
    fs.writeFileSync(dpapiPath, '');

    const store = new CredentialStore('default', {
      platform: 'win32',
      home,
      run: makeFakePowerShell({ behavior: 'ok' }),
    });

    assert.equal(store.getPassword(), null);
    assert.equal(
      fs.existsSync(dpapiPath),
      false,
      'a stale 0-byte file must be cleaned up so the next write starts clean',
    );
  });

  it('round-trips after recovering from a previous 0-byte file', () => {
    const credentialsDir = path.join(home, '.noosphere');
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const dpapiPath = path.join(credentialsDir, 'credentials-default.json.dpapi');
    fs.writeFileSync(dpapiPath, '');

    const store = new CredentialStore('default', {
      platform: 'win32',
      home,
      run: makeFakePowerShell({ behavior: 'ok' }),
    });

    // Stale 0-byte file gets cleared on the first read.
    assert.equal(store.getPassword(), null);

    const payload = JSON.stringify({
      MEMWAL_ACCOUNT_ID: '0xabc',
      MEMWAL_PRIVATE_KEY: 'priv',
      MEMWAL_NETWORK: 'testnet',
    });
    store.setPassword(payload);
    assert.equal(store.getPassword(), payload);
  });

  it('emits Add-Type -AssemblyName System.Security before ProtectedData in both scripts', () => {
    const captured = [];
    const captureSpawn = (command, args, opts = {}) => {
      const isWrite = Boolean(opts.env?.NOOSPHERE_CREDENTIAL_SECRET_B64);
      captured.push({ kind: isWrite ? 'write' : 'read', script: decodePsScript(args) });
      // Defer the real fake so we get end-to-end behavior alongside capture.
      return makeFakePowerShell({ behavior: 'ok' })(command, args, opts);
    };

    const store = new CredentialStore('default', {
      platform: 'win32',
      home,
      run: captureSpawn,
    });

    store.setPassword('{"MEMWAL_ACCOUNT_ID":"0xabc"}');
    store.getPassword();

    const write = captured.find((entry) => entry.kind === 'write');
    const read = captured.find((entry) => entry.kind === 'read');
    assert.ok(write, 'write script must have been captured');
    assert.ok(read, 'read script must have been captured');

    for (const entry of [write, read]) {
      const addTypeIdx = entry.script.indexOf('Add-Type -AssemblyName System.Security');
      const protectedIdx = entry.script.indexOf('ProtectedData');
      assert.notEqual(
        addTypeIdx,
        -1,
        `${entry.kind}: missing Add-Type -AssemblyName System.Security (PowerShell 5.1 requires it for DPAPI)`,
      );
      assert.notEqual(
        protectedIdx,
        -1,
        `${entry.kind}: missing ProtectedData reference`,
      );
      assert.ok(
        addTypeIdx < protectedIdx,
        `${entry.kind}: Add-Type must appear before the first ProtectedData usage`,
      );
    }
  });
});

// `security add-generic-password -w` (no value) prompts twice: "password data
// for new item:" then "retype password for new item:". A single line on stdin
// hits EOF on the retype, so security reports "passwords don't match", stores
// nothing — and still exits 0, so no exit status revealed that the write had
// silently done nothing.
describe('macOS keychain credential store', () => {
  function fakeSecurity() {
    const entries = new Map();
    const calls = [];
    const run = (command, args, options = {}) => {
      calls.push({ command, args, input: options.input });
      const key = [
        args[args.indexOf('-a') + 1],
        args[args.indexOf('-s') + 1],
      ].join(' ');
      if (args[0] === 'add-generic-password') {
        const lines = String(options.input ?? '').split('\n');
        // Model the real prompt pair: the value persists only when the
        // confirmation line matches the first one. Note the exit code stays 0
        // either way, exactly as the real binary behaves.
        if (lines.length < 2 || lines[0] === '' || lines[0] !== lines[1]) {
          return { status: 0, stdout: '', stderr: 'passwords do not match\n' };
        }
        entries.set(key, lines[0]);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'find-generic-password') {
        if (!entries.has(key)) {
          return { status: 44, stdout: '', stderr: 'not found\n' };
        }
        return { status: 0, stdout: `${entries.get(key)}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${args[0]}\n` };
    };
    return { run, calls };
  }

  it('answers both prompts so the secret actually persists', () => {
    const security = fakeSecurity();
    const store = new CredentialStore('default', {
      platform: 'darwin',
      run: security.run,
    });
    const payload = JSON.stringify({
      MEMWAL_ACCOUNT_ID: '0xabc',
      MEMWAL_PRIVATE_KEY: 'suiprivkey1qexample',
      MEMWAL_NETWORK: 'mainnet',
    });

    const result = store.setPassword(payload);
    assert.equal(result.backend, 'macos-keychain');
    // The readback is the point: one line on stdin left this null while
    // setPassword had already reported success to its caller.
    assert.equal(store.getPassword(), payload);
  });

  it('keeps the secret out of argv, where any ps could read it', () => {
    const security = fakeSecurity();
    const store = new CredentialStore('default', {
      platform: 'darwin',
      run: security.run,
    });
    const payload = 'super-secret-delegate-key';
    store.setPassword(payload);

    const add = security.calls.find(
      (call) => call.args[0] === 'add-generic-password',
    );
    assert.ok(add, 'add-generic-password must have been invoked');
    assert.equal(
      add.args.some((argument) => argument.includes(payload)),
      false,
      'the secret must travel on stdin, never as a process argument',
    );
    assert.equal(add.input, `${payload}\n${payload}\n`);
  });
});
