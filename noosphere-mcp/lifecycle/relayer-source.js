import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceMcp = path.resolve(here, '..');
const sourceRoot = path.resolve(sourceMcp, '..');

// Thrown only when the relayer cannot be located, so callers can tell that
// failure apart from a genuine installer fault and print the guidance instead
// of an uncaught stack.
export class RelayerSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayerSourceError';
  }
}

// A registry install puts this package at <prefix>/node_modules/noosphere-continuity,
// which makes sourceRoot the node_modules directory itself — so the peer, when
// it is installed, is already the first candidate below. The user is not in a
// clone and cannot act on clone instructions.
function installedFromRegistry() {
  return path.basename(sourceRoot) === 'node_modules';
}

function peerVersion() {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(sourceMcp, 'package.json'), 'utf8'),
    );
    return manifest.peerDependencies?.['noosphere-relayer'] || null;
  } catch {
    return null;
  }
}

function registryGuidance() {
  const version = peerVersion();
  const spec = version
    ? `noosphere-relayer@${version}`
    : 'noosphere-relayer';
  return [
    'noosphere-continuity declares noosphere-relayer as an optional peer',
    'dependency, so npm does not install it for you. Install it alongside',
    'this package and the command will find it:',
    '',
    `  npm install ${spec}`,
    '',
    'Local project state, CSP, ACP and context work without it. Memory,',
    'setup, credentials and the background services do not.',
  ];
}

function cloneGuidance() {
  return [
    'noosphere-mcp and noosphere-relayer ship together. Clone the repo so',
    'both packages sit as siblings, then re-run install:user from the',
    'noosphere-mcp directory:',
    '',
    '  git clone https://github.com/papmilan/noosphere.git',
    '  cd noosphere',
    '  npm --prefix noosphere-mcp run install:user',
    '',
    'If the relayer lives at a custom path, point install:user at it:',
    '',
    '  NOOSPHERE_RELAYER_SOURCE=/path/to/noosphere-relayer \\',
    '    npm --prefix noosphere-mcp run install:user',
  ];
}

export function resolveRelayerPath() {
  const candidates = [
    process.env.NOOSPHERE_RELAYER_SOURCE,
    path.join(sourceRoot, 'noosphere-relayer'),
    path.join(sourceMcp, 'node_modules', 'noosphere-relayer'),
    path.join(sourceMcp, '..', 'node_modules', 'noosphere-relayer'),
  ].filter(Boolean);

  const checked = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    checked.push(resolved);
    if (
      existsSync(path.join(resolved, 'package.json')) &&
      existsSync(path.join(resolved, 'index.js'))
    ) {
      return resolved;
    }
  }

  throw new RelayerSourceError(
    [
      'Could not locate the noosphere-relayer package.',
      '',
      ...(installedFromRegistry() ? registryGuidance() : cloneGuidance()),
      '',
      'Checked the following locations:',
      ...checked.map((p) => `  - ${p}`),
    ].join('\n'),
  );
}
