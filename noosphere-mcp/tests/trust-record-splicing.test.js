// SEC-05 Phase 4C Task 9 Step 3 (second half) — field splicing under a
// preserved MAC.
//
// The ordered domain matrix (tests/trust-domain-separation.test.js) proves a
// record sealed for one domain cannot verify under another. This suite proves
// the complementary property: within a domain, no individual FIELD can be
// exchanged for another record's value while keeping the original MAC.
//
// Every record here is produced by the production writers, not hand-built, so
// the field names and shapes are the ones that actually ship. Each splice keeps
// `mac` byte-identical and changes exactly one field, then asserts both that
// verifyRecord refuses it and — where a production reader exists — that the
// reader refuses it too. A splice that only failed the low-level MAC check
// while some reader accepted the value would be the interesting bug.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';

import {
  AUTH_DOMAINS,
  verifyRecord,
} from '../continuity/internal/authenticated-records.js';
import { approveSlot } from '../continuity/internal/approval-service.js';
import { stageRestoreCandidate } from '../continuity/internal/restore/candidate-store.js';
import { applyRestoreCandidate } from '../continuity/internal/restore/apply-service.js';
import { readApplyJournal } from '../continuity/internal/restore/apply-journal.js';
import { createFormatV2Store } from '../continuity/internal/trust-format-v2.js';
import { canonicalize } from '../continuity/trust-store-internal.js';

const temporary = [];
after(async () => {
  await Promise.all(temporary.map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

function ttyStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  return { input, output };
}

const BODY = '# Noosphere project baseline\n\nspliced body\n';

/** One project with a real approved generation, manifest, audit event, and a
 *  real restore apply journal for the baseline slot. */
async function realProject(marker) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `splice-home-${marker}-`));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), `splice-project-${marker}-`));
  temporary.push(home, project);
  await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
  const destination = path.join(project, '.noosphere', 'baseline.md');
  await fs.writeFile(destination, `original ${marker}\n`);
  const env = { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: `splice-owner-${marker}` };

  // A real approval: record + manifest + audit event, all sealed by production.
  const approved = await approveSlot({
    projectRoot: project,
    slot: 'baseline',
    env,
    confirm: () => true,
  });

  // A real restore apply: candidate, confirmation, journal, receipt, marker.
  const staged = await stageRestoreCandidate({
    projectRoot: project,
    slot: 'baseline',
    env,
    ...ttyStreams(),
    recall: async () => ({
      memories: [{ action_type: 'project-baseline', content: `${BODY}${marker}\n` }],
    }),
  });
  const applied = await applyRestoreCandidate({
    projectRoot: project,
    candidateId: staged.candidate.candidateId,
    env,
    confirm: () => true,
  });
  const store = createFormatV2Store({ env });
  const binding = await store.readProjectBinding(project);
  // The RAW sealed envelope. readApplyJournal returns it merged with the state
  // machine's fields, which are outside the MAC, so verifyRecord needs the file.
  const journalFile = path.join(
    store.pathFor(binding, path.join('restore', 'apply')),
    applied.transactionId,
    'envelope.json',
  );
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  return {
    env,
    project,
    destination,
    store,
    binding,
    key: await store.ensureMachineKey(),
    record: approved.record,
    manifest: approved.manifest,
    audit: approved.audit,
    candidateId: staged.candidate.candidateId,
    journal,
    journalFile,
    transactionId: applied.transactionId,
  };
}

/** Replaces one field, keeping `mac` byte-identical. */
function splice(record, field, value) {
  assert.notDeepEqual(record[field], value, `${field} splice is a no-op`);
  return Object.freeze({ ...record, [field]: value });
}

/**
 * A different value for `field`. Prefers the other project's real value; some
 * fields (schema, version, slot, a first-generation manifest) are legitimately
 * identical across projects, and for those a splice still has to change
 * something or it proves nothing.
 */
function foreignValue(field, mine, theirs) {
  const other = theirs[field];
  if (JSON.stringify(other) !== JSON.stringify(mine[field])) return other;
  const own = mine[field];
  if (typeof own === 'number') return own + 1;
  if (typeof own === 'string') {
    // Keep the shape (hex stays hex, a path stays a path) but change the bytes.
    return /^[0-9a-f]+$/.test(own)
      ? `${own.slice(0, -1)}${own.at(-1) === '0' ? '1' : '0'}`
      : `${own}-spliced`;
  }
  if (own && typeof own === 'object') {
    const [key] = Object.keys(own);
    return { ...own, [key]: foreignValue(key, own, {}) };
  }
  throw new TypeError(`no alternative value for ${field}`);
}

describe('SEC-05 Phase 4C — field splicing under a preserved MAC', () => {
  it('refuses every spliced field of a real apply journal', async () => {
    const [left, right] = await Promise.all([realProject('a'), realProject('b')]);
    const journal = left.journal;
    const foreign = right.journal;
    assert.equal(verifyRecord(left.key, AUTH_DOMAINS.restoreApplyJournal, journal), true,
      'the unspliced journal must verify, or the fixture is wrong');

    // The apply journal is the one record that carries every field class the
    // specification names, so every splice below is one record, one field.
    const fields = [
      'candidateId',            // candidate
      'candidatePayloadHash',   // candidate payload
      'contextId',              // confirmation
      'confirmationEventHash',  // confirmation state
      'receiptId',              // receipt
      'consumedMarkerCandidateId', // consumed marker
      'transactionId',          // transaction / journal identity
      'bindingId',              // binding
      'projectIdentityDigest',  // project identity
      'keyId',                  // machine key identity
      'manifest',               // manifest state + generation
      'slot',                   // slot
      'destination',            // fixed destination
      'temporaryPath',          // deterministic temporary
      'destinationAfterHash',   // replacement payload
      'createdAt',              // envelope time
      'schema',
      'version',
    ];
    for (const field of fields) {
      assert.ok(field in journal, `the journal no longer carries ${field}`);
      assert.ok(field in foreign, `the foreign journal no longer carries ${field}`);
      const spliced = splice(journal, field, foreignValue(field, journal, foreign));
      assert.equal(spliced.mac, journal.mac, `${field}: the MAC must be preserved`);
      assert.equal(
        verifyRecord(left.key, AUTH_DOMAINS.restoreApplyJournal, spliced),
        false,
        `splicing ${field} from another project's journal was accepted`,
      );
    }

    // Generation lives inside the manifest binding; splice it alone rather than
    // swapping the whole manifest object.
    const generation = splice(
      journal,
      'manifest',
      Object.freeze({ ...journal.manifest, generation: journal.manifest.generation + 1 }),
    );
    assert.equal(generation.mac, journal.mac);
    assert.equal(
      verifyRecord(left.key, AUTH_DOMAINS.restoreApplyJournal, generation),
      false,
      'splicing the manifest generation was accepted',
    );
  });

  it('refuses every spliced field of a real approved generation, manifest, and audit event', async () => {
    const [left, right] = await Promise.all([realProject('c'), realProject('d')]);
    for (const [name, domain, mine, theirs] of [
      ['approved generation', AUTH_DOMAINS.approvedGeneration, left.record, right.record],
      ['manifest', AUTH_DOMAINS.manifest, left.manifest, right.manifest],
      ['audit event', AUTH_DOMAINS.audit, left.audit, right.audit],
    ]) {
      assert.equal(verifyRecord(left.key, domain, mine), true,
        `the unspliced ${name} must verify`);
      const fields = Object.keys(mine).filter((field) =>
        field !== 'mac' && field !== 'domain' &&
        !Object.is(mine[field], theirs[field]) &&
        JSON.stringify(mine[field]) !== JSON.stringify(theirs[field]));
      assert.ok(fields.length >= 3, `${name} has too few distinguishing fields to splice`);
      for (const field of fields) {
        const spliced = splice(mine, field, foreignValue(field, mine, theirs));
        assert.equal(spliced.mac, mine.mac, `${name}.${field}: the MAC must be preserved`);
        assert.equal(
          verifyRecord(left.key, domain, spliced),
          false,
          `splicing ${name}.${field} from another project was accepted`,
        );
      }
    }
  });

  it('refuses a spliced record at the production reader, not only at the MAC', async () => {
    // A splice that verifyRecord rejects but a reader accepts would be the real
    // defect, so drive the readers that production actually uses.
    const [left, right] = await Promise.all([realProject('e'), realProject('f')]);

    // Immutable record file: swap the project identity digest, keep the MAC.
    const recordFile = left.store.recordPath(
      left.binding, 'baseline', left.record.generation, left.audit.eventId,
    );
    const original = await fs.readFile(recordFile);
    await fs.writeFile(recordFile, canonicalize(
      splice(left.record, 'projectIdentityDigest', right.record.projectIdentityDigest),
    ));
    await assert.rejects(
      left.store.readImmutableRecord(recordFile),
      (error) => typeof error.code === 'string',
      'the record reader accepted a spliced project identity',
    );
    await fs.writeFile(recordFile, original);

    // Audit event: swap the slot, keep the MAC.
    const auditFile = left.store.auditPath(left.binding, left.audit.eventId);
    await fs.writeFile(auditFile, canonicalize(splice(left.audit, 'slot', 'instructions')));
    await assert.rejects(
      left.store.readAudit(left.binding, left.audit.eventId),
      (error) => typeof error.code === 'string',
      'the audit reader accepted a spliced slot',
    );

    // Apply journal on disk: swap the candidate, keep the MAC. The journal
    // reader must refuse before recovery can act on it.
    const journal = left.journal;
    await fs.writeFile(left.journalFile, canonicalize(
      splice(journal, 'candidateId', right.candidateId),
    ));
    await assert.rejects(
      readApplyJournal({
        projectRoot: left.project,
        env: left.env,
        transactionId: left.transactionId,
      }),
      (error) => typeof error.code === 'string',
      'the journal reader accepted a spliced candidate',
    );
  });
});
