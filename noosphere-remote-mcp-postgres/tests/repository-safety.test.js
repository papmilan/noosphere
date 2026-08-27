import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PostgresProjectMemoryRepository } from '../src/repository.js';
import { validCheckpoint, validProject, validSession } from '../../noosphere-remote-mcp/tests/fixtures.js';

const OWNER = 'issuer:https://id.example|subject:owner';

function transactionPool(handler, direct = async () => ({ rows: [] })) {
  return {
    query: direct,
    async connect() {
      return {
        async query(text, values) {
          if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] };
          return handler(text, values);
        },
        release() {},
      };
    },
  };
}

describe('PostgreSQL repository race boundaries without a database', () => {
  it('reads an export from one SQL snapshot instead of three READ COMMITTED snapshots', async () => {
    const project = validProject();
    const session = validSession();
    const checkpoint = validCheckpoint();
    const queries = [];
    const pool = {
      async query(text, values) {
        queries.push({ text, values });
        return { rows: [{ project, sessions: [session], checkpoints: [checkpoint] }] };
      },
    };
    const repository = new PostgresProjectMemoryRepository({ pool });

    assert.deepEqual(
      await repository.inspectProjectState({ ownerScope: OWNER, projectId: project.id }),
      { project, sessions: [session], checkpoints: [checkpoint] },
    );
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /jsonb_agg\(s\.document order by s\.seq asc\)/);
    assert.match(queries[0].text, /jsonb_agg\(c\.document order by c\.seq asc\)/);
  });

  it('rechecks retention under the project lock and skips an extension made after listing', async () => {
    const deletes = [];
    const pool = transactionPool(
      async (text, values) => {
        const projectId = values[1];
        if (text.startsWith('select 1 from projects')) return { rows: [{ '?column?': 1 }] };
        if (text.startsWith('select retain_until')) {
          return { rows: [{ retain_until: projectId === 'prj_due' ? '2026-01-01T00:00:00.000Z' : '2999-01-01T00:00:00.000Z' }] };
        }
        if (text.startsWith('delete ')) deletes.push({ text, projectId });
        return { rows: [] };
      },
      async (text) => {
        assert.match(text, /retain_until <= \$2/);
        return { rows: [{ project_id: 'prj_due' }, { project_id: 'prj_extended' }] };
      },
    );
    const repository = new PostgresProjectMemoryRepository({ pool });

    assert.deepEqual(
      await repository.purgeExpiredProjects({ ownerScope: OWNER, now: '2026-07-20T00:00:00.000Z' }),
      ['prj_due'],
    );
    assert.equal(deletes.length, 5);
    assert.equal(deletes.every(({ projectId }) => projectId === 'prj_due'), true);
  });

  it('rejects impossible or non-canonical retention timestamps before database I/O', async () => {
    let calls = 0;
    const pool = transactionPool(async () => { calls += 1; return { rows: [] }; });
    const repository = new PostgresProjectMemoryRepository({ pool });

    await assert.rejects(
      repository.setRetentionMarker({ ownerScope: OWNER, projectId: 'prj_1', retainUntil: '2026-02-31T00:00:00.000Z' }),
      /invalid-retain-until/,
    );
    await assert.rejects(
      repository.purgeExpiredProjects({ ownerScope: OWNER, now: 'July 20, 2026' }),
      /invalid-now/,
    );
    assert.equal(calls, 0);
  });
});
