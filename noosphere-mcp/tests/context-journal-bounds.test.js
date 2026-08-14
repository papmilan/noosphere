import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { refreshContext } from '../continuity/index.js';

const temporary = [];

after(async () => {
  await Promise.all(
    temporary.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

/** A project whose journal holds the given entry bodies, oldest first. */
async function projectWithJournal(bodies) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noosphere-journal-'));
  temporary.push(root);
  await fs.mkdir(path.join(root, '.noosphere'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.noosphere', 'config.json'),
    JSON.stringify({ project_id: 'journal-bounds', privacy: {} }),
  );
  const entries = bodies.map(
    (body, index) =>
      `## 2026-07-${String((index % 28) + 1).padStart(2, '0')}T10:00:00.000Z — tester / note\n\n${body}\n`,
  );
  await fs.writeFile(
    path.join(root, '.noosphere', 'journal.md'),
    `# Journal\n\n${entries.join('\n')}`,
  );
  return root;
}

function journalSection(rendered) {
  const start = rendered.indexOf('## Local public work journal');
  // The inferred lane renders between the journal and the recalled history, so
  // the bound stops there: measuring to the next-but-one heading would quietly
  // fold a neighbouring section into what these bounds call "the journal".
  const end = rendered.indexOf('## Inferred state', start);
  return rendered.slice(start, end === -1 ? undefined : end);
}

const render = (root) => refreshContext(root, { localOnly: true });

describe('context.md journal bounds', () => {
  it('renders every entry when the journal is short', async () => {
    const root = await projectWithJournal(['alpha body', 'beta body', 'gamma body']);
    const section = journalSection(await render(root));

    assert.match(section, /alpha body/);
    assert.match(section, /gamma body/);
    assert.doesNotMatch(section, /Showing the newest/);
  });

  it('keeps only the newest entries and says what it left out', async () => {
    const bodies = Array.from({ length: 90 }, (_, index) => `entry-${index}`);
    const section = journalSection(await render(await projectWithJournal(bodies)));

    assert.match(section, /Showing the newest 30 of 90 entries/);
    assert.match(section, /the full log is at \.noosphere\/journal\.md/);
    assert.match(section, /entry-89\b/);
    assert.match(section, /entry-60\b/);
    // Anything older than the newest thirty must be gone.
    assert.doesNotMatch(section, /entry-59\b/);
    assert.doesNotMatch(section, /entry-0\b/);
  });

  it('truncates one oversized entry without crowding out the others', async () => {
    // The regression this bound exists for: a single 68 KB entry once starved
    // every older entry behind it, leaving three trivial notes in the section.
    const bodies = [
      ...Array.from({ length: 10 }, (_, index) => `small-${index}`),
      'X'.repeat(70_000),
      ...Array.from({ length: 5 }, (_, index) => `after-${index}`),
    ];
    const section = journalSection(await render(await projectWithJournal(bodies)));

    assert.match(section, /\[Entry truncated at 4096 of \d+ bytes; full text in \.noosphere\/journal\.md\]/);
    assert.ok(section.length < 20_000, `section stayed bounded (${section.length} bytes)`);
    // The entries on both sides of the outlier still render.
    assert.match(section, /small-0\b/);
    assert.match(section, /after-4\b/);
  });

  it('does not treat a heading inside an entry body as a new entry', async () => {
    const bodies = Array.from({ length: 40 }, (_, index) => `body-${index}`);
    // A quoted markdown heading is ordinary prose, not an entry boundary.
    bodies[39] = 'closing note\n\n## Not an entry header\n\ntail of the same entry';
    const section = journalSection(await render(await projectWithJournal(bodies)));

    assert.match(section, /Showing the newest 30 of 40 entries/);
    assert.match(section, /closing note/);
    assert.match(section, /tail of the same entry/);
  });
});
