import { randomUUID } from 'node:crypto';
import {
  chmod,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

import { CredentialStore } from '../lifecycle/credentials.js';
import {
  resolveWalrusConfig,
  validateOnChainAccount,
  WalrusMemoryAdapter,
} from '../../noosphere-relayer/walrus-memory.js';

export async function runSetupWizard({
  store = new CredentialStore('default'),
  validator = validateCredentials,
  smokeTest = runSmokeTest,
} = {}) {
  console.log('--- Noosphere Setup ---');

  const accountId =
    readFlag('--account-id') ||
    await prompt('Walrus Memory account ID: ');
  const network =
    (readFlag('--network') ||
      await prompt('Network [mainnet/testnet] (mainnet): ') ||
      'mainnet').toLowerCase();
  const privateKey = await readPrivateKey();
  const credentials = normalizeCredentials({
    MEMWAL_ACCOUNT_ID: accountId,
    MEMWAL_PRIVATE_KEY: privateKey,
    MEMWAL_NETWORK: network,
  });

  console.log(`Validating account and delegate on Sui ${network}...`);
  await validator(credentials);

  const storage = store.setPassword(JSON.stringify(credentials));
  const verified = store.getPassword();
  if (verified !== JSON.stringify(credentials)) {
    throw new Error('Credential verification failed after secure storage');
  }

  console.log(`Credentials stored using ${storage.backend}.`);
  if (!storage.encryptedAtRest) {
    console.warn(
      `Warning: native keychain unavailable. Credentials are stored in an ` +
      `owner-only 0600 file at ${store.fallbackPath}.`,
    );
  }

  if (await shouldRunSmokeTest()) {
    await smokeTest(credentials);
    console.log('Store/recall smoke test passed.');
  }
  console.log('Setup complete. Restart Noosphere services to use new credentials.');
}

export async function runCredentialsCommand(
  subcommand,
  { store = new CredentialStore('default') } = {},
) {
  switch (subcommand) {
    case 'status': {
      const status = store.status();
      if (!status.present) {
        console.log(`No credentials found (${status.backend}).`);
        return;
      }
      if (status.invalid) {
        throw new Error('Stored credential payload is invalid');
      }
      console.log(
        `Credentials present for ${status.account_id} on ${status.network} ` +
        `(${status.backend}).`,
      );
      return;
    }
    case 'migrate':
      await migrateEnvironmentFile(store);
      return;
    case 'rotate':
      await runSetupWizard({ store });
      return;
    default:
      console.log('Usage: noosphere credentials [status|migrate|rotate]');
  }
}

export async function migrateEnvironmentFile(
  store,
  {
    envPath = null,
    validator = validateCredentials,
  } = {},
) {
  envPath = envPath || readFlag('--env') || await findEnvironmentFile();
  if (!envPath) {
    throw new Error('No Noosphere .env file was found');
  }

  const content = await readFile(envPath, 'utf8');
  const parsed = parseEnvironment(content);
  const credentials = normalizeCredentials(parsed);

  console.log(
    `Validating ${credentials.MEMWAL_ACCOUNT_ID} before migration...`,
  );
  await validator(credentials);

  const backupPath = `${envPath}.${randomUUID()}.migration-backup`;
  const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
  await writeFile(backupPath, content, { mode: 0o600 });
  await chmod(backupPath, 0o600);

  try {
    store.setPassword(JSON.stringify(credentials));
    if (store.getPassword() !== JSON.stringify(credentials)) {
      throw new Error('Secure-store readback did not match');
    }

    const scrubbed = content
      .split(/\r?\n/)
      .filter((line) => !/^\s*MEMWAL_(PRIVATE_KEY|ACCOUNT_ID|NETWORK)\s*=/.test(line))
      .join('\n')
      .replace(/\n*$/, '\n');
    await writeFile(
      temporaryPath,
      `${scrubbed}# Walrus credentials are stored in the OS credential store.\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, envPath);
    await chmod(envPath, 0o600);
    console.log(`Migrated credentials from ${envPath}.`);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    await unlink(backupPath).catch(() => undefined);
  }
}

export async function validateCredentials(credentials) {
  const config = resolveWalrusConfig(credentials);
  if (!config.configured) {
    throw new Error('Account ID and delegate private key are required');
  }
  return validateOnChainAccount(config);
}

async function runSmokeTest(credentials) {
  const adapter = new WalrusMemoryAdapter(credentials);
  const marker = `Noosphere setup verification ${randomUUID()}`;
  const namespace = `noosphere-setup-${Date.now()}`;
  await adapter.remember(marker, namespace);
  const recalled = await adapter.recall(marker, 5, namespace);
  if (!recalled.results?.some((result) => result.text?.includes(marker))) {
    throw new Error('Smoke-test memory was stored but not recalled');
  }
}

async function readPrivateKey() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return promptHidden('Delegate private key: ');
}

async function shouldRunSmokeTest() {
  if (process.argv.includes('--smoke-test')) return true;
  if (process.argv.includes('--no-smoke-test') || !process.stdin.isTTY) {
    return false;
  }
  const answer = await prompt(
    'Run a real Walrus store/recall smoke test now? [y/N]: ',
  );
  return answer.toLowerCase() === 'y';
}

function normalizeCredentials(values) {
  return {
    MEMWAL_ACCOUNT_ID: String(values.MEMWAL_ACCOUNT_ID || '').trim(),
    MEMWAL_PRIVATE_KEY: String(values.MEMWAL_PRIVATE_KEY || '')
      .trim()
      .replace(/^0x/, ''),
    MEMWAL_NETWORK: String(values.MEMWAL_NETWORK || 'mainnet')
      .trim()
      .toLowerCase(),
  };
}

function parseEnvironment(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function findEnvironmentFile() {
  const candidates = [
    path.join(
      process.env.NOOSPHERE_HOME || path.join(os.homedir(), '.noosphere'),
      'app',
      'noosphere-relayer',
      '.env',
    ),
    path.resolve('noosphere-relayer', '.env'),
    path.resolve('.env'),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Continue to the next conventional location.
    }
  }
  return null;
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function prompt(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

async function promptHidden(query) {
  process.stdout.write(query);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });
  try {
    const answer = await rl.question('');
    process.stdout.write('\n');
    return answer.trim();
  } finally {
    rl.close();
  }
}
