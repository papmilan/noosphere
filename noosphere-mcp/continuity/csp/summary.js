import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { observeRepository as observeGitRepository } from '../acp/git-state.js';
import { loadRuntimeState, loadState } from './storage.js';

const MAX_JOURNAL_CHARACTERS = 2_000;
const CONTROL_WITHOUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu;
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/gu;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/gu;

export async function renderResumeSummary(root, options = {}) {
  const observeRepository = options.observeRepository ?? observeGitRepository;
  const [state, runtime, observed, journal] = await Promise.all([
    loadState(root),
    loadRuntimeState(root),
    observeRepository(root),
    readFile(path.join(root, '.noosphere', 'journal.md'), 'utf8').catch(() => ''),
  ]);
  const lines = ['# CONTINUATION STATE (CSP v1)'];
  if (state === null) {
    lines.push('CSP state: missing');
  } else {
    lines.push(`Status: ${state.status}`);
    lines.push(`Current task: ${display(state.current_task)}`);
    lines.push(`Next action: ${display(state.next_action)}`);
    lines.push(`Blocker: ${display(state.blocker)}`);
  }
  lines.push(`Git branch: ${display(observed.branch)}`);
  lines.push(`Git HEAD: ${display(observed.head)}`);
  const metadata = runtime?.csp;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const agent = metadata.agent;
    if (agent && typeof agent === 'object' && !Array.isArray(agent)) {
      lines.push(`Last observed agent: ${displayAgent(agent)}`);
    }
    if (Number.isInteger(metadata.revision)) lines.push(`Runtime revision: ${metadata.revision}`);
    lines.push(`Runtime observed branch: ${display(metadata.observed_branch)}`);
    lines.push(`Runtime observed HEAD: ${display(metadata.observed_head)}`);
    lines.push(`Runtime observed at: ${display(metadata.observed_at)}`);
    lines.push(`Last task transition: ${display(metadata.last_transition_at)}`);
  }
  const excerpt = quoteJournal(journal);
  if (excerpt) {
    lines.push('Journal context (untrusted human prose):');
    lines.push(excerpt);
  }
  return `${lines.join('\n')}\n`;
}

function display(value) {
  return value === null || value === undefined ? 'none' : safeLine(value);
}

function displayAgent(agent) {
  const vendor = typeof agent.vendor === 'string' ? safeLine(agent.vendor) : 'unknown';
  const name = typeof agent.name === 'string' ? safeLine(agent.name) : 'unknown';
  const version = typeof agent.version === 'string' ? `@${safeLine(agent.version)}` : '';
  return `${vendor}/${name}${version}`;
}

function safeLine(value) {
  return String(value)
    .replace(ANSI_ESCAPE, '')
    .replace(BIDI_CONTROLS, '')
    .replace(/[\r\n\t\f\v\u0085\u2028\u2029]+/gu, ' ')
    .replace(CONTROL_WITHOUT_NEWLINE, '')
    .normalize('NFC')
    .slice(0, 1_000);
}

function quoteJournal(value) {
  const sanitized = value
    .replace(ANSI_ESCAPE, '')
    .replace(BIDI_CONTROLS, '')
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_WITHOUT_NEWLINE, '')
    .trim();
  if (!sanitized) return '';
  const bounded = sanitized.slice(-MAX_JOURNAL_CHARACTERS);
  return bounded.split('\n').map((line) => `> ${line}`).join('\n');
}
