import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { MAX_TRUST_RECORD_BYTES } from '../continuity/trust-store-internal.js';
import { createTrustTestHarness } from './helpers/trust-test-harness.js';

const temporary = [];
after(async () => { await Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fresh() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-project-'));
  temporary.push(home, project);
  return { home, project, env: { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'phase4-owner' } };
}

describe('SEC-05 Phase 4A-R1 — strict machine-key and bounded authenticated inputs', () => {
  for (const [name, content] of Object.entries({
    uppercase: 'A'.repeat(64),
    'odd length': 'a'.repeat(63),
    'non-hex': `${'a'.repeat(63)}g`,
    'embedded NUL': `${'a'.repeat(31)}\0${'a'.repeat(32)}`,
    'trailing junk': `${'a'.repeat(64)}x`,
    'additional line': `${'a'.repeat(64)}\nextra\n`,
  })) {
    it(`rejects ${name} machine-key material without overwriting it`, async () => {
      const { home, env } = await fresh();
      const file = path.join(home, 'machine-key');
      await fs.writeFile(file, content, { mode: 0o600 });
      const harness = createTrustTestHarness({ env });
      await assert.rejects(harness.ensureMachineKey(), (error) => error.code === 'machine-key-corrupt');
      assert.equal(await fs.readFile(file, 'utf8'), content);
    });
  }

  it('accepts exactly 64 lowercase hex characters with one terminal newline', async () => {
    const { home, env } = await fresh();
    const material = 'ab'.repeat(32);
    await fs.writeFile(path.join(home, 'machine-key'), `${material}\n`, { mode: 0o600 });
    const key = await createTrustTestHarness({ env }).ensureMachineKey();
    assert.equal(key.toString('hex'), material);
  });

  it('rejects exact-size-plus-one immutable inputs before parsing', async () => {
    const { env, project } = await fresh();
    const harness = createTrustTestHarness({ env });
    const binding = await harness.createProjectBinding(project);
    const file = harness.pathFor(binding, 'records/master-prompt/1-11111111-1111-4111-8111-111111111111.json');
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, 'x'.repeat(MAX_TRUST_RECORD_BYTES + 1), { mode: 0o600 });
    await assert.rejects(harness.readImmutableRecord(file), (error) => error.code === 'record-too-large');
  });

  it('rejects oversized bindings and manifests before parsing', async () => {
    const { env, project } = await fresh();
    const harness = createTrustTestHarness({ env });
    const binding = await harness.createProjectBinding(project);
    await fs.writeFile(harness.bindingPath(project), 'x'.repeat(MAX_TRUST_RECORD_BYTES + 1), { mode: 0o600 });
    await assert.rejects(harness.readProjectBinding(project), (error) => error.code === 'record-too-large');
    await fs.mkdir(path.dirname(harness.manifestPath(binding, 'master-prompt')), { recursive: true, mode: 0o700 });
    await fs.writeFile(harness.manifestPath(binding, 'master-prompt'), 'x'.repeat(MAX_TRUST_RECORD_BYTES + 1), { mode: 0o600 });
    await assert.rejects(harness.readManifest(binding, 'master-prompt'), (error) => error.code === 'record-too-large');
  });
});

// SEC-05 Phase 4A-R3 (remediation §16). The `+1` rejection above proves the cap
// fires; these pin the other three properties of the boundary: it is inclusive at
// exactly MAX, it counts bytes rather than characters, and it runs before any
// decode or parse of attacker-controlled input.
describe('SEC-05 Phase 4A-R3 — exact record-size boundary', () => {
  async function seededRecordPath() {
    const { env, project } = await fresh();
    const harness = createTrustTestHarness({ env });
    const binding = await harness.createProjectBinding(project);
    const file = harness.pathFor(binding, 'records/master-prompt/1-11111111-1111-4111-8111-111111111111.json');
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    return { harness, file };
  }

  it('admits exactly MAX bytes to the parser instead of rejecting on size', async () => {
    const { harness, file } = await seededRecordPath();
    await fs.writeFile(file, 'x'.repeat(MAX_TRUST_RECORD_BYTES), { mode: 0o600 });
    // Still invalid — but it must fail as unparseable content, NOT as oversized:
    // that is what proves the comparison is `> MAX`, not `>= MAX`.
    await assert.rejects(harness.readImmutableRecord(file), (error) => error.code === 'record-corrupt');
  });

  it('measures the cap in bytes, not characters', async () => {
    const { harness, file } = await seededRecordPath();
    // 32769 characters — comfortably under MAX by a character count — but 65538
    // bytes once encoded, so a character-based cap would let this straight through.
    const payload = 'é'.repeat(MAX_TRUST_RECORD_BYTES / 2 + 1);
    assert.ok(payload.length < MAX_TRUST_RECORD_BYTES);
    assert.ok(Buffer.byteLength(payload, 'utf8') > MAX_TRUST_RECORD_BYTES);
    await fs.writeFile(file, payload, { mode: 0o600 });
    await assert.rejects(harness.readImmutableRecord(file), (error) => error.code === 'record-too-large');
  });

  it('enforces the cap before decoding untrusted bytes', async () => {
    const { harness, file } = await seededRecordPath();
    // Oversized AND invalid UTF-8. Both faults are fatal, so the reported one
    // tells us which check ran first; it must be the cheap size check.
    const oversized = Buffer.concat([Buffer.alloc(MAX_TRUST_RECORD_BYTES + 1, 0x78), Buffer.from([0xff, 0xfe])]);
    await fs.writeFile(file, oversized, { mode: 0o600 });
    await assert.rejects(harness.readImmutableRecord(file), (error) => error.code === 'record-too-large');
  });
});

// SEC-05 Phase 4A-R3 (remediation §16) — the inverse of the Phase 3 M-2 fix.
// M-2 proved the renderer gates on the bytes it displays. This proves the other
// direction at the format-2 layer: a committed record authorizes exactly one byte
// string and nothing adjacent to it, so a sink that gates on the wrong variant
// fails closed rather than inheriting authority.
describe('SEC-05 Phase 4A-R3 — authority binds exactly one byte string', () => {
  const BODY = 'Baseline: the project ships a fail-closed trust store.';
  const FULL_FILE = `# Noosphere project baseline\n\n${BODY}`;

  async function committed(rawBytes) {
    const { env, project } = await fresh();
    const harness = createTrustTestHarness({ env });
    const binding = await harness.createProjectBinding(project);
    await harness.commitTestTransaction({ binding, slot: 'baseline', rawBytes });
    return (candidate) => harness.isFormat2Authoritative({ binding, slot: 'baseline', rawBytes: candidate });
  }

  it('authorizes the approved body and not the file that wraps it', async () => {
    const authorizes = await committed(BODY);
    assert.equal(await authorizes(BODY), true);
    assert.equal(await authorizes(FULL_FILE), false);
  });

  it('authorizes the approved full file and not the body inside it', async () => {
    const authorizes = await committed(FULL_FILE);
    assert.equal(await authorizes(FULL_FILE), true);
    assert.equal(await authorizes(BODY), false);
  });

  it('rejects byte-level neighbours of the approved content', async () => {
    const authorizes = await committed(BODY);
    for (const near of [`${BODY}\n`, ` ${BODY}`, BODY.replace('fail-closed', 'fail-open'), BODY.toUpperCase(), '']) {
      assert.equal(await authorizes(near), false, `must not authorize: ${JSON.stringify(near)}`);
    }
  });
});
