import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { stageDockerBuildContext } from '../../scripts/docker-build.mjs';

const temporary = [];
after(async () => {
  for (const directory of temporary) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noosphere-docker-context-'));
  temporary.push(root);
  return root;
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

async function write(root, relative, contents = relative) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

test('stages a BuildKit-safe remote context without metadata, dependencies, tests, or secrets', async () => {
  const repositoryRoot = await fixture();
  const destination = path.join(await fixture(), 'staged');
  await write(repositoryRoot, '.dockerignore', '**/node_modules\n');
  for (const packageName of [
    'noosphere-remote-mcp',
    'noosphere-remote-mcp-postgres',
    'noosphere-remote-mcp-server',
  ]) {
    await write(repositoryRoot, `${packageName}/src/index.js`, `export default '${packageName}';\n`);
    await write(repositoryRoot, `${packageName}/._index.js`, 'appledouble');
    await write(repositoryRoot, `${packageName}/node_modules/private.js`, 'dependency');
    await write(repositoryRoot, `${packageName}/tests/private.test.js`, 'test');
    await write(repositoryRoot, `${packageName}/.env`, 'SECRET=must-not-copy');
  }
  await write(repositoryRoot, 'noosphere-remote-mcp-server/Dockerfile', 'FROM scratch\n');

  await stageDockerBuildContext({ repositoryRoot, destination, target: 'remote-mcp' });

  assert.equal(await readFile(path.join(destination, '.dockerignore'), 'utf8'), '**/node_modules\n');
  assert.match(
    await readFile(path.join(destination, 'noosphere-remote-mcp-server', 'src', 'index.js'), 'utf8'),
    /noosphere-remote-mcp-server/,
  );
  for (const forbidden of [
    'noosphere-remote-mcp-server/._index.js',
    'noosphere-remote-mcp-server/node_modules/private.js',
    'noosphere-remote-mcp-server/tests/private.test.js',
    'noosphere-remote-mcp-server/.env',
  ]) {
    assert.equal(await exists(path.join(destination, forbidden)), false, forbidden);
  }
});

test('stages the relayer plus secure-fs from repository root and refuses source symlinks', async () => {
  const repositoryRoot = await fixture();
  const relayer = path.join(repositoryRoot, 'noosphere-relayer');
  await write(repositoryRoot, 'noosphere-relayer/Dockerfile.dockerignore', 'node_modules\n');
  await write(repositoryRoot, 'noosphere-relayer/Dockerfile', 'FROM scratch\n');
  await write(repositoryRoot, 'noosphere-relayer/index.js', 'export {};\n');
  await write(repositoryRoot, 'noosphere-secure-fs/index.js', 'export {};\n');
  await write(repositoryRoot, 'outside-secret', 'must-not-follow');
  await symlink(path.join(repositoryRoot, 'outside-secret'), path.join(relayer, 'linked-secret'));

  await assert.rejects(
    stageDockerBuildContext({
      repositoryRoot,
      destination: path.join(await fixture(), 'staged'),
      target: 'relayer',
    }),
    (error) => error.code === 'docker-context-symlink',
  );

  await rm(path.join(relayer, 'linked-secret'));
  const destination = path.join(await fixture(), 'staged');
  await stageDockerBuildContext({ repositoryRoot, destination, target: 'relayer' });
  assert.equal(
    await readFile(path.join(destination, 'noosphere-relayer', 'index.js'), 'utf8'),
    'export {};\n',
  );
  assert.equal(
    await readFile(path.join(destination, 'noosphere-secure-fs', 'index.js'), 'utf8'),
    'export {};\n',
  );
  assert.equal(await readFile(path.join(destination, '.dockerignore'), 'utf8'), 'node_modules\n');
  assert.equal(await exists(path.join(destination, 'index.js')), false);
});
