import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createTrustTestHarness } from './helpers/trust-test-harness.js';

// SEC-05 Phase 4A-R3 — the project-identity boundary (review §10, remediation §13).
//
// Phase 4A deliberately keys one security principal to one canonical physical
// tree ("Option A"): the binding file is addressed by sha256(realpath(projectRoot))
// and its projectIdentity is a freshly minted random UUID held in owner-only
// state under NOOSPHERE_HOME. The consequences are stated and tested here rather
// than left implicit:
//   - two logical projects that share one physical tree share one principal;
//   - neither repository content nor process environment can fork the identity
//     of a tree or select a different one — only owner-side state can;
//   - Phase 1 path-derived identity is never silently promoted into format 2.
// The owner-controlled identity switch (Option B) is Phase 4B work.

const temporary = [];
after(async () => { await Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-home-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-project-'));
  temporary.push(home, project);
  return { home, project, env: { NOOSPHERE_HOME: home, NOOSPHERE_OWNER_SCOPE: 'phase4-owner' } };
}

describe('SEC-05 Phase 4A-R3 — project identity is owner-side and tree-scoped', () => {
  it('mints a random identity that is not derived from the project path', async () => {
    const { env, project } = await fixture();
    const harness = createTrustTestHarness({ env });
    const binding = await harness.createProjectBinding(project);
    const pathDigest = crypto.createHash('sha256').update(await fs.realpath(project)).digest('hex');

    // realpathHash binds the tree; projectIdentity must NOT be a function of it,
    // so a Phase 1 path-derived identity can never be silently promoted.
    assert.equal(binding.realpathHash, pathDigest);
    assert.notEqual(binding.projectIdentity, pathDigest);
    assert.match(binding.projectIdentity, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Shape assertions alone cannot prove non-derivation: a UUID formatted out of
    // a digest of the path would satisfy every one of them. The falsifiable proof
    // is that the SAME path yields a DIFFERENT identity under different owner-side
    // state — impossible for any pure function of the path.
    const otherHome = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-home-'));
    temporary.push(otherHome);
    const elsewhere = await createTrustTestHarness({ env: { ...env, NOOSPHERE_HOME: otherHome } })
      .createProjectBinding(project);
    assert.equal(elsewhere.realpathHash, binding.realpathHash);
    assert.notEqual(elsewhere.projectIdentity, binding.projectIdentity);
  });

  it('is idempotent: re-binding the same tree returns the same principal', async () => {
    const { env, project } = await fixture();
    const first = await createTrustTestHarness({ env }).createProjectBinding(project);
    // A separate store instance re-reads owner-side state rather than minting again.
    const second = await createTrustTestHarness({ env }).createProjectBinding(project);
    assert.equal(second.projectIdentity, first.projectIdentity);
  });

  it('gives distinct physical trees distinct principals', async () => {
    const { env, project } = await fixture();
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-project-'));
    temporary.push(other);
    const harness = createTrustTestHarness({ env });
    const a = await harness.createProjectBinding(project);
    const b = await harness.createProjectBinding(other);
    assert.notEqual(a.projectIdentity, b.projectIdentity);
  });

  it('treats a canonical tree as ONE principal even under an aliased path', async (t) => {
    const { env, project } = await fixture();
    const alias = path.join(path.dirname(project), `alias-${crypto.randomUUID()}`);
    try {
      await fs.symlink(project, alias, 'dir');
    } catch (error) {
      // Windows runners without SeCreateSymbolicLinkPrivilege cannot create one.
      t.skip(`symlink unavailable: ${error.code}`);
      return;
    }
    temporary.push(alias);
    const harness = createTrustTestHarness({ env });
    const direct = await harness.createProjectBinding(project);
    const aliased = await harness.createProjectBinding(alias);
    // Documented Option A: the canonical physical tree IS the security principal,
    // so an alias reaches the same authority rather than forking a second one.
    assert.equal(aliased.projectIdentity, direct.projectIdentity);
    assert.equal(harness.bindingPath(alias), harness.bindingPath(project));
  });

  it('cannot be forked or selected by repository content', async () => {
    const { env, project } = await fixture();
    const harness = createTrustTestHarness({ env });
    const original = await harness.createProjectBinding(project);
    const forged = crypto.randomUUID();

    // Everything an attacker with repo write access could plant: in-tree state
    // files, a look-alike binding, and config naming a different identity.
    await fs.mkdir(path.join(project, '.noosphere'), { recursive: true });
    await fs.writeFile(path.join(project, '.noosphere', 'trust-identity'), forged);
    await fs.writeFile(path.join(project, '.noosphere', 'config.json'), JSON.stringify({ projectIdentity: forged }));
    await fs.mkdir(path.join(project, 'trust-v2', 'bindings'), { recursive: true });
    await fs.writeFile(
      path.join(project, 'trust-v2', 'bindings', `${original.realpathHash}.json`),
      JSON.stringify({ ...original, projectIdentity: forged }),
    );

    const rebound = await createTrustTestHarness({ env }).readProjectBinding(project);
    assert.equal(rebound.projectIdentity, original.projectIdentity);
    assert.notEqual(rebound.projectIdentity, forged);
  });

  it('cannot be forked or selected by the process environment', async () => {
    const { env, project } = await fixture();
    const original = await createTrustTestHarness({ env }).createProjectBinding(project);
    const forged = crypto.randomUUID();

    // NOOSPHERE_HOME and NOOSPHERE_OWNER_SCOPE are owner-side by design; no other
    // environment value participates in identity resolution.
    const hostile = {
      ...env,
      NOOSPHERE_PROJECT_IDENTITY: forged,
      NOOSPHERE_PROJECT_ID: forged,
      NOOSPHERE_TRUST_IDENTITY: forged,
      NOOSPHERE_TRUST_ROOT: path.join(project, 'trust-v2'),
      NOOSPHERE_PROJECT_ROOT: path.join(project, 'nested'),
    };
    const rebound = await createTrustTestHarness({ env: hostile }).readProjectBinding(project);
    assert.equal(rebound.projectIdentity, original.projectIdentity);
    assert.notEqual(rebound.projectIdentity, forged);
  });

  it('fails closed when another owner scope tries to adopt the binding', async () => {
    const { env, project } = await fixture();
    await createTrustTestHarness({ env }).createProjectBinding(project);
    const foreign = createTrustTestHarness({ env: { ...env, NOOSPHERE_OWNER_SCOPE: 'someone-else' } });
    await assert.rejects(foreign.readProjectBinding(project), (error) => error.code === 'binding-invalid');
  });

  it('fails closed when the binding is moved to a different tree', async () => {
    const { env, project } = await fixture();
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-phase4a-project-'));
    temporary.push(other);
    const harness = createTrustTestHarness({ env });
    const binding = await harness.createProjectBinding(project);
    // Replaying a valid, correctly-MAC'd binding under another tree's address must
    // not transplant authority: realpathHash is checked against the actual tree.
    await fs.copyFile(harness.bindingPath(project), harness.bindingPath(other));
    await assert.rejects(harness.readProjectBinding(other), (error) => error.code === 'binding-invalid');
    assert.equal((await harness.readProjectBinding(project)).projectIdentity, binding.projectIdentity);
  });
});
