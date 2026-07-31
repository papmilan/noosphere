import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  migrateEnvironmentFile,
  runSetupWizard,
} from '../continuity/credentials-cli.js';
import {
  CredentialStore,
  loadCredentialsIntoEnv,
} from '../lifecycle/credentials.js';

describe('credential storage', () => {
  let temporaryRoot;

  before(async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-credentials-'),
    );
  });

  after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('passes macOS secrets through stdin rather than command arguments', () => {
    const calls = [];
    const store = new CredentialStore('default', {
      platform: 'darwin',
      home: temporaryRoot,
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const secret = '{"MEMWAL_PRIVATE_KEY":"value with \\"quotes\\"; $(bad)"}';

    store.setPassword(secret);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/usr/bin/security');
    assert.equal(calls[0].args.includes(secret), false);
    // `security add-generic-password -w` prompts twice — for the value and for
    // its confirmation — so the secret is written once per prompt. A single
    // line leaves the confirmation at EOF, and security then stores nothing
    // while still exiting 0.
    assert.equal(calls[0].options.input, `${secret}\n${secret}\n`);
  });

  it('uses an owner-only file when no native keychain exists', async () => {
    const store = new CredentialStore('default', {
      platform: 'unsupported',
      home: temporaryRoot,
      run: () => ({ status: 1, stdout: '', stderr: '' }),
    });
    const payload = JSON.stringify({ test: true });

    const result = store.setPassword(payload);

    assert.equal(result.encryptedAtRest, false);
    assert.equal(store.getPassword(), payload);
    const file = await readFile(store.fallbackPath, 'utf8');
    assert.equal(file, payload);
  });

  it('falls back safely when Linux Secret Service is unavailable', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'noosphere-linux-creds-'));
    try {
      const store = new CredentialStore('test', {
        platform: 'linux',
        home,
        run: (_command, args) => ({
          status: args.includes('--version') ? 0 : 1,
          stdout: '',
          stderr: 'Secret Service is unavailable',
        }),
      });

      const result = store.setPassword('fallback-secret');
      assert.equal(result.backend, 'owner-only-file');
      assert.equal(store.getPassword(), 'fallback-secret');
      assert.equal(store.backendName(), 'owner-only-file');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('ignores a corrupt secure-store entry so environment fallback can load', () => {
    const env = { MEMWAL_ACCOUNT_ID: 'from-env' };
    const result = loadCredentialsIntoEnv({
      env,
      store: {
        getPassword: () => '{invalid',
        backendName: () => 'test-store',
      },
    });

    assert.equal(result.loaded, false);
    assert.equal(result.invalid, true);
    assert.equal(env.MEMWAL_ACCOUNT_ID, 'from-env');
  });

  it('migrates only the delegate key and leaves the identifiers in place', async () => {
    const envPath = path.join(temporaryRoot, '.env');
    const store = new CredentialStore('migration', {
      platform: 'unsupported',
      home: temporaryRoot,
      run: () => ({ status: 1, stdout: '', stderr: '' }),
    });
    await writeFile(
      envPath,
      [
        'PORT=3001',
        `MEMWAL_PRIVATE_KEY=${'a'.repeat(64)}`,
        `MEMWAL_ACCOUNT_ID=0x${'b'.repeat(64)}`,
        'MEMWAL_NETWORK=testnet',
        'NOOSPHERE_API_TOKEN=keep-this-setting',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    await migrateEnvironmentFile(store, {
      envPath,
      validator: async () => ({ valid: true }),
    });

    const scrubbed = await readFile(envPath, 'utf8');
    assert.match(scrubbed, /PORT=3001/);
    assert.match(scrubbed, /NOOSPHERE_API_TOKEN=keep-this-setting/);
    // The secret is the only thing that moves.
    assert.doesNotMatch(scrubbed, /MEMWAL_PRIVATE_KEY/);
    // The account id and network are identifiers, not secrets, and stay put:
    // the store keeps only the key, which is what holds the payload under the
    // 128-byte ceiling of the macOS secure prompt.
    assert.match(scrubbed, /MEMWAL_ACCOUNT_ID=0x/);
    assert.match(scrubbed, /MEMWAL_NETWORK=testnet/);

    const stored = JSON.parse(store.getPassword());
    assert.deepEqual(stored, { MEMWAL_PRIVATE_KEY: 'a'.repeat(64) });
    assert.ok(
      store.getPassword().length < 128,
      'the stored payload must fit the macOS secure prompt',
    );
  });

  it('runs setup noninteractively with a validated hexadecimal key', async () => {
    let storedPayload = null;
    let validatedCredentials = null;
    let smokeTestCalled = false;
    const envPath = path.join(temporaryRoot, 'walrus.env');
    const output = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...values) => output.push(values.join(' '));
    console.warn = (...values) => output.push(values.join(' '));
    console.error = (...values) => output.push(values.join(' '));

    try {
      await writeFile(envPath, 'PORT=3001\nDEMO_MODE=true\n', {
        mode: 0o600,
      });
      await runSetupWizard({
        args: [
          'node',
          'noosphere',
          '--account-id',
          `0x${'b'.repeat(64)}`,
          '--network',
          'testnet',
          '--no-smoke-test',
        ],
        relayerEnvPath: envPath,
        store: {
          fallbackPath: '/unused',
          setPassword(payload) {
            storedPayload = payload;
            return { backend: 'test-keychain', encryptedAtRest: true };
          },
          getPassword() {
            return storedPayload;
          },
        },
        promptUser: async () => {
          assert.fail('Flag-driven setup must not prompt for account details');
        },
        privateKeyReader: async () => `0x${'a'.repeat(64)}`,
        validator: async (credentials) => {
          validatedCredentials = credentials;
          return { valid: true };
        },
        smokeTest: async () => {
          smokeTestCalled = true;
        },
        smokeTestDecision: async () => false,
      });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }

    assert.deepEqual(validatedCredentials, {
      MEMWAL_ACCOUNT_ID: `0x${'b'.repeat(64)}`,
      MEMWAL_PRIVATE_KEY: 'a'.repeat(64),
      MEMWAL_NETWORK: 'testnet',
    });
    assert.deepEqual(JSON.parse(storedPayload), validatedCredentials);
    assert.equal(smokeTestCalled, false);
    const envContents = await readFile(envPath, 'utf8');
    assert.match(envContents, /^NOOSPHERE_MEMORY_BACKEND=walrus-memory$/m);
    assert.match(envContents, /^DEMO_MODE=false$/m);
    assert.ok(output.some((line) => line.includes('Setup complete')));
  });

  it('--local enables local-file memory without touching credentials', async () => {
    const envPath = path.join(temporaryRoot, 'local.env');
    await writeFile(
      envPath,
      [
        'PORT=3001',
        'DEMO_MODE=true',
        'MEMWAL_NETWORK=mainnet',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runSetupWizard({
        args: ['node', 'noosphere', '--local'],
        relayerEnvPath: envPath,
        store: {
          setPassword() {
            assert.fail('Local file mode must not store credentials');
          },
        },
        promptUser: async () => {
          assert.fail('Local file mode must not prompt the user');
        },
        privateKeyReader: async () => {
          assert.fail('Local file mode must not read a private key');
        },
        validator: async () => {
          assert.fail('Local file mode must not validate credentials');
        },
      });
    } finally {
      console.log = originalLog;
    }
    const contents = await readFile(envPath, 'utf8');
    assert.match(contents, /^NOOSPHERE_MEMORY_BACKEND=local-file$/m);
    assert.match(contents, /^DEMO_MODE=false$/m);
    assert.match(contents, /PORT=3001/);
    assert.match(contents, /MEMWAL_NETWORK=mainnet/);
  });

  it('--demo aliases local-file memory without touching credentials', async () => {
    const envPath = path.join(temporaryRoot, 'demo.env');
    await writeFile(
      envPath,
      [
        'PORT=3001',
        'DEMO_MODE=false',
        'MEMWAL_NETWORK=mainnet',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runSetupWizard({
        args: ['node', 'noosphere', '--demo'],
        relayerEnvPath: envPath,
        promptUser: async () => {
          assert.fail('Demo mode must not prompt the user');
        },
        privateKeyReader: async () => {
          assert.fail('Demo mode must not read a private key');
        },
        validator: async () => {
          assert.fail('Demo mode must not validate credentials');
        },
      });
    } finally {
      console.log = originalLog;
    }
    const contents = await readFile(envPath, 'utf8');
    assert.match(contents, /^NOOSPHERE_MEMORY_BACKEND=local-file$/m);
    assert.match(contents, /^DEMO_MODE=false$/m);
    assert.match(contents, /PORT=3001/);
    assert.match(contents, /MEMWAL_NETWORK=mainnet/);
  });

  it('--demo reports an actionable error when the relayer env is missing', async () => {
    await assert.rejects(
      runSetupWizard({
        args: ['node', 'noosphere', '--demo'],
        relayerEnvPath: path.join(temporaryRoot, 'does-not-exist.env'),
      }),
      /install:user/,
    );
  });

  it('rejects an unsupported network before reading the private key', async () => {
    let privateKeyRead = false;
    await assert.rejects(
      runSetupWizard({
        args: [
          'node',
          'noosphere',
          '--account-id',
          `0x${'b'.repeat(64)}`,
          '--network',
          'devnet',
        ],
        promptUser: async () => {
          assert.fail('Flag-driven setup must not prompt for account details');
        },
        privateKeyReader: async () => {
          privateKeyRead = true;
          return 'a'.repeat(64);
        },
      }),
      /Unknown network "devnet"/,
    );
    assert.equal(privateKeyRead, false);
  });
});
