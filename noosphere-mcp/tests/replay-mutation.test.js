import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '..');

const mutations = Object.freeze([
  {
    id: 1,
    description: 'add remote timestamp to replay identity input',
    file: 'continuity/internal/replay/identity.js',
    edits: [
      {
        from: "  'projectIdentityDigest',\n  'slot',\n];",
        to: "  'projectIdentityDigest',\n  'slot',\n  'timestamp',\n];",
      },
      {
        from: "    slot,\n    payloadDigest,\n  ]), 'utf8'));",
        to: "    slot,\n    payloadDigest,\n    input.timestamp,\n  ]), 'utf8'));",
      },
    ],
  },
  {
    id: 2,
    description: 'remove slot from replay identity input',
    file: 'continuity/internal/replay/identity.js',
    edits: [{
      from: "    projectIdentityDigest,\n    slot,\n    payloadDigest,\n  ]), 'utf8'));",
      to: "    projectIdentityDigest,\n    payloadDigest,\n  ]), 'utf8'));",
    }],
  },
  {
    id: 3,
    description: 'treat replay classification as authority',
    file: 'continuity/internal/replay/presentation.js',
    edits: [{
      from: '    replayClassification,\n    replayErrorCode,',
      to: "    replayClassification,\n    isSlotAuthoritative: replayClassification !== 'UNAVAILABLE',\n    replayErrorCode,",
    }],
  },
  {
    id: 4,
    description: 'permit replay state to select a candidate identity',
    file: 'continuity/internal/replay/observe.js',
    edits: [{
      from: '    replayIdentity: identity.replayIdentity,\n    projectIdentityDigest,',
      to: '    replayIdentity: identity.replayIdentity,\n    candidateId: identity.replayIdentity,\n    projectIdentityDigest,',
    }],
  },
  {
    id: 5,
    description: 'omit replay count increment',
    file: 'continuity/internal/replay/classify.js',
    edits: [{
      from: '  const replayCount = priorCount + 1;',
      to: '  const replayCount = priorCount;',
    }],
  },
  {
    id: 6,
    description: 'rewrite first-seen evidence on replay',
    file: 'continuity/internal/replay/observe.js',
    edits: [{
      from: '    firstSeen: prior?.firstSeen ?? seen,',
      to: '    firstSeen: seen,',
    }],
  },
  {
    id: 7,
    description: 'skip replay identity locking',
    file: 'continuity/internal/replay/operation.js',
    edits: [{
      from: '      identityLocks.push(await acquireReplayIdentityLock({',
      to: '      if (false) identityLocks.push(await acquireReplayIdentityLock({',
    }],
  },
  {
    id: 8,
    description: 'reverse replay lock order',
    file: 'continuity/internal/replay/operation.js',
    edits: [{
      from: '    ])].sort();',
      to: '    ])].sort().reverse();',
    }],
  },
  {
    id: 9,
    description: 'reuse an authority MAC domain for replay records',
    file: 'continuity/internal/authenticated-records.js',
    edits: [{
      from: "  replayRecord: 'noosphere.replay.record.v1',",
      to: "  replayRecord: 'noosphere/sec05/v2/authority-manifest',",
    }],
  },
  {
    id: 10,
    description: 'accept noncanonical replay JSON',
    file: 'continuity/internal/replay/schema.js',
    edits: [{
      from: "  const record = parseAuthenticatedRecord(raw, {\n    type: 'replay record',",
      to: "  const record = JSON.parse(raw.toString('utf8'));\n  void ({\n    type: 'replay record',",
    }],
  },
  {
    id: 11,
    description: 'skip journal before/after digest comparison',
    file: 'continuity/internal/replay/journal.js',
    edits: [{
      from: "  if (digest === beforeDigest) return 'before';\n  if (digest === afterDigest) return 'after';\n  return 'third';",
      to: "  if (digest === beforeDigest) return 'before';\n  if (digest !== beforeDigest) return 'after';\n  return 'third';",
    }],
  },
  {
    id: 12,
    description: 'retry a journal event by incrementing twice',
    file: 'continuity/internal/replay/observe.js',
    edits: [{
      from: '  if (prior?.lastSeen.eventId === eventId) {',
      to: '  if (false && prior?.lastSeen.eventId === eventId) {',
    }],
  },
  {
    id: 13,
    description: 'suppress ordinary recall duplicates',
    file: 'continuity/internal/replay/presentation.js',
    edits: [{
      from: '  for (const memory of response.memories) {',
      to: '  for (const memory of response.memories.slice(0, 1)) {',
    }],
  },
  {
    id: 14,
    description: 'use remote time for retention ordering',
    file: 'continuity/internal/replay/retention.js',
    edits: [{
      from: "    timestamp(left.lastSeen.observedAt, 'record timestamp') -\n    timestamp(right.lastSeen.observedAt, 'record timestamp');",
      to: "    timestamp(left.remoteTimestamp, 'record timestamp') -\n    timestamp(right.remoteTimestamp, 'record timestamp');",
    }],
  },
  {
    id: 15,
    description: 'export a replay writer from the package',
    file: 'package.json',
    edits: [{
      from: '    "./trust-store": "./continuity/trust-store.js",',
      to: '    "./trust-store": "./continuity/trust-store.js",\n    "./replay-writer": "./continuity/internal/replay/observe.js",',
    }],
  },
  {
    id: 16,
    description: 'add a mutating replay CLI verb',
    file: 'continuity/internal/replay/cli.js',
    edits: [{
      from: "  if (args.length === 1 && args[0] === 'status') {",
      to: "  if (args.length === 1 && args[0] === 'reset') return Object.freeze({ verb: 'reset' });\n  if (args.length === 1 && args[0] === 'status') {",
    }],
  },
  {
    id: 17,
    description: 'let replay failure alter authority outcome',
    file: 'continuity/internal/restore/apply-service.js',
    edits: [{
      from: '    const authoritative = await isSlotAuthoritative({',
      to: '    const authoritative = true;\n    await isSlotAuthoritative({',
    }],
  },
  {
    id: 18,
    description: 'allow more than 4096 replay records',
    file: 'continuity/internal/replay/retention.js',
    edits: [{
      from: '  maximumLiveRecords: 4096,',
      to: '  maximumLiveRecords: 4097,',
    }],
  },
  {
    id: 19,
    description: 'persist replay identity in candidate state',
    file: 'continuity/internal/restore/candidate-store.js',
    edits: [
      {
        from: "  'remoteMetadata',\n  'schema',",
        to: "  'remoteMetadata',\n  'replayIdentity',\n  'schema',",
      },
      {
        from: '      remoteMetadata: source.metadata,\n      projectIdentityDigest,',
        to: "      remoteMetadata: source.metadata,\n      replayIdentity: `sha256:${'0'.repeat(64)}`,\n      projectIdentityDigest,",
      },
    ],
  },
  {
    id: 20,
    description: 'derive candidate identity from content',
    file: 'continuity/internal/restore/candidate-store.js',
    edits: [{
      from: '    const candidateId = generateCandidateId(randomBytes);',
      to: '    const candidateId = hash(source.content).slice(0, 52);',
    }],
  },
  {
    id: 21,
    description: 'bypass the restore candidate-index lock',
    file: 'continuity/internal/replay/restore-stage.js',
    edits: [{
      from: '    const indexLock = await acquireCandidateIndexLock({',
      to: '    const indexLock = await Promise.resolve({ release: async () => undefined });\n    void ({',
    }],
  },
  {
    id: 22,
    description: 'permit descending or nonlexical ranked acquisition',
    file: 'continuity/internal/replay/lock-ranks.js',
    edits: [{
      from: 'rank < prior.rank || (rank === prior.rank && key <= prior.key)',
      to: 'rank > prior.rank || (rank === prior.rank && key > prior.key)',
    }],
  },
  {
    id: 23,
    description: 'make recovery reachable only in tests',
    file: 'continuity/internal/replay/operation.js',
    edits: [
      {
        from: '    let recovered = false;',
        to: "    let recovered = false;\n    if (process.env.NODE_ENV === 'test') {",
      },
      {
        from: '    if (recovered) {\n      await markReplayRecovery({',
        to: '    }\n    if (recovered) {\n      await markReplayRecovery({',
      },
    ],
  },
  {
    id: 24,
    description: 'let read-only inspection enter the mutation boundary',
    file: 'continuity/internal/replay/reader.js',
    edits: [
      {
        from: "import { loadReplayKey } from './key.js';",
        to: "import { loadReplayKey } from './key.js';\nimport { withReplayOperation } from './operation.js';",
      },
      {
        from: 'async function readContext({ env, projectRoot }) {',
        to: 'async function readContext({ env, projectRoot }) {\n  void withReplayOperation;',
      },
    ],
  },
  {
    id: 25,
    description: 'recreate a missing replay key over surviving state',
    file: 'continuity/internal/replay/key.js',
    edits: [{
      from: '    if (entries.length === 0) return null;',
      to: '    return null;',
    }],
  },
  {
    id: 26,
    description: 'expose a replay-key reset surface',
    file: 'continuity/internal/replay/key.js',
    edits: [{
      from: 'export function replayRootPath(env = process.env) {',
      to: 'export function resetReplayKey() { return null; }\n\nexport function replayRootPath(env = process.env) {',
    }],
  },
]);

function replaceExactly(source, edit, mutation) {
  const first = source.indexOf(edit.from);
  assert.notEqual(first, -1, `mutation ${mutation.id} anchor must exist`);
  assert.equal(
    source.indexOf(edit.from, first + edit.from.length),
    -1,
    `mutation ${mutation.id} anchor must be unique`,
  );
  return source.slice(0, first) + edit.to +
    source.slice(first + edit.from.length);
}

async function prepareReplica() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'noosphere-phase5-mutants-'),
  );
  const packageCopy = path.join(root, 'noosphere-mcp');
  await fs.cp(PACKAGE_ROOT, packageCopy, {
    recursive: true,
    filter: entry => path.basename(entry) !== 'node_modules',
  });
  await fs.symlink(
    path.join(PACKAGE_ROOT, 'node_modules'),
    path.join(packageCopy, 'node_modules'),
    'dir',
  );
  await fs.mkdir(path.join(root, 'docs/security'), { recursive: true });
  await fs.copyFile(
    path.join(REPOSITORY_ROOT, 'docs/security/SEC-05-PHASE-5-SPEC.md'),
    path.join(root, 'docs/security/SEC-05-PHASE-5-SPEC.md'),
  );
  return { root, packageCopy };
}

test('all 26 normative Phase 5 source mutations are killed deterministically', async t => {
  assert.deepEqual(
    mutations.map(mutation => mutation.id),
    Array.from({ length: 26 }, (_, index) => index + 1),
  );
  const replica = await prepareReplica();
  t.after(() => fs.rm(replica.root, { recursive: true, force: true }));

  for (const mutation of mutations) {
    await t.test(
      `${String(mutation.id).padStart(2, '0')} ${mutation.description}`,
      async () => {
        const target = path.join(replica.packageCopy, mutation.file);
        const original = await fs.readFile(target, 'utf8');
        let changed = original;
        for (const edit of mutation.edits) {
          changed = replaceExactly(changed, edit, mutation);
        }
        assert.notEqual(changed, original);
        await fs.writeFile(target, changed, 'utf8');
        try {
          if (target.endsWith('.js')) {
            const syntax = spawnSync(process.execPath, ['--check', target], {
              encoding: 'utf8',
            });
            assert.equal(
              syntax.status,
              0,
              `mutation ${mutation.id} must remain syntactically valid:\n${syntax.stderr}`,
            );
          } else {
            JSON.parse(changed);
          }
          const killed = spawnSync(
            process.execPath,
            ['--test', 'tests/phase5-conformance.test.js'],
            {
              cwd: replica.packageCopy,
              encoding: 'utf8',
              env: Object.fromEntries(
                Object.entries({ ...process.env, NO_COLOR: '1' })
                  .filter(([name]) => name !== 'NODE_TEST_CONTEXT'),
              ),
              timeout: 30_000,
            },
          );
          assert.notEqual(
            killed.status,
            0,
            `mutation ${mutation.id} survived:\n${killed.stdout}\n${killed.stderr}`,
          );
        } finally {
          await fs.writeFile(target, original, 'utf8');
        }
      },
    );
  }
});
