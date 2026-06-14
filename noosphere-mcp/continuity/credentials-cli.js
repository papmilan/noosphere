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
  promptUser = prompt,
  privateKeyReader = readPrivateKey,
  smokeTestDecision = shouldRunSmokeTest,
  args = process.argv,
} = {}) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║              Noosphere — First-Time Setup                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Noosphere stores your project memory in Walrus Memory,');
  console.log('a decentralized storage network built on Sui blockchain.');
  console.log('');
  console.log('You need two things:');
  console.log('  1. A Walrus Memory account ID   (starts with 0x)');
  console.log('  2. A delegate private key       (64 hexadecimal characters)');
  console.log('');

  const hasAccount =
    readFlag('--account-id', args) ||
    args.includes('--yes') ||
    (await promptUser(
      'Do you already have a Walrus Memory account? [y/N]: ',
    )).toLowerCase() === 'y';

  if (!hasAccount) {
    console.log('');
    console.log('────────────────────────────────────────────────────────────');
    console.log('  How to create a Walrus Memory account (5–10 min)');
    console.log('────────────────────────────────────────────────────────────');
    console.log('');
    console.log('  Step 1 — Get a Sui wallet');
    console.log('    Browser extension: https://slush.app  or  https://suiwallet.com');
    console.log('    CLI:  curl https://install.mystenlabs.com/sui | sh');
    console.log('');
    console.log('  Step 2 — Fund it with SUI (for gas fees, ~0.1 SUI is plenty)');
    console.log('    Mainnet: buy SUI on any exchange (Binance, Coinbase, Kraken…)');
    console.log('    Testnet: run  sui client faucet  (free test tokens)');
    console.log('');
    console.log('  Step 3 — Create your Walrus Memory account');
    console.log('    Docs: https://docs.wal.app/walrus-memory/getting-started/');
    console.log('    The docs walk you through creating the account object on Sui');
    console.log('    and generating + registering your delegate keypair.');
    console.log('');
    console.log('  Step 4 — Come back here with:');
    console.log('    • Your account object ID  (0x followed by 64 hex characters)');
    console.log('    • Your delegate private key  (64 hexadecimal characters)');
    console.log('');
    console.log('────────────────────────────────────────────────────────────');
    console.log('');
    await promptUser(
      'Press Enter when you have your account ID and delegate key…',
    );
    console.log('');
  }

  const accountId =
    readFlag('--account-id', args) ||
    await promptUser('Walrus Memory account ID (0x…): ');

  if (!/^0x[0-9a-fA-F]{64}$/.test(accountId.trim())) {
    console.warn('');
    console.warn('  Note: account ID should be 0x followed by 64 hex characters.');
    console.warn('  Continuing anyway — validation will catch any errors.');
    console.warn('');
  }

  const network =
    (readFlag('--network', args) ||
      await promptUser('Network [mainnet/testnet] (mainnet): ') ||
      'mainnet').toLowerCase();

  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`Unknown network "${network}". Use mainnet or testnet.`);
  }

  console.log('');
  console.log('Enter your 64-character hexadecimal delegate private key');
  console.log('(a leading 0x is accepted; input is hidden):');
  const privateKey = await privateKeyReader();
  const credentials = normalizeCredentials({
    MEMWAL_ACCOUNT_ID: accountId,
    MEMWAL_PRIVATE_KEY: privateKey,
    MEMWAL_NETWORK: network,
  });

  console.log('');
  console.log(`Validating account and delegate on Sui ${network}…`);
  try {
    await validator(credentials);
    console.log('  ✓ Account exists on-chain');
    console.log('  ✓ Delegate key is registered');
  } catch (error) {
    const message = String(error.message || error);
    const normalizedMessage = message.toLowerCase();
    console.error('');
    console.error('  Validation failed:', message);
    console.error('');
    if (
      normalizedMessage.includes('not found') ||
      normalizedMessage.includes('does not exist')
    ) {
      console.error('  The account ID was not found on', network + '.');
      if (network === 'mainnet') {
        console.error('  If your account is on testnet, re-run with: noosphere setup --network testnet');
      } else {
        console.error('  If your account is on mainnet, re-run with: noosphere setup --network mainnet');
      }
    } else if (
      normalizedMessage.includes('delegate') ||
      normalizedMessage.includes('key')
    ) {
      console.error('  The delegate key does not match the registered delegate for this account.');
      console.error('  Check that you copied the correct private key from your Walrus Memory setup.');
    }
    throw error;
  }

  const storage = store.setPassword(JSON.stringify(credentials));
  const verified = store.getPassword();
  if (verified !== JSON.stringify(credentials)) {
    throw new Error('Credential verification failed after secure storage');
  }

  console.log(`  ✓ Credentials stored (${storage.backend})`);
  if (!storage.encryptedAtRest) {
    console.warn('');
    console.warn('  Warning: native keychain unavailable.');
    console.warn(`  Credentials stored in owner-only 0600 file: ${store.fallbackPath}`);
  }

  if (await smokeTestDecision(args, promptUser)) {
    console.log('');
    console.log('Running live Walrus store/recall test…');
    await smokeTest(credentials);
    console.log('  ✓ Store/recall smoke test passed');
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Setup complete!                                         ║');
  console.log('║                                                          ║');
  console.log('║  Run  noosphere doctor       to verify your install      ║');
  console.log('║  Run  noosphere credentials status  to check any time   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Restart Noosphere services to use the new credentials:');
  console.log('  macOS:   launchctl kickstart -k gui/$UID/xyz.noosphere.relayer');
  console.log('  Linux:   systemctl --user restart xyz.noosphere.relayer');
  console.log('  Windows: schtasks /End /TN "\\Noosphere\\Relayer" && schtasks /Run /TN "\\Noosphere\\Relayer"');
  console.log('');
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

async function shouldRunSmokeTest(args = process.argv, promptUser = prompt) {
  if (args.includes('--smoke-test')) return true;
  if (args.includes('--no-smoke-test') || !process.stdin.isTTY) {
    return false;
  }
  const answer = await promptUser(
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

function readFlag(name, args = process.argv) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
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
