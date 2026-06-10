import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

describe('official Walrus Memory MCP configuration', () => {
  for (const file of [
    'claude-desktop-config.json',
    'cursor-config.json',
  ]) {
    it(`${file} invokes memwal-mcp directly`, async () => {
      const contents = await readFile(
        path.join(root, 'mcp-server', file),
        'utf8',
      );
      const config = JSON.parse(contents).mcpServers.noosphere;

      assert.equal(config.command, 'npx');
      assert.ok(
        config.args.includes('@mysten-incubation/memwal-mcp@0.0.4'),
      );
      assert.ok(config.args.includes('--staging'));
      assert.ok(config.args.includes('--namespace'));
      assert.ok(
        config.args.some((argument) => argument.startsWith('noosphere-')),
      );
    });
  }
});
