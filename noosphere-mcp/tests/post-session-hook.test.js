import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOOK = fileURLToPath(new URL('../hooks/post-session.js', import.meta.url));
const temporary = [];

after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function gitRepository({ activated = true, relayerUrl = 'http://127.0.0.1:1' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noosphere-post-session-'));
  temporary.push(root);
  await execFileAsync('git', ['init'], { cwd: root });
  await mkdir(path.join(root, 'nested', 'working'), { recursive: true });
  if (activated) {
    await mkdir(path.join(root, '.noosphere'), { recursive: true });
    await writeFile(path.join(root, '.noosphere', 'config.json'), `${JSON.stringify({
      project_id: 'hook-test',
      relayer_url: relayerUrl,
      privacy: { share_journal: true },
    }, null, 2)}\n`);
    await writeFile(path.join(root, '.noosphere', 'journal.md'), '# Work journal\n\n');
  }
  return root;
}

async function runHook(root, input = {}, env = {}) {
  const fakeHome = path.join(root, '.test-home');
  await mkdir(fakeHome, { recursive: true });
  const operation = execFileAsync(process.execPath, [HOOK], {
    cwd: input.cwd || root,
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      NOOSPHERE_HOME: path.join(fakeHome, '.noosphere'),
      NOOSPHERE_API_TOKEN: '',
      NOOSPHERE_HOOK_TIMEOUT_SECONDS: '0.05',
      ...env,
    },
    timeout: 10_000,
  });
  operation.child.stdin.end(JSON.stringify(input));
  return operation;
}

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

describe('Claude SessionEnd continuity hook', () => {
  it('journals the visible session summary at the Git root exactly once while offline', async () => {
    const root = await gitRepository();
    const cwd = path.join(root, 'nested', 'working');
    const input = { cwd, session_id: 'same-session' };
    const env = {
      CLAUDE_SESSION_SUMMARY: 'Fixed nested project resolution.\nVerified the journal handoff.',
    };

    const first = await runHook(root, input, env);
    const second = await runHook(root, input, env);
    const journal = await readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8');

    assert.match(first.stdout, /session journaled locally/i);
    assert.match(second.stdout, /session already journaled/i);
    assert.match(journal, /claude-code \/ session-handoff/);
    assert.match(journal, /Fixed nested project resolution\./);
    assert.match(journal, /Verified the journal handoff\./);
    assert.equal(occurrences(journal, /<!-- noosphere:claude-session:[a-f0-9]{64} -->/g), 1);
  });

  it('recovers a journal append lock left by a killed earlier hook', async () => {
    const root = await gitRepository();
    const journal = path.join(root, '.noosphere', 'journal.md');
    const lock = `${journal}.append.lock`;
    await writeFile(lock, JSON.stringify({
      pid: 2_147_483_647,
      token: randomUUID(),
      created_at: Date.now(),
    }));

    const result = await runHook(root, { cwd: root, session_id: 'after-killed-hook' }, {
      CLAUDE_SESSION_SUMMARY: 'Continuity recovered after the previous hook was killed.',
    });

    assert.match(result.stdout, /session journaled locally/i);
    assert.match(await readFile(journal, 'utf8'), /Continuity recovered after the previous hook was killed\./);
    await assert.rejects(access(lock));
  });

  it('does not track or upload a Git project that has not activated Noosphere', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(204).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const relayerUrl = `http://127.0.0.1:${server.address().port}`;
    const root = await gitRepository({ activated: false });
    try {
      const result = await runHook(root, { cwd: root, session_id: 'not-activated' }, {
        CLAUDE_SESSION_SUMMARY: 'Must stay local to Claude.',
        NOOSPHERE_RELAYER_URL: relayerUrl,
      });
      assert.match(result.stdout, /not activated; session skipped/i);
      assert.equal(requests, 0);
      await assert.rejects(access(path.join(root, '.noosphere', 'journal.md')));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuses a repository-selected insecure remote relayer before network activity', async () => {
    const root = await gitRepository({ relayerUrl: 'http://attacker.example.test' });
    const result = await runHook(root, { cwd: root, session_id: 'authority-check' }, {
      CLAUDE_SESSION_SUMMARY: 'The local handoff must survive an upload refusal.',
      NOOSPHERE_API_TOKEN: 'must-not-leave-owner-boundary',
    });
    const journal = await readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8');

    assert.match(result.stderr, /refusing to use a non-HTTPS remote relayer/i);
    assert.match(journal, /local handoff must survive/i);
  });

  it('never substitutes a different project\'s global latest-session summary', async () => {
    const root = await gitRepository();
    const fakeHome = path.join(root, '.test-home');
    await mkdir(path.join(fakeHome, '.claude', 'sessions'), { recursive: true });
    await writeFile(
      path.join(fakeHome, '.claude', 'sessions', 'latest.json'),
      JSON.stringify({ summary: 'SECRET FROM AN UNRELATED PROJECT' }),
    );

    await runHook(root, { cwd: root, session_id: 'no-summary' });
    const journal = await readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8');
    assert.doesNotMatch(journal, /SECRET FROM AN UNRELATED PROJECT/);
    assert.match(journal, /session completed for project hook-test/i);
  });

  it('extracts the final assistant summary from a transcript larger than the read bound', async () => {
    const root = await gitRepository();
    const transcript = path.join(root, 'large-transcript.jsonl');
    await writeFile(transcript, `${'x'.repeat(8 * 1024 * 1024)}\n`);
    await appendFile(transcript, `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Recovered from the bounded transcript tail.' }] },
    })}\n`);

    const result = await runHook(root, {
      cwd: root,
      session_id: 'large-transcript',
      transcript_path: transcript,
    });
    const journal = await readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8');

    assert.match(result.stdout, /session journaled locally/i);
    assert.match(journal, /Recovered from the bounded transcript tail\./);
    assert.doesNotMatch(journal, /session completed for project hook-test/i);
  });

  it('journals locally but skips remote upload when the project config is malformed', async () => {
    const root = await gitRepository();
    await writeFile(path.join(root, '.noosphere', 'config.json'), '{not-json\n');

    let result;
    await assert.rejects(
      runHook(root, { cwd: root, session_id: 'malformed-config' }, {
        CLAUDE_SESSION_SUMMARY: 'The local handoff survives malformed configuration.',
      }),
      (error) => {
        result = error;
        assert.equal(error.code, 1);
        return true;
      },
    );
    const journal = await readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8');

    assert.match(result.stderr, /configuration is not valid JSON/i);
    assert.match(result.stderr, /remote upload skipped/i);
    assert.match(journal, /local handoff survives malformed configuration/i);
  });

  it('returns a visible hook error when the local journal cannot be written', async () => {
    const root = await gitRepository();
    const journal = path.join(root, '.noosphere', 'journal.md');
    await rm(journal);
    await mkdir(journal);

    await assert.rejects(
      runHook(root, { cwd: root, session_id: 'journal-failure' }, {
        CLAUDE_SESSION_SUMMARY: 'This cannot be persisted.',
      }),
      (error) => {
        assert.match(error.stderr, /local journal failed/i);
        assert.equal(error.code, 1);
        return true;
      },
    );
  });

  it('uploads through the owner-authorized boundary and also journals locally', async () => {
    const received = [];
    const server = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          authorization: request.headers.authorization,
          idempotencyKey: request.headers['idempotency-key'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        response.writeHead(201).end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const relayerUrl = `http://127.0.0.1:${server.address().port}`;
    const root = await gitRepository({ relayerUrl });
    try {
      const result = await runHook(root, { cwd: root, session_id: 'uploaded-session' }, {
        CLAUDE_SESSION_SUMMARY: 'Stored both locally and remotely.',
        NOOSPHERE_API_TOKEN: 'owner-token',
      });
      const journal = await readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8');

      assert.match(result.stdout, /session journaled locally/i);
      assert.match(result.stdout, /session stored in Noosphere/i);
      assert.equal(received.length, 1);
      assert.equal(received[0].authorization, 'Bearer owner-token');
      assert.equal(received[0].idempotencyKey, 'claude-code-uploaded-session');
      assert.equal(received[0].body.content, 'Stored both locally and remotely.');
      assert.match(journal, /Stored both locally and remotely\./);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('always journals locally but honors privacy.share_journal=false for upload', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(204).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const root = await gitRepository({ relayerUrl: `http://127.0.0.1:${server.address().port}` });
    await writeFile(path.join(root, '.noosphere', 'config.json'), `${JSON.stringify({
      project_id: 'hook-test',
      relayer_url: `http://127.0.0.1:${server.address().port}`,
      privacy: { share_journal: false },
    }, null, 2)}\n`);
    try {
      const result = await runHook(root, { cwd: root, session_id: 'private-session' }, {
        CLAUDE_SESSION_SUMMARY: 'This handoff must remain local.',
      });
      const journal = await readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8');

      assert.match(result.stdout, /kept local.*privacy/i);
      assert.match(journal, /This handoff must remain local\./);
      assert.equal(requests, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
