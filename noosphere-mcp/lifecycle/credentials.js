import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveRelayerPath } from './relayer-source.js';

const relayerPath = resolveRelayerPath();
const {
  CredentialStore,
  SECRET_CREDENTIAL_KEYS,
  loadCredentialsIntoEnv,
  toStoredCredentialPayload,
} = await import(
  pathToFileURL(path.join(relayerPath, 'credentials.js')).href
);

export {
  CredentialStore,
  SECRET_CREDENTIAL_KEYS,
  loadCredentialsIntoEnv,
  toStoredCredentialPayload,
};
