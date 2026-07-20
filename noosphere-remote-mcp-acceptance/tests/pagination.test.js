import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clock, startAcceptance } from './harness.js';
import { rawAdapter, sdkAdapter, structured } from './adapters.js';

const AT = '2026-07-20T10:00:00.000Z';
const NAMES = ['Alpha Project', 'Bravo Project', 'Charlie Project', 'Delta Project', 'Echo Project'];

// Walk `list_projects` to exhaustion, returning the ids in observed order. The
// adapter passes the opaque cursor straight back and never decodes it.
async function walk(adapter, pageSize) {
  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const input = cursor === null ? { limit: pageSize } : { limit: pageSize, cursor };
    const res = structured(await adapter.callTool('list_projects', input));
    for (const project of res.projects) seen.push(project.id);
    cursor = res.next_cursor;
    assert.ok(++guard < 100, 'pagination must terminate');
  } while (cursor !== null);
  return seen;
}

// Flip one character of the opaque cursor's ciphertext segment without decoding
// it, so the AEAD/binding check must reject the forged token.
function tamper(cursor) {
  const segments = cursor.split('.');
  const ciphertext = segments[2];
  const original = ciphertext[0];
  const replacement = original === 'A' ? 'B' : 'A';
  segments[2] = replacement + ciphertext.slice(1);
  return segments.join('.');
}

describe('Cursor pagination and tamper rejection', () => {
  for (const factory of [sdkAdapter, rawAdapter]) {
    it(`pages a multi-page project list with no duplicates or omissions and stable order [${factory.name}]`, async () => {
      const h = await startAcceptance({ now: clock(AT) });
      try {
        const a = factory({ mcpUrl: h.mcpUrl, token: await h.token({ sub: 'pager' }) });
        await a.connect();
        const created = [];
        for (const name of NAMES) created.push(structured(await a.callTool('create_project', { name })).project.id);

        // Page size 2 over 5 records forces three pages (2, 2, 1).
        const firstPage = structured(await a.callTool('list_projects', { limit: 2 }));
        assert.equal(firstPage.projects.length, 2);
        assert.ok(firstPage.next_cursor, 'a first page of a multi-page list returns a cursor');

        const seen = await walk(a, 2);
        assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');
        assert.deepEqual([...seen].sort(), [...created].sort(), 'every created project appears exactly once');
        // A second full walk yields the identical order → ordering is stable.
        assert.deepEqual(await walk(a, 2), seen, 'ordering is stable across repeated walks');
        await a.close();
      } finally {
        await h.close();
      }
    });
  }

  it('rejects a tampered opaque cursor with a typed invalid-argument (raw adapter, exact transport inspection)', async () => {
    const h = await startAcceptance({ now: clock(AT) });
    try {
      const a = rawAdapter({ mcpUrl: h.mcpUrl, token: await h.token({ sub: 'tamper' }) });
      await a.connect();
      for (const name of NAMES.slice(0, 3)) await a.callTool('create_project', { name });
      const page1 = structured(await a.callTool('list_projects', { limit: 1 }));
      const cursor = page1.next_cursor;
      assert.ok(cursor, 'obtained an opaque cursor to tamper with');

      const forged = tamper(cursor);
      assert.notEqual(forged, cursor, 'the tampered cursor actually differs from the original');

      const res = await a.callTool('list_projects', { limit: 1, cursor: forged });
      assert.equal(res.isError, true);
      assert.equal(res.structuredContent.error.code, 'invalid-argument');

      // The untampered cursor still works — the rejection is specific to the forgery.
      const ok = structured(await a.callTool('list_projects', { limit: 1, cursor }));
      assert.equal(ok.projects.length, 1);
      await a.close();
    } finally {
      await h.close();
    }
  });
});
