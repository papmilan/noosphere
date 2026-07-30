import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  canonicalize,
  ensureMachineKey,
  ensureProjectIdentity,
  putSlotRecord,
  readRecord,
  MAX_TRUST_RECORD_BYTES,
  isSlotAuthoritative,
} from '../continuity/trust-store-internal.js';
import { NORM_ALGO, NORM_VERSION } from '../continuity/memory-safety.js';

// Each test gets an isolated out-of-tree home (NOOSPHERE_HOME) and a temp project
// tree, with a fixed owner scope for determinism.
const tmpRoots = [];
async function freshEnv() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noos-trust-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noos-proj-'));
  tmpRoots.push(home, project);
  return { env: { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'owner-a' }, project, home };
}

after(async () => {
  for (const dir of tmpRoots) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const BYTES = 'You are the pinned master prompt. Preserve phases.';

describe('SEC-05 legacy trust inventory verifier — authenticated format-1 records', () => {
  it('quote-unless-authenticated: no record ⇒ not authoritative (legacy/fresh)', async () => {
    const { env, project } = await freshEnv();
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('an authenticated owner record for the exact bytes ⇒ authoritative', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      true,
    );
  });

  it('different bytes than the approved record ⇒ not authoritative', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: `${BYTES} tampered`, env }),
      false,
    );
  });

  it('malicious clone: same bytes at a different path is untrusted', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    const clone = await fs.mkdtemp(path.join(os.tmpdir(), 'noos-clone-'));
    tmpRoots.push(clone);
    await fs.writeFile(path.join(clone, 'master-prompt.md'), BYTES);
    assert.equal(
      await isSlotAuthoritative({ projectRoot: clone, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('copied repository / moved project: relocated tree loses authority', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    const moved = `${project}-moved`;
    await fs.rename(project, moved);
    tmpRoots.push(moved);
    assert.equal(
      await isSlotAuthoritative({ projectRoot: moved, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('repository-delivered provenance inside the tree is ignored', async () => {
    const { env, project } = await freshEnv();
    // Attacker ships a trust-looking record inside the cloned project tree.
    await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
    await fs.writeFile(
      path.join(project, '.noosphere', 'master-prompt.prov'),
      canonicalize({ slot: 'master-prompt', trust: 'trusted', ownerScope: 'owner-a', contentHash: 'x' }),
    );
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('forged in-repo project identifier cannot select trust', async () => {
    const { env, project } = await freshEnv();
    await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
    await fs.writeFile(path.join(project, '.noosphere', 'config.json'), JSON.stringify({ project_id: 'trusted-victim' }));
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('forged project identity: tampered instance record ⇒ not authoritative', async () => {
    const { env, project } = await freshEnv();
    const identity = await ensureProjectIdentity({ projectRoot: project, env });
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    // Rewrite the instance record with a different identity but keep the old MAC.
    const dir = path.join(env.NOOSPHERE_HOME, 'trust', crypto.createHash('sha256').update(await fs.realpath(project)).digest('hex'));
    const forged = { ...JSON.parse(await fs.readFile(path.join(dir, 'instance.json'), 'utf8')), projectIdentity: 'attacker' };
    await fs.writeFile(path.join(dir, 'instance.json'), canonicalize(forged));
    assert.notEqual(identity.projectIdentity, 'attacker');
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('corrupted MAC ⇒ not authoritative', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    const dir = path.join(env.NOOSPHERE_HOME, 'trust', crypto.createHash('sha256').update(await fs.realpath(project)).digest('hex'));
    const file = path.join(dir, 'master-prompt.json');
    const rec = JSON.parse(await fs.readFile(file, 'utf8'));
    rec.mac = '0'.repeat(rec.mac.length);
    await fs.writeFile(file, canonicalize(rec));
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('non-canonical (reordered/whitespace/duplicate) record ⇒ not authoritative', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    const dir = path.join(env.NOOSPHERE_HOME, 'trust', crypto.createHash('sha256').update(await fs.realpath(project)).digest('hex'));
    const file = path.join(dir, 'master-prompt.json');
    const rec = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify(rec, null, 2)); // pretty-printed = non-canonical
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('corrupted record JSON ⇒ not authoritative', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    const dir = path.join(env.NOOSPHERE_HOME, 'trust', crypto.createHash('sha256').update(await fs.realpath(project)).digest('hex'));
    await fs.writeFile(path.join(dir, 'master-prompt.json'), '{ not json');
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('corrupted / truncated machine key ⇒ not authoritative', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    await fs.writeFile(path.join(env.NOOSPHERE_HOME, 'machine-key'), 'deadbeef\n'); // too short
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('replaced machine key (migration/new machine) ⇒ records fail closed', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    await fs.writeFile(path.join(env.NOOSPHERE_HOME, 'machine-key'), `${crypto.randomBytes(32).toString('hex')}\n`);
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('missing machine key ⇒ not authoritative (no unsigned fallback)', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    await fs.rm(path.join(env.NOOSPHERE_HOME, 'machine-key'));
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('copied trust record into another project (no matching instance) ⇒ not authoritative', async () => {
    const a = await freshEnv();
    await putSlotRecord({ projectRoot: a.project, slot: 'master-prompt', rawBytes: BYTES, env: a.env });
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'noos-projB-'));
    tmpRoots.push(other);
    const aDir = path.join(a.env.NOOSPHERE_HOME, 'trust', crypto.createHash('sha256').update(await fs.realpath(a.project)).digest('hex'));
    const bDir = path.join(a.env.NOOSPHERE_HOME, 'trust', crypto.createHash('sha256').update(await fs.realpath(other)).digest('hex'));
    await fs.mkdir(bDir, { recursive: true });
    await fs.copyFile(path.join(aDir, 'master-prompt.json'), path.join(bDir, 'master-prompt.json'));
    // No instance.json copied into bDir → identity load fails.
    assert.equal(
      await isSlotAuthoritative({ projectRoot: other, slot: 'master-prompt', rawBytes: BYTES, env: a.env }),
      false,
    );
  });

  it('slot mismatch: an instructions record does not authorize master-prompt', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'instructions', rawBytes: BYTES, env });
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('owner-scope mismatch ⇒ not authoritative', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    const otherOwner = { ...env, NOOSPHERE_OWNER_SCOPE: 'owner-b' };
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env: otherOwner }),
      false,
    );
  });

  it('canonicalize is deterministic regardless of key insertion order', () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
    assert.equal(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}');
  });
});

// PR-H — trust-store hardening. No new security semantics; these assert the
// existing fail-closed guarantees hold on the mint/read/creation paths.
describe('SEC-05 PR-H — trust-store hardening', () => {
  const keyPath = (home) => path.join(home, 'machine-key');

  // M-1: a present-but-corrupt machine key must fail closed on the mint path and
  // must NOT be silently regenerated over. Explicit owner reinit is required.
  it('M-1: corrupt existing key ⇒ ensureMachineKey throws and never overwrites it', async () => {
    const { env, home } = await freshEnv();
    const corrupt = 'dead\n'; // 2 bytes of key material, < 32 required
    await fs.writeFile(keyPath(home), corrupt, { mode: 0o600 });

    await assert.rejects(
      ensureMachineKey(env),
      (e) => e && e.code === 'machine-key-corrupt',
      'mint path must fail closed on a corrupt key',
    );
    // The corrupt key file must be untouched (no silent regeneration).
    assert.equal(await fs.readFile(keyPath(home), 'utf8'), corrupt);
  });

  it('M-1: a corrupt key makes every slot fail closed (quoted), never authoritative', async () => {
    const { env, project, home } = await freshEnv();
    // Establish a real, authenticated record first.
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      true,
    );
    // Now corrupt the key; authority must collapse to false.
    await fs.writeFile(keyPath(home), 'beef\n', { mode: 0o600 });
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  // M-6: concurrent first-creation must converge on a single key — no split-brain,
  // no silent overwrite. All racers return the same key and exactly one file exists.
  it('M-6: concurrent ensureMachineKey creation converges on one key', async () => {
    const { env, home } = await freshEnv();
    const keys = await Promise.all([
      ensureMachineKey(env),
      ensureMachineKey(env),
      ensureMachineKey(env),
      ensureMachineKey(env),
    ]);
    const hex = keys.map((k) => k.toString('hex'));
    assert.equal(new Set(hex).size, 1, 'all concurrent creators must agree on one key');
    // The on-disk key equals the agreed key (winner was not overwritten).
    const onDisk = (await fs.readFile(keyPath(home), 'utf8')).trim();
    assert.equal(onDisk, hex[0]);
  });

  // M-7: oversized records are rejected before parsing and fail closed. The size
  // gate must fire ahead of JSON.parse, so oversized garbage reports the size
  // error rather than a parse error.
  it('M-7: oversized trust record is rejected before parse (fail closed)', async () => {
    const { env, project } = await freshEnv();
    // Mint an instance so a project dir exists to place the record in.
    const identity = await ensureProjectIdentity({ projectRoot: project, env });
    assert.ok(identity.projectIdentity);
    const real = await fs.realpath(project);
    const dir = path.join(env.NOOSPHERE_HOME, 'trust', crypto.createHash('sha256').update(real).digest('hex'));
    const big = path.join(dir, 'master-prompt.json');
    await fs.writeFile(big, 'x'.repeat(MAX_TRUST_RECORD_BYTES + 1), { mode: 0o600 });

    await assert.rejects(
      readRecord(big),
      (e) => e && e.code === 'record-too-large',
      'size gate must fire before JSON.parse',
    );
    // And the authority gate stays closed for an oversized record.
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });

  it('M-7: a normally-sized record still reads back', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    const real = await fs.realpath(project);
    const dir = path.join(env.NOOSPHERE_HOME, 'trust', crypto.createHash('sha256').update(real).digest('hex'));
    const record = await readRecord(path.join(dir, 'master-prompt.json'));
    assert.equal(record.slot, 'master-prompt');
  });

  // M-3: the production module surface must expose only the authority decision,
  // never the low-level writers.
  it('M-3: production trust-store.js exposes no low-level writers', async () => {
    const mod = await import('../continuity/trust-store.js');
    assert.equal(typeof mod.isSlotAuthoritative, 'function');
    for (const writer of ['putSlotRecord', 'ensureProjectIdentity', 'ensureMachineKey', 'readRecord']) {
      assert.equal(mod[writer], undefined, `production surface must not export ${writer}`);
    }
  });
});

// PR-2 (Phase 2 + M-5) — the normalizer identity is pinned to the running
// registered normalizer; a caller cannot select or downgrade it, and the record
// binds both the normalized contentHash and the exact-bytes rawHash.
describe('SEC-05 M-5 — normalization identity is not caller-controlled', () => {
  const trustDir = (env, project) =>
    fs.realpath(project).then((real) =>
      path.join(env.NOOSPHERE_HOME, 'trust', crypto.createHash('sha256').update(real).digest('hex')));

  it('records are minted under the running normalizer (NORM_ALGO, NORM_VERSION)', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    const record = await readRecord(path.join(await trustDir(env, project), 'master-prompt.json'));
    assert.equal(record.normAlgo, NORM_ALGO);
    assert.equal(record.normVersion, NORM_VERSION);
  });

  it('caller-supplied normAlgo/normVersion are ignored (cannot pin/downgrade)', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    // Passing bogus normalization identifiers must not change the decision — they
    // are not parameters of isSlotAuthoritative anymore.
    assert.equal(
      await isSlotAuthoritative({
        projectRoot: project, slot: 'master-prompt', rawBytes: BYTES,
        normAlgo: 'raw', normVersion: 999, env,
      }),
      true,
    );
  });

  it('rawHash still binds exact bytes: a normalized-equal but raw-different input is not authoritative', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    // Appending a zero-width space normalizes to the same content but is different
    // raw bytes — must fail closed (no laundering via normalization).
    const laundered = `${BYTES}${String.fromCodePoint(0x200b)}`;
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: laundered, env }),
      false,
    );
  });

  it('a stale-normalizer record fails closed (normVersion mismatch)', async () => {
    const { env, project } = await freshEnv();
    await putSlotRecord({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env });
    const file = path.join(await trustDir(env, project), 'master-prompt.json');
    const record = await readRecord(file);
    // Simulate a record left by an older normalizer version. Re-canonicalized so it
    // parses, but its MAC no longer matches and its normVersion is stale — either
    // way isSlotAuthoritative must reject it.
    const stale = { ...record, normVersion: 0 };
    await fs.writeFile(file, canonicalize(stale), { mode: 0o600 });
    assert.equal(
      await isSlotAuthoritative({ projectRoot: project, slot: 'master-prompt', rawBytes: BYTES, env }),
      false,
    );
  });
});
