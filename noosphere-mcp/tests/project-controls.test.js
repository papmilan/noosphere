import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  forgetProject,
  pauseProject,
  readRegistry,
  registerProject,
  resumeProject,
} from '../lifecycle/registry.js';

describe('project registry controls', () => {
  let temporaryRoot;
  let env;

  before(async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), 'noosphere-project-controls-'),
    );
    env = { NOOSPHERE_HOME: path.join(temporaryRoot, 'home') };
  });

  after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('pauses, resumes, and forgets an existing project', async () => {
    const projectPath = path.join(temporaryRoot, 'project');
    await registerProject(projectPath, 'project', env);
    await pauseProject('project', env);
    assert.equal((await readRegistry(env)).projects[0].enabled, false);
    await resumeProject('project', env);
    assert.equal((await readRegistry(env)).projects[0].enabled, true);
    await forgetProject('project', env);
    assert.equal((await readRegistry(env)).projects.length, 0);
  });

  it('reports unknown project IDs instead of false success', async () => {
    await assert.rejects(
      () => pauseProject('missing', env),
      /Project not found/,
    );
  });

  it('updates a moved project path without duplicating the project ID', async () => {
    await registerProject(
      path.join(temporaryRoot, 'old-location'),
      'moved-project',
      env,
    );
    await registerProject(
      path.join(temporaryRoot, 'new-location'),
      'moved-project',
      env,
    );
    const matches = (await readRegistry(env)).projects.filter(
      (project) => project.project_id === 'moved-project',
    );
    assert.equal(matches.length, 1);
    assert.match(matches[0].path, /new-location$/);
  });

  it('keeps hundreds of canonical registry entries distinct', async () => {
    for (let index = 0; index < 250; index += 1) {
      await registerProject(
        path.join(temporaryRoot, `project-${index}`),
        `project-${index}`,
        env,
      );
    }
    const registry = await readRegistry(env);
    assert.equal(
      new Set(registry.projects.map((project) => project.path)).size,
      registry.projects.length,
    );
  });
});
