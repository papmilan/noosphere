import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../continuity/index.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/acp/execution-continuation-case.json', import.meta.url));
const dirs = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// The acceptance case for Execution Continuity: agent A checkpoints mid-task,
// then a completely separate process — sharing nothing but the repository and
// its .noosphere files — must learn where to continue from the rendered
// advisory kernel alone.
describe('ACP execution continuation acceptance', () => {
  it('lets a clean process resume from the files alone', async () => {
    const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));

    const repo = await mkdtemp(path.join(os.tmpdir(), 'noosphere-exec-accept-'));
    dirs.push(repo);
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await mkdir(path.join(repo, 'tests'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'parser.js'), 'export function parseHeader() {}\n');
    await writeFile(path.join(repo, 'tests', 'parser.test.js'), '// failing version-field test\n');
    await writeFile(path.join(repo, '.gitignore'), '.noosphere/\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });

    // Agent A checkpoints (separate process #1).
    const inputDir = await mkdtemp(path.join(os.tmpdir(), 'noosphere-exec-accept-input-'));
    dirs.push(inputDir);
    const inputFile = path.join(inputDir, 'checkpoint.json');
    await writeFile(inputFile, JSON.stringify(fixture.asserted));
    await execFileAsync('node', [CLI, 'exec', 'checkpoint', '--file', inputFile, '--path', repo], { timeout: 30_000 });

    // The successor (separate process #2) reads the kernel.
    const shown = await execFileAsync('node', [CLI, 'exec', 'show', '--path', repo], { timeout: 30_000 });
    const kernel = shown.stdout;

    for (const fragment of fixture.required_kernel_fragments) {
      assert.match(kernel, new RegExp(fragment), `kernel must contain /${fragment}/`);
    }
    assert.ok(Buffer.byteLength(kernel, 'utf8') <= 1_300, 'kernel plus trailing newline stays near budget');

    // The successor edits the current target; the checkpoint must degrade
    // honestly instead of pretending the step is still fresh.
    await writeFile(path.join(repo, 'src', 'parser.js'), 'export function parseHeader(header) { return header; }\n');
    const afterEdit = await execFileAsync('node', [CLI, 'exec', 'show', '--path', repo], { timeout: 30_000 });
    assert.match(afterEdit.stdout, /TARGET target-changed: edit src\/parser\.js/);
  });
});
