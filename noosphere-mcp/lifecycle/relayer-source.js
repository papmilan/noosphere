import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceMcp = path.resolve(here, '..');
const sourceRoot = path.resolve(sourceMcp, '..');

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

  throw new Error(
    [
      'Could not locate the noosphere-relayer package.',
      '',
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
      '',
      'Checked the following locations:',
      ...checked.map((p) => `  - ${p}`),
    ].join('\n'),
  );
}
