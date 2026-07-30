import os from 'node:os';
import { delegateKeyToPublicKey, MemWal } from '@mysten-incubation/memwal';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { loadCredentialsIntoEnv } from './credentials.js';
import { installRelayerFetchGuard } from './relayer-fetch-guard.js';
import { assertApprovedRelayerOrigin } from './relayer-origins.js';

loadCredentialsIntoEnv();

export const WALRUS_NETWORKS = {
  mainnet: {
    packageId:
      '0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6',
    registryId:
      '0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd',
    relayerUrl: 'https://relayer.memory.walrus.xyz',
    rpcUrl: 'https://fullnode.mainnet.sui.io:443',
  },
  testnet: {
    packageId:
      '0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6',
    registryId:
      '0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437',
    relayerUrl: 'https://relayer-staging.memory.walrus.xyz',
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
  },
};

export class WalrusMemoryAdapter {
  constructor(env = process.env, { home = os.homedir(), createClient } = {}) {
    this.env = env;
    this.config = resolveWalrusConfig(env);
    this.client = null;
    this.accountValidation = null;
    this.home = home;
    // Seam so the origin gate can be exercised without the real SDK/network.
    this.createClient = createClient ?? ((options) => MemWal.create(options));
  }

  async health() {
    if (!this.config.configured) {
      return {
        ready: false,
        mode: 'walrus-memory',
        network: this.config.network,
        server_url: this.config.relayerUrl,
        configured: false,
        on_chain_account: false,
      };
    }

    try {
      const [server, account] = await Promise.all([
        this.getClient().health(),
        this.validateAccount(),
      ]);
      return {
        ready: server.status === 'ok' && account.valid,
        mode: 'walrus-memory',
        network: this.config.network,
        server_url: this.config.relayerUrl,
        configured: true,
        relayer_status: server.status,
        on_chain_account: account.valid,
        delegate_registered: account.delegateRegistered,
      };
    } catch (error) {
      return {
        ready: false,
        mode: 'walrus-memory',
        network: this.config.network,
        server_url: this.config.relayerUrl,
        configured: true,
        on_chain_account: false,
        error: error.message,
      };
    }
  }

  async remember(text, namespace) {
    await this.validateAccount();
    return this.getClient().rememberAndWait(text, namespace, {
      timeoutMs: this.config.rememberTimeoutMs,
    });
  }

  async recall(query, limit, namespace) {
    await this.validateAccount();
    return this.getClient().recall({ query, limit, namespace });
  }

  getClient() {
    this.assertConfigured();
    // SEC-01: the credential-bearing client may only be created for an approved
    // origin. This throws BEFORE createClient, so the private key is never sent
    // to an origin a tracked project config silently selected.
    assertApprovedRelayerOrigin(this.config.relayerUrl, {
      builtinOrigins: Object.values(WALRUS_NETWORKS).map((n) => n.relayerUrl),
      home: this.home,
    });
    // SEC-01b: the approved origin's channel refuses every redirect, so signed
    // headers and payloads are never replayed against an origin the gate above
    // did not approve. Installed only after the gate passes.
    installRelayerFetchGuard(this.config.relayerUrl);
    if (!this.client) {
      this.client = this.createClient({
        key: this.config.privateKey,
        accountId: this.config.accountId,
        serverUrl: this.config.relayerUrl,
        namespace: this.config.namespacePrefix,
      });
    }
    return this.client;
  }

  async validateAccount() {
    this.assertConfigured();
    if (!this.accountValidation) {
      this.accountValidation = validateOnChainAccount(this.config).catch(
        (error) => {
          this.accountValidation = null;
          throw error;
        },
      );
    }
    return this.accountValidation;
  }

  assertConfigured() {
    if (!this.config.configured) {
      const error = new Error(
        'Walrus Memory is not configured. Set MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID, or run noosphere setup --local for local-file memory.',
      );
      error.status = 503;
      throw error;
    }
  }
}

export function resolveWalrusConfig(env = process.env) {
  const network = (env.MEMWAL_NETWORK || 'mainnet').toLowerCase();
  const networkConfig = WALRUS_NETWORKS[network];
  if (!networkConfig) {
    throw new Error('MEMWAL_NETWORK must be "mainnet" or "testnet"');
  }

  const privateKey = env.MEMWAL_PRIVATE_KEY || '';
  const accountId = env.MEMWAL_ACCOUNT_ID || '';
  if (privateKey && !/^[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(
      'MEMWAL_PRIVATE_KEY must be a 64-character Ed25519 private key in hex without 0x',
    );
  }
  if (accountId && !/^0x[0-9a-fA-F]{64}$/.test(accountId)) {
    throw new Error(
      'MEMWAL_ACCOUNT_ID must be a 32-byte Sui object ID beginning with 0x',
    );
  }

  return {
    network,
    packageId: networkConfig.packageId,
    registryId: networkConfig.registryId,
    relayerUrl: env.MEMWAL_SERVER_URL || networkConfig.relayerUrl,
    rpcUrl: env.MEMWAL_SUI_RPC_URL || networkConfig.rpcUrl,
    privateKey,
    accountId,
    configured: Boolean(privateKey && accountId),
    namespacePrefix: env.MEMWAL_NAMESPACE_PREFIX || 'noosphere',
    rememberTimeoutMs: parsePositiveInteger(
      env.MEMWAL_REMEMBER_TIMEOUT_MS,
      180_000,
      'MEMWAL_REMEMBER_TIMEOUT_MS',
    ),
  };
}

export async function validateOnChainAccount(config, { createClient } = {}) {
  // Sui public fullnodes retired JSON-RPC (-32601 on every method), so this
  // reads the account over gRPC-web instead. Same host and port as before.
  // `createClient` is a test seam, matching WalrusMemoryAdapter's.
  const client = createClient
    ? createClient(config)
    : new SuiGrpcClient({
        network: config.network,
        baseUrl: config.rpcUrl,
      });

  let object;
  try {
    // `include.json` returns the parsed Move fields; without it the response
    // carries only object metadata.
    ({ object } = await client.getObject({
      objectId: config.accountId,
      include: { json: true },
    }));
  } catch (error) {
    // A missing object throws here rather than returning an empty result.
    // Every other failure (transport, TLS, wrong endpoint) must surface as
    // itself — that is how a dead endpoint stays diagnosable.
    if (!/not found/i.test(error.message)) throw error;
    throw new Error(
      `MemWalAccount ${config.accountId} does not exist on Sui ${config.network}`,
    );
  }

  const expectedType = `${config.packageId}::account::MemWalAccount`;
  if (object.type !== expectedType) {
    throw new Error(
      `Object ${config.accountId} is not a ${config.network} MemWalAccount`,
    );
  }

  const fields = object.json;
  if (!fields || fields.active === false) {
    throw new Error(`MemWalAccount ${config.accountId} is not active`);
  }

  const publicKey = [
    ...(await delegateKeyToPublicKey(config.privateKey)),
  ];
  const delegateRegistered = containsByteArray(fields, publicKey);
  if (!delegateRegistered) {
    throw new Error(
      `Configured delegate key is not registered on ${config.accountId} (${config.network})`,
    );
  }

  return { valid: true, delegateRegistered: true };
}

function containsByteArray(
  value,
  expected,
  // gRPC renders Move `vector<u8>` as a base64 string where JSON-RPC returned a
  // numeric array. Both shapes are accepted so the delegate lookup does not
  // depend on the transport. Computed once by the top-level call and threaded
  // through the recursion.
  encoded = Buffer.from(expected).toString('base64'),
) {
  if (typeof value === 'string') return value === encoded;
  if (Array.isArray(value)) {
    if (
      value.length === expected.length &&
      value.every((item, index) => Number(item) === expected[index])
    ) {
      return true;
    }
    return value.some((item) => containsByteArray(item, expected, encoded));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) =>
      containsByteArray(item, expected, encoded),
    );
  }
  return false;
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
