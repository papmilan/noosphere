import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveRelayerPath } from './relayer-source.js';

const relayerPath = resolveRelayerPath();
const { CredentialStore, loadCredentialsIntoEnv } = await import(
  pathToFileURL(path.join(relayerPath, 'credentials.js')).href
);

export { CredentialStore, loadCredentialsIntoEnv };
