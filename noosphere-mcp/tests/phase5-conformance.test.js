import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '..');
const SPEC = path.join(
  REPOSITORY_ROOT,
  'docs/security/SEC-05-PHASE-5-SPEC.md',
);

const shard = name => `noosphere-mcp/tests/${name}`;

export const PHASE5_CONFORMANCE = Object.freeze({
  'RPL-I01': [shard('replay-store.test.js'), shard('replay-ordinary-recall.test.js')],
  'RPL-I02': [shard('replay-store.test.js')],
  'RPL-I03': [shard('replay-store.test.js'), shard('replay-crash.test.js')],
  'RPL-I04': [shard('replay-api-boundary.test.js'), shard('replay-ordinary-recall.test.js')],
  'RPL-I05': [shard('replay-state.test.js'), shard('replay-store.test.js')],
  'RPL-I06': [shard('replay-domain-separation.test.js'), shard('replay-schema.test.js')],
  'RPL-I07': [shard('replay-store.test.js'), shard('replay-cli-boundary.test.js')],
  'RPL-I08': [shard('replay-crash.test.js'), shard('replay-key-lifecycle.test.js')],
  'RPL-I09': [shard('replay-identity.test.js'), shard('replay-retention.test.js')],
  'RPL-I10': [shard('replay-ordinary-recall.test.js')],
  'RPL-I11': [shard('replay-identity-separation.test.js'), shard('replay-restore-suppression.test.js')],
  'RPL-I12': [shard('replay-production-recovery.test.js'), shard('replay-context-refresh.test.js')],
  'RPL-I13': [shard('replay-lock-hierarchy.test.js'), shard('replay-restore-suppression.test.js')],
  'RPL-I14': [shard('replay-key-lifecycle.test.js'), shard('replay-api-boundary.test.js')],

  'RPL-T001': [shard('replay-store.test.js')],
  'RPL-T002': [shard('replay-store.test.js')],
  'RPL-T003': [shard('replay-store.test.js'), shard('replay-crash.test.js')],
  'RPL-T004': [shard('replay-store.test.js')],
  'RPL-T005': [shard('replay-api-boundary.test.js'), shard('replay-store.test.js')],
  'RPL-T010': [shard('replay-identity.test.js')],
  'RPL-T011': [shard('replay-identity.test.js')],
  'RPL-T012': [shard('replay-identity.test.js')],
  'RPL-T013': [shard('replay-identity.test.js')],
  'RPL-T014': [shard('replay-identity.test.js')],
  'RPL-T015': [shard('replay-schema.test.js'), shard('replay-identity.test.js')],
  'RPL-T016': [shard('replay-store.test.js')],
  'RPL-T017': [shard('replay-restore-suppression.test.js')],
  'RPL-T018': [shard('replay-identity-separation.test.js')],
  'RPL-T019': [shard('replay-identity-separation.test.js'), shard('replay-lock-hierarchy.test.js')],
  'RPL-T020': [shard('replay-state.test.js'), shard('replay-store.test.js')],
  'RPL-T021': [shard('replay-state.test.js'), shard('replay-store.test.js')],
  'RPL-T022': [shard('replay-state.test.js'), shard('replay-store.test.js')],
  'RPL-T023': [shard('replay-ordinary-recall.test.js')],
  'RPL-T024': [shard('replay-ordinary-recall.test.js')],
  'RPL-T025': [shard('replay-ordinary-recall.test.js')],
  'RPL-T026': [shard('replay-ordinary-recall.test.js'), shard('replay-store.test.js')],
  'RPL-T027': [shard('replay-ordinary-recall.test.js'), shard('replay-api-boundary.test.js')],
  'RPL-T030': [shard('replay-restore-suppression.test.js')],
  'RPL-T031': [shard('replay-restore-suppression.test.js')],
  'RPL-T032': [shard('replay-restore-suppression.test.js')],
  'RPL-T033': [shard('replay-restore-suppression.test.js')],
  'RPL-T034': [shard('replay-restore-suppression.test.js')],
  'RPL-T035': [shard('replay-identity-separation.test.js')],
  'RPL-T036': [shard('replay-restore-suppression.test.js'), shard('replay-store.test.js')],
  'RPL-T040': [shard('replay-store.test.js'), shard('replay-lock-hierarchy.test.js')],
  'RPL-T041': [shard('replay-restore-suppression.test.js')],
  'RPL-T042': [shard('replay-lock-hierarchy.test.js')],
  'RPL-T043': [shard('replay-lock-hierarchy.test.js')],
  'RPL-T044': [shard('replay-crash.test.js'), shard('replay-store.test.js')],
  'RPL-T045': [shard('replay-crash.test.js'), shard('replay-production-recovery.test.js')],
  'RPL-T046': [shard('replay-crash.test.js')],
  'RPL-T047': [shard('replay-api-boundary.test.js'), shard('replay-production-recovery.test.js')],
  'RPL-T048': [shard('replay-production-recovery.test.js'), shard('replay-context-refresh.test.js')],
  'RPL-T049': [shard('replay-cli-boundary.test.js')],
  'RPL-T050': [shard('replay-retention.test.js')],
  'RPL-T051': [shard('replay-retention.test.js')],
  'RPL-T052': [shard('replay-retention.test.js')],
  'RPL-T053': [shard('replay-retention.test.js')],
  'RPL-T054': [shard('replay-retention.test.js'), shard('replay-crash.test.js')],
  'RPL-T055': [shard('replay-retention.test.js')],
  'RPL-T056': [shard('replay-retention.test.js')],
  'RPL-T057': [shard('replay-retention.test.js'), shard('replay-store.test.js')],
  'RPL-T060': [shard('replay-domain-separation.test.js')],
  'RPL-T061': [shard('replay-domain-separation.test.js')],
  'RPL-T062': [shard('replay-api-boundary.test.js')],
  'RPL-T063': [shard('replay-api-boundary.test.js')],
  'RPL-T064': [shard('replay-api-boundary.test.js')],
  'RPL-T065': [shard('replay-api-boundary.test.js')],
  'RPL-T066': [shard('replay-api-boundary.test.js')],
  'RPL-T067': [shard('replay-cli-boundary.test.js')],
  'RPL-T068': [shard('replay-api-boundary.test.js')],
  'RPL-T069': [shard('replay-api-boundary.test.js'), shard('replay-key-lifecycle.test.js')],
  'RPL-T070': [shard('replay-key-lifecycle.test.js')],
});

async function source(relative) {
  return fs.readFile(path.join(REPOSITORY_ROOT, relative), 'utf8');
}

test('conformance map covers every normative Phase 5 identifier exactly', async () => {
  const specification = await fs.readFile(SPEC, 'utf8');
  const normative = [...new Set(
    specification.match(/RPL-[IT]\d+/g),
  )].sort();
  const mapped = Object.keys(PHASE5_CONFORMANCE).sort();
  assert.deepEqual(mapped, normative);

  for (const [identifier, files] of Object.entries(PHASE5_CONFORMANCE)) {
    assert.ok(files.length > 0, `${identifier} must have at least one test shard`);
    for (const file of files) {
      const absolute = path.join(REPOSITORY_ROOT, file);
      assert.equal(
        (await fs.stat(absolute)).isFile(),
        true,
        `${identifier} references missing shard ${file}`,
      );
    }
  }
});

test('CI runs the complete focused Phase 5 shard on every matrix platform', async () => {
  const workflow = await source('.github/workflows/ci.yml');
  assert.match(workflow, /name: SEC-05 Phase 5 replay ledger/);
  for (const file of [
    'phase5-conformance.test.js',
    'replay-api-boundary.test.js',
    'replay-cli-boundary.test.js',
    'replay-context-refresh.test.js',
    'replay-crash.test.js',
    'replay-domain-separation.test.js',
    'replay-identity-separation.test.js',
    'replay-identity.test.js',
    'replay-key-lifecycle.test.js',
    'replay-lock-hierarchy.test.js',
    'replay-mutation.test.js',
    'replay-ordinary-recall.test.js',
    'replay-production-recovery.test.js',
    'replay-restore-suppression.test.js',
    'replay-retention.test.js',
    'replay-schema.test.js',
    'replay-state.test.js',
    'replay-store.test.js',
  ]) {
    assert.match(workflow, new RegExp(`tests/${file.replaceAll('.', '\\.')}`));
  }
});

test('identity, monotonic state, and artifact schemas retain their closed inputs', async () => {
  const identity = await source(
    'noosphere-mcp/continuity/internal/replay/identity.js',
  );
  assert.match(identity, /const INPUT_FIELDS = \[\s*'content',\s*'projectIdentityDigest',\s*'slot',\s*\];/);
  assert.match(identity, /'noosphere\.replay-identity\.v1',\s*projectIdentityDigest,\s*slot,\s*payloadDigest,/);

  const classify = await source(
    'noosphere-mcp/continuity/internal/replay/classify.js',
  );
  assert.match(classify, /const replayCount = priorCount \+ 1;/);

  const observe = await source(
    'noosphere-mcp/continuity/internal/replay/observe.js',
  );
  assert.match(observe, /firstSeen: prior\?\.firstSeen \?\? seen,/);
  assert.match(observe, /prior\?\.lastSeen\.eventId === eventId/);
  assert.doesNotMatch(observe, /false && prior\?\.lastSeen\.eventId/);
  assert.doesNotMatch(observe, /\bcandidate(?:Id|Path)\s*:/);

  const schema = await source(
    'noosphere-mcp/continuity/internal/replay/schema.js',
  );
  assert.match(schema, /parseAuthenticatedRecord\(raw, \{\s*type: 'replay record'/);
  assert.match(schema, /record\.replayCount !== record\.recordGeneration/);
});

test('replay mutation holds the global lock order and production recovery boundary', async () => {
  const operation = await source(
    'noosphere-mcp/continuity/internal/replay/operation.js',
  );
  assert.match(operation, /\]\)\]\.sort\(\);/);
  assert.doesNotMatch(operation, /\.sort\(\)\.reverse\(\)/);
  assert.match(operation, /identityLocks\.push\(await acquireReplayIdentityLock\(/);
  assert.doesNotMatch(operation, /if \(false\) identityLocks\.push/);
  assert.match(operation, /recovered = await recoverReplayJournal\(/);
  assert.match(operation, /recovered = await recoverRetentionJournal\(/);
  assert.doesNotMatch(operation, /NODE_ENV\s*===\s*['"]test['"]/);

  const ranks = await source(
    'noosphere-mcp/continuity/internal/replay/lock-ranks.js',
  );
  assert.match(ranks, /rank < prior\.rank \|\| \(rank === prior\.rank && key <= prior\.key\)/);

  const restoreStage = await source(
    'noosphere-mcp/continuity/internal/replay/restore-stage.js',
  );
  assert.match(restoreStage, /const indexLock = await acquireCandidateIndexLock\(\{/);
});

test('journal recovery authenticates exact before/after artifact positions', async () => {
  const journal = await source(
    'noosphere-mcp/continuity/internal/replay/journal.js',
  );
  assert.match(journal, /if \(digest === beforeDigest\) return 'before';/);
  assert.match(journal, /if \(digest === afterDigest\) return 'after';/);
  assert.match(journal, /return 'third';/);
});

test('MAC domains remain replay-only and candidate identity remains random', async () => {
  const authenticated = await source(
    'noosphere-mcp/continuity/internal/authenticated-records.js',
  );
  assert.match(authenticated, /replayRecord: 'noosphere\.replay\.record\.v1'/);
  assert.doesNotMatch(
    authenticated,
    /replayRecord:\s*'noosphere\/sec05\/v2\/authority-manifest'/,
  );

  const candidateStore = await source(
    'noosphere-mcp/continuity/internal/restore/candidate-store.js',
  );
  assert.match(candidateStore, /const candidateId = generateCandidateId\(randomBytes\);/);
  assert.doesNotMatch(candidateStore, /const candidateId = hash\(source\.content\)/);
  assert.doesNotMatch(candidateStore, /\breplay(?:Identity|Path)\b/);
});

test('retention is fixed, local-clock based, and deterministically ordered', async () => {
  const retention = await source(
    'noosphere-mcp/continuity/internal/replay/retention.js',
  );
  assert.match(retention, /maximumLiveRecords: 4096,/);
  assert.match(retention, /timestamp\(left\.lastSeen\.observedAt, 'record timestamp'\)/);
  assert.match(retention, /return time \|\| left\.replayIdentity\.localeCompare\(right\.replayIdentity\);/);
  assert.doesNotMatch(retention, /remoteTimestamp/);
});

test('inspection stays read-only and replay CLI grammar stays closed', async () => {
  const reader = await source(
    'noosphere-mcp/continuity/internal/replay/reader.js',
  );
  assert.doesNotMatch(
    reader,
    /\b(?:ensureReplayProject|withReplayOperation|recoverReplayJournal|recoverRetentionJournal)\b/,
  );

  const cli = await source(
    'noosphere-mcp/continuity/internal/replay/cli.js',
  );
  assert.match(cli, /args\.length === 1 && args\[0\] === 'status'/);
  assert.match(cli, /args\[0\] !== 'list'/);
  assert.doesNotMatch(
    cli,
    /['"](?:add|clear|reset|reinitialize|rotate|repair|recover|import|export)['"]/,
  );
});

test('authority and candidate outcomes cannot be selected by replay state', async () => {
  const presentation = await source(
    'noosphere-mcp/continuity/internal/replay/presentation.js',
  );
  assert.doesNotMatch(presentation, /\bisSlotAuthoritative\b/);
  assert.doesNotMatch(presentation, /isSlotAuthoritative\s*:/);

  const applyService = await source(
    'noosphere-mcp/continuity/internal/restore/apply-service.js',
  );
  assert.match(applyService, /const authoritative = await isSlotAuthoritative\(\{/);

  const replayFiles = await Promise.all(
    (await fs.readdir(path.join(
      PACKAGE_ROOT,
      'continuity/internal/replay',
    )))
      .filter(file => file.endsWith('.js'))
      .map(file => source(
        `noosphere-mcp/continuity/internal/replay/${file}`,
      )),
  );
  assert.doesNotMatch(
    replayFiles.join('\n'),
    /\b(?:approve|revoke|spendConfirmation|commitRestoreReceipt)\s*\(/,
  );
});

test('package and key lifecycle expose no replay writer or reset surface', async () => {
  const packageJson = JSON.parse(await source('noosphere-mcp/package.json'));
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [
    './package.json',
    './trust-store',
  ]);

  const key = await source(
    'noosphere-mcp/continuity/internal/replay/key.js',
  );
  assert.match(key, /'replay-key-missing-with-state'/);
  assert.match(
    key,
    /if \(raw === null\) \{\s*if \(entries\.length === 0\) return null;\s*throw replayKeyError\(/,
  );
  assert.match(key, /refusing replay-key creation in a non-pristine replay root/);
  assert.doesNotMatch(
    key,
    /export (?:async )?function (?:reset|reinitialize|rotate|repair|recover|import|export)ReplayKey/,
  );
});

test('ordinary recall preserves every item and cannot silently deduplicate', async () => {
  const presentation = await source(
    'noosphere-mcp/continuity/internal/replay/presentation.js',
  );
  assert.match(presentation, /for \(const memory of response\.memories\) \{/);
  assert.doesNotMatch(presentation, /response\.memories\.slice\(0, 1\)/);
});
