import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the production image copies every published top-level runtime module', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const dockerfile = (await readFile(path.join(ROOT, 'Dockerfile'), 'utf8'))
    .replace(/\\\r?\n\s*/g, ' ');
  const copied = new Set();
  for (const line of dockerfile.split(/\r?\n/)) {
    const match = /^COPY(?:\s+--\S+)*\s+(.+?)\s+\.\/$/.exec(line.trim());
    if (!match) continue;
    for (const source of match[1].trim().split(/\s+/)) {
      copied.add(source.startsWith('noosphere-relayer/')
        ? source.slice('noosphere-relayer/'.length)
        : source);
    }
  }

  const runtimeModules = manifest.files.filter((file) => !file.includes('/') && file.endsWith('.js'));
  const missing = runtimeModules.filter((file) => !copied.has(file));
  assert.deepEqual(missing, [], `Dockerfile omits published runtime modules: ${missing.join(', ')}`);

  const secureManifest = JSON.parse(
    await readFile(path.join(ROOT, '..', 'noosphere-secure-fs', 'package.json'), 'utf8'),
  );
  for (const file of ['package.json', ...secureManifest.files]) {
    assert.match(
      dockerfile,
      new RegExp(`\\bnoosphere-secure-fs/${file.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`),
      `Dockerfile omits @noosphere/secure-fs runtime file: ${file}`,
    );
  }
});
