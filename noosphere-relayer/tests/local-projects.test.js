import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  listLocalProjects,
  registerLocalProject,
} from '../local-projects.js';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const continuityCli = path.resolve(
  packageRoot,
  '..',
  'noosphere-mcp',
  'continuity',
  'index.js',
);

describe('local project control', () => {
  let temporaryRoot;
  let noosphereHome;
  let env;

  before(async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-local-projects-'),
    );
    noosphereHome = path.join(temporaryRoot, 'home');
    env = {
      ...process.env,
      NOOSPHERE_HOME: noosphereHome,
      NOOSPHERE_CLI_PATH: continuityCli,
    };
  });

  after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('initializes and registers a Git project by explicit path', async () => {
    const project = path.join(temporaryRoot, 'gui-project');
    await execFileAsync('git', ['init', project]);

    const result = await registerLocalProject(project, env);
    const projects = await listLocalProjects(env);

    assert.equal(result.project.project_id, 'gui-project');
    assert.equal(projects.length, 1);
    assert.equal(projects[0].project_id, 'gui-project');
    assert.equal(projects[0].enabled, true);

    const config = JSON.parse(
      await readFile(
        path.join(project, '.noosphere', 'config.json'),
        'utf8',
      ),
    );
    assert.equal(config.project_id, 'gui-project');
  });

  it('preserves .noosphere-ignore when registration comes from the UI', async () => {
    const project = path.join(temporaryRoot, 'ignored-project');
    await execFileAsync('git', ['init', project]);
    await writeFile(path.join(project, '.noosphere-ignore'), '', 'utf8');

    await assert.rejects(
      () => registerLocalProject(project, env),
      /opted out|noosphere-ignore/i,
    );

    const projects = await listLocalProjects(env);
    assert.equal(
      projects.some((entry) => entry.project_id === 'ignored-project'),
      false,
    );
  });
});
