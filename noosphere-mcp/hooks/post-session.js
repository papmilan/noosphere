#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { normalizeUntrusted, quoteUntrustedMemory } from '../continuity/memory-safety.js';
import { secureRelayerFetch } from '../continuity/relayer-authority.js';
import {
  appendRepositoryFile,
  readBoundedRegularFile,
  readBoundedRegularFileTail,
} from '../continuity/secure-fs.js';

const MAX_HOOK_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_SUMMARY_CHARS = 16_000;
const MAX_PROJECT_ID_CHARS = 200;
const DEFAULT_HOOK_TIMEOUT_SECONDS = 45;
const MAX_HOOK_TIMEOUT_MS = 55_000;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let total = 0;
  let oversized = false;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_HOOK_INPUT_BYTES) {
      oversized = true;
      chunks.length = 0;
      continue;
    }
    if (!oversized) chunks.push(bytes);
  }
  if (oversized) {
    process.stderr.write(
      `Noosphere hook: input exceeded ${MAX_HOOK_INPUT_BYTES} bytes; using process context instead.\n`,
    );
    return '';
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readJsonLines(file) {
  if (typeof file !== 'string' || file.length === 0) return [];
  try {
    const bytes = await readBoundedRegularFileTail(file, {
      maxBytes: MAX_HOOK_INPUT_BYTES,
    });
    const raw = bytes?.toString('utf8') ?? '';
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(safeParseJson)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function lastCwdFromTranscript(transcriptPath) {
  const entries = await readJsonLines(transcriptPath);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const cwd = entries[index]?.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  }
  return '';
}

async function lastAssistantTextFromTranscript(transcriptPath) {
  const entries = await readJsonLines(transcriptPath);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((segment) => segment?.type === 'text' && typeof segment.text === 'string')
      .map((segment) => segment.text)
      .filter((segment) => segment.trim())
      .join('\n');
    if (text.trim()) return text;
  }
  return '';
}

async function resolveProjectConfig(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.noosphere', 'config.json'),
    path.join(projectRoot, '.noosphere.json'),
  ];
  for (const candidate of candidates) {
    let raw;
    try {
      raw = await readBoundedRegularFile(candidate, {
        maxBytes: MAX_HOOK_INPUT_BYTES,
        root: projectRoot,
      });
    } catch (error) {
      return { config: null, error, found: true };
    }
    if (raw === null) continue;
    const parsed = safeParseJson(raw.toString('utf8'));
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      return {
        config: null,
        error: new Error(`project configuration is not valid JSON: ${candidate}`),
        found: true,
      };
    }
    return { config: parsed, error: null, found: true };
  }
  return { config: null, error: null, found: false };
}

function findGitRoot(start) {
  if (typeof start !== 'string' || start.length === 0) return '';
  try {
    return execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function nowSessionId() {
  return new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+/, '');
}

function safeProjectId(value, projectRoot) {
  const candidate = typeof value === 'string' && value.trim()
    ? value
    : path.basename(projectRoot);
  const normalized = normalizeUntrusted(candidate)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROJECT_ID_CHARS);
  return normalized || 'project';
}

function safeSessionId(value) {
  const candidate = typeof value === 'string' && value.length > 0
    ? value
    : nowSessionId();
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(candidate)) return candidate;
  return `sha256-${sha256(candidate).slice(0, 32)}`;
}

function boundedSummary(value, projectId) {
  const fallback = `Claude Code session completed for project ${projectId}.`;
  const normalized = normalizeUntrusted(value || fallback).trim() || fallback;
  if (normalized.length <= MAX_SESSION_SUMMARY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_SESSION_SUMMARY_CHARS)}\n[truncated]`;
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function gitPosition(projectRoot) {
  try {
    const head = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const branch = execFileSync('git', ['-C', projectRoot, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['-C', projectRoot, 'status', '--porcelain=v1'], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).length > 0;
    return `Git: \`${head.slice(0, 12)}\` on \`${safeMarkdownInline(branch || 'detached HEAD')}\`${dirty ? ' (dirty)' : ''}.`;
  } catch {
    return '';
  }
}

function safeMarkdownInline(value) {
  return normalizeUntrusted(value).replace(/[\r\n`]/g, ' ').slice(0, 200);
}

function sessionJournalEntry({ projectRoot, projectId, sessionId, summary }) {
  const marker = `<!-- noosphere:claude-session:${sha256(`${projectRoot}\0${sessionId}`)} -->`;
  const position = gitPosition(projectRoot);
  const entry = [
    `## ${new Date().toISOString()} — claude-code / session-handoff`,
    '',
    `Project: ${safeMarkdownInline(projectId)}`,
    ...(position ? [position] : []),
    marker,
    '',
    quoteUntrustedMemory(summary, { maxLength: MAX_SESSION_SUMMARY_CHARS + 20 }),
    '',
  ].join('\n');
  return { marker, entry };
}

async function journalSession(projectRoot, projectId, sessionId, summary) {
  const { marker, entry } = sessionJournalEntry({
    projectRoot,
    projectId,
    sessionId,
    summary,
  });
  const result = await appendRepositoryFile(
    path.join(projectRoot, '.noosphere', 'journal.md'),
    entry,
    {
      root: projectRoot,
      maxBytes: MAX_JOURNAL_BYTES,
      skipIfContains: marker,
    },
  );
  if (result.appended) {
    process.stdout.write('✓ Session journaled locally in Noosphere\n');
  } else {
    process.stdout.write('✓ Session already journaled in Noosphere\n');
  }
}

function hookTimeoutMs() {
  const seconds = Number(process.env.NOOSPHERE_HOOK_TIMEOUT_SECONDS);
  const selected = Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_HOOK_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(MAX_HOOK_TIMEOUT_MS, Math.round(selected * 1000)));
}

function actionsUrl(relayerUrl) {
  const url = new URL(String(relayerUrl));
  url.hash = '';
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/actions`;
  return url.href;
}

async function uploadSession(relayerUrl, payload, sessionId) {
  try {
    const response = await secureRelayerFetch(actionsUrl(relayerUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `claude-code-${sessionId}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(hookTimeoutMs()),
    });
    if (response.ok) {
      process.stdout.write('✓ Session stored in Noosphere\n');
      return;
    }
    const body = await response.text().catch(() => '');
    process.stderr.write(
      `Noosphere hook: upload failed (${response.status}) at ${new URL(relayerUrl).origin}.\n`,
    );
    if (body) process.stderr.write(`${body}\n`);
  } catch (error) {
    process.stderr.write(`Noosphere hook: upload skipped (${error.message}).\n`);
  }
}

async function main() {
  const stdinRaw = await readStdin();
  const hookInput = safeParseJson(stdinRaw) || {};
  const startDirectory =
    (typeof hookInput.cwd === 'string' && hookInput.cwd) ||
    (await lastCwdFromTranscript(hookInput.transcript_path)) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const projectRoot = findGitRoot(startDirectory);
  if (!projectRoot) {
    process.stdout.write('Noosphere not activated; session skipped.\n');
    return;
  }

  const resolvedConfig = await resolveProjectConfig(projectRoot);
  if (!resolvedConfig.found) {
    process.stdout.write('Noosphere not activated; session skipped.\n');
    return;
  }

  const config = resolvedConfig.config || {};
  const projectId = safeProjectId(config.project_id, projectRoot);
  const sessionId = safeSessionId(hookInput.session_id);
  let rawSummary = process.env.CLAUDE_SESSION_SUMMARY || '';
  if (!rawSummary) {
    rawSummary = await lastAssistantTextFromTranscript(hookInput.transcript_path);
  }
  // Never use ~/.claude/sessions/latest.json here. It is global, so when the
  // hook has no usable transcript it can belong to a different project.
  const summary = boundedSummary(rawSummary, projectId);

  let journalError = null;
  try {
    await journalSession(projectRoot, projectId, sessionId, summary);
  } catch (error) {
    journalError = error;
    // SessionEnd cannot block termination, but a non-zero result makes Claude
    // Code show the failure instead of presenting an optional upload as success.
    process.stderr.write(`Noosphere hook: local journal failed (${error.message}).\n`);
    process.exitCode = 1;
  }

  if (resolvedConfig.error) {
    process.stderr.write(
      `Noosphere hook: ${resolvedConfig.error.message}; remote upload skipped.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const relayerUrl =
    config.relayer_url ||
    process.env.NOOSPHERE_RELAYER_URL ||
    'http://127.0.0.1:3001';
  if (config.privacy?.share_journal === false) {
    if (journalError === null) {
      process.stdout.write('Session journal kept local by Noosphere privacy settings.\n');
    } else {
      process.stderr.write('Noosphere hook: remote upload disabled by project privacy settings.\n');
    }
    return;
  }
  await uploadSession(relayerUrl, {
    project_id: projectId,
    agent_id: 'claude-code',
    action_type: 'session',
    content: summary,
    session_id: sessionId,
    provider: 'Anthropic',
    model: 'claude-code',
    client: 'CLI',
  }, sessionId);
}

// Hooks must never prevent Claude Code from ending a session.
main().catch((error) => {
  process.stderr.write(`Noosphere hook: unexpected error: ${error.message}\n`);
  process.exitCode = 1;
});
