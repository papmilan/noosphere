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
import { pathToFileURL } from 'node:url';

import { CredentialStore } from '../lifecycle/credentials.js';
import { noosphereHome } from '../lifecycle/registry.js';
import { resolveRelayerPath } from '../lifecycle/relayer-source.js';

const relayerPath = resolveRelayerPath();
const {
  resolveWalrusConfig,
  validateOnChainAccount,
  WalrusMemoryAdapter,
} = await import(
  pathToFileURL(path.join(relayerPath, 'walrus-memory.js')).href
);

export async function runSetupWizard({
  store = new CredentialStore('default'),
  validator = validateCredentials,
  smokeTest = runSmokeTest,
  promptUser = prompt,
  privateKeyReader = readPrivateKey,
  smokeTestDecision = shouldRunSmokeTest,
  args = process.argv,
  relayerEnvPath = defaultRelayerEnvPath(),
} = {}) {
  printBlock([
    '',
    '╔══════════════════════════════════════════════════════════╗',
    '║              Noosphere — First-Time Setup                ║',
    '╚══════════════════════════════════════════════════════════╝',
    '',
    'Noosphere can store your project memory locally or in Walrus Memory.',
    'Local file mode stays on this machine; Walrus syncs shared memory',
    'through the official Walrus Memory network built on Sui.',
    '',
  ]);

  const selectedBackend = await chooseSetupBackend(args, promptUser);
  if (selectedBackend === 'local-file') {
    await enableLocalFileMode(relayerEnvPath);
    return;
  }

  printBlock([
    '',
    'Walrus Memory setup needs two things:',
    '  1. A Walrus Memory account ID   (starts with 0x)',
    '  2. A delegate private key       (64 hexadecimal characters)',
    '',
    'Prefer local-only memory? Re-run with --local.',
    '',
  ]);

  const hasAccount =
    readFlag('--account-id', args) ||
    args.includes('--yes') ||
    (await promptUser(
      'Do you already have a Walrus Memory account? [y/N]: ',
    )).toLowerCase() === 'y';

  if (!hasAccount) {
    printWalrusAccountOptions();
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

  const backendWritten = await setMemoryBackendMode(
    relayerEnvPath,
    'walrus-memory',
    { requireExisting: false },
  );
  if (backendWritten) {
    console.log(`  ✓ Wrote NOOSPHERE_MEMORY_BACKEND=walrus-memory to ${relayerEnvPath}`);
  } else {
    console.warn('');
    console.warn(
      `  Warning: relayer .env not found at ${relayerEnvPath}; ` +
      'credentials were stored, but backend selection was not persisted.',
    );
  }

  printBlock([
    '',
    '╔══════════════════════════════════════════════════════════╗',
    '║  Setup complete!                                         ║',
    '║                                                          ║',
    '║  Run  noosphere doctor       to verify your install      ║',
    '║  Run  noosphere credentials status  to check any time   ║',
    '╚══════════════════════════════════════════════════════════╝',
    '',
    'Restart Noosphere services to use the new credentials:',
    '  macOS:   launchctl kickstart -k gui/$UID/xyz.noosphere.relayer',
    '  Linux:   systemctl --user restart xyz.noosphere.relayer',
    '  Windows: schtasks /End /TN "\\Noosphere\\Relayer" && schtasks /Run /TN "\\Noosphere\\Relayer"',
    '',
  ]);
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

async function chooseSetupBackend(args, promptUser) {
  const flagged = readSetupBackendFlag(args);
  if (flagged) return flagged;
  if (
    readFlag('--account-id', args) ||
    readFlag('--network', args) ||
    args.includes('--yes')
  ) {
    return 'walrus-memory';
  }

  const answer = (await promptUser(
    'Storage backend [local/walrus] (local): ',
  )).toLowerCase();
  return normalizeSetupBackend(answer || 'local');
}

function readSetupBackendFlag(args) {
  if (
    args.includes('--local') ||
    args.includes('--local-file') ||
    args.includes('--demo')
  ) {
    return 'local-file';
  }
  if (args.includes('--walrus')) return 'walrus-memory';
  const backend = readFlag('--memory-backend', args);
  return backend ? normalizeSetupBackend(backend) : null;
}

function normalizeSetupBackend(value) {
  switch (String(value || '').trim().toLowerCase()) {
    case 'local':
    case 'local-file':
    case 'file':
      return 'local-file';
    case 'walrus':
    case 'walrus-memory':
      return 'walrus-memory';
    default:
      throw new Error(
        `Unknown memory backend "${value}". Use local or walrus.`,
      );
  }
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

function defaultRelayerEnvPath() {
  return path.join(noosphereHome(), 'app', 'noosphere-relayer', '.env');
}

async function enableLocalFileMode(envPath) {
  await setMemoryBackendMode(envPath, 'local-file', { requireExisting: true });

  printBlock([
    '',
    '╔══════════════════════════════════════════════════════════╗',
    '║  Local file memory enabled                              ║',
    '╚══════════════════════════════════════════════════════════╝',
    '',
    'Noosphere will store memory in a local file only.',
    'No Walrus, no Sui, nothing leaves this machine.',
    '',
    `Wrote NOOSPHERE_MEMORY_BACKEND=local-file to ${envPath}.`,
    '',
    'Restart the relayer to apply:',
    '  macOS:   launchctl kickstart -k gui/$UID/xyz.noosphere.relayer',
    '  Linux:   systemctl --user restart xyz.noosphere.relayer',
    '  Windows: schtasks /End /TN "\\Noosphere\\Relayer" && schtasks /Run /TN "\\Noosphere\\Relayer"',
    '',
    'To switch back to Walrus, re-run `noosphere setup --walrus`.',
    '',
  ]);
}

async function setMemoryBackendMode(
  envPath,
  backend,
  { requireExisting = false } = {},
) {
  let contents;
  try {
    contents = await readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && requireExisting) {
      throw new Error(
        `Relayer .env not found at ${envPath}. ` +
        'Run `npm --prefix noosphere-mcp run install:user` first, ' +
        'then re-run `noosphere setup --local`.',
      );
    }
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  let updated = setEnvLine(contents, 'NOOSPHERE_MEMORY_BACKEND', backend);
  updated = setEnvLine(updated, 'DEMO_MODE', 'false');
  await writeFile(envPath, updated, { mode: 0o600 });
  await chmod(envPath, 0o600);
  return true;
}

function setEnvLine(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }
  const separator = contents.endsWith('\n') || contents.length === 0 ? '' : '\n';
  return `${contents}${separator}${line}\n`;
}

function printWalrusAccountOptions() {
  printBlock([
    '',
    '────────────────────────────────────────────────────────────',
    '  Options',
    '────────────────────────────────────────────────────────────',
    '',
    '  A — Local file memory (no account, no SUI, no Walrus)',
    '      Re-run: noosphere setup --local',
    '      Local file persistence only; nothing leaves your machine.',
    '',
    '  B — Free testnet account (~5 min, no real money)',
    '      Install Sui CLI:  curl https://install.mystenlabs.com/sui | sh',
    '      Switch to testnet: sui client switch --env testnet',
    '      Fund it for free:  sui client faucet',
    '      Then create a Walrus Memory account per:',
    '        https://docs.wal.app/walrus-memory/getting-started/',
    '      Re-run: noosphere setup --network testnet',
    '',
    '  C — Mainnet (real SUI, persistent shared memory)',
    '      Step 1 — Get a Sui wallet',
    '        Browser: https://slush.app  or  https://suiwallet.com',
    '        CLI:     curl https://install.mystenlabs.com/sui | sh',
    '      Step 2 — Fund it with ~0.1 SUI',
    '        Buy on any exchange (Binance, Coinbase, Kraken…)',
    '      Step 3 — Create the Walrus Memory account',
    '        Docs: https://docs.wal.app/walrus-memory/getting-started/',
    '      Step 4 — Come back with:',
    '        • Account object ID  (0x followed by 64 hex characters)',
    '        • Delegate private key  (64 hexadecimal characters)',
    '',
    '────────────────────────────────────────────────────────────',
    '',
  ]);
}

function printBlock(lines) {
  for (const line of lines) console.log(line);
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
