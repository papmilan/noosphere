import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clock, startAcceptance, structured } from './harness.js';

const AT = '2026-07-20T10:00:00.000Z';

// U+FB02 (ﬂ, LATIN SMALL LIGATURE FL). NFKC folds it to "fl"; a plain lowercase
// does not. So a name spelled with the ligature and one spelled "fl" are equal
// only under NFKC — a genuine compatibility case, not a lowercase variant.
const LIGATURE_NAME = 'Workﬂow Planner';
const ASCII_NAME = 'Workflow Planner';

// Each test runs on its own server + owner so no `it` depends on another's
// writes or on execution order.
async function withClient(run) {
  const h = await startAcceptance({ now: clock(AT) });
  const c = await h.connect(await h.token({ sub: 'discovery' }), 'chatgpt');
  try {
    await run(c);
  } finally {
    await c.close();
    await h.close();
  }
}

describe('Discovery resolution: NFKC, alias, id, substring, ambiguity', () => {
  it('resolves an NFKC-equivalent name that lowercasing alone would not unify', async () => {
    await withClient(async (c) => {
      // Prove the case is genuinely NFKC-sensitive: the spellings differ, and
      // they stay different under lowercase — only NFKC folding bridges them.
      assert.notEqual(LIGATURE_NAME, ASCII_NAME);
      assert.notEqual(LIGATURE_NAME.toLowerCase(), ASCII_NAME.toLowerCase());

      const project = structured(await c.call('create_project', { name: LIGATURE_NAME })).project;
      const found = structured(await c.call('find_projects', { query: ASCII_NAME }));
      assert.equal(found.result, 'resolved');
      assert.equal(found.project.id, project.id);
    });
  });

  it('resolves an exact normalized name, an exact alias, and an exact id via public find_projects', async () => {
    await withClient(async (c) => {
      const project = structured(await c.call('create_project', { name: 'Bicycle Repair', aliases: ['Two-Wheeler Service'] })).project;

      // Normalized-name match despite different case and internal whitespace.
      assert.equal(structured(await c.call('find_projects', { query: '  BICYCLE   repair ' })).result, 'resolved');

      // Alias match (case-folded).
      const byAlias = structured(await c.call('find_projects', { query: 'two-wheeler service' }));
      assert.equal(byAlias.result, 'resolved');
      assert.equal(byAlias.project.id, project.id);

      // Exact id match.
      const byId = structured(await c.call('find_projects', { query: project.id }));
      assert.equal(byId.result, 'resolved');
      assert.equal(byId.project.id, project.id);
    });
  });

  it('reports substring discovery as ambiguous and an unknown query as none — never a silent resolve', async () => {
    await withClient(async (c) => {
      await c.call('create_project', { name: 'Garden Planning' });
      await c.call('create_project', { name: 'Garden Shed Build' });

      const substring = structured(await c.call('find_projects', { query: 'garden' }));
      assert.equal(substring.result, 'ambiguous');
      assert.ok(substring.candidates.length >= 2);

      const unknown = structured(await c.call('find_projects', { query: 'no-such-project-xyz' }));
      assert.equal(unknown.result, 'none');
    });
  });

  it('keeps two projects sharing an exact normalized name typed as ambiguous, not silently resolved', async () => {
    await withClient(async (c) => {
      await c.call('create_project', { name: 'Kite Build' });
      await c.call('create_project', { name: 'kite   build' }); // same normalized_name

      const res = structured(await c.call('find_projects', { query: 'Kite Build' }));
      assert.equal(res.result, 'ambiguous');
      assert.ok(res.candidates.length >= 2);
    });
  });
});
