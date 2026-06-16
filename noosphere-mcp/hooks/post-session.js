#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';

const HOOK_TIMEOUT_SECONDS = Number(
  process.env.NOOSPHERE_HOOK_TIMEOUT_SECONDS || 130,
);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
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
  try {
    const raw = await readFile(file, 'utf8');
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
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  const entries = await readJsonLines(transcriptPath);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const cwd = entries[index]?.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  }
  return '';
}

async function lastAssistantTextFromTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  const entries = await readJsonLines(transcriptPath);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'assistant') continue;
    const segments = entry.message?.content || [];
    for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
      const segment = segments[segmentIndex];
      if (segment?.type === 'text' && typeof segment.text === 'string' && segment.text.trim()) {
        return segment.text;
      }
    }
  }
  return '';
}

async function summaryFromLatestSession() {
  const sessionDir = path.join(os.homedir(), '.claude', 'sessions');
  const candidates = [path.join(sessionDir, 'latest.json')];
  if (existsSync(sessionDir)) {
    try {
      const files = readdirSync(sessionDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(sessionDir, name));
      files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (files[0]) candidates.push(files[0]);
    } catch {
      // Ignore — best-effort fallback.
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const parsed = safeParseJson(await readFile(candidate, 'utf8').catch(() => ''));
    const summary = parsed?.summary || parsed?.session_summary || parsed?.last_assistant_message;
    if (typeof summary === 'string' && summary.trim()) return summary;
  }
  return '';
}

async function resolveProjectConfig(projectDir) {
  const candidates = [
    path.join(projectDir, '.noosphere', 'config.json'),
    path.join(projectDir, '.noosphere.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const parsed = safeParseJson(await readFile(candidate, 'utf8').catch(() => ''));
    if (parsed) return parsed;
  }
  return null;
}

function nowSessionId() {
  return new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+/, '');
}

async function main() {
  const stdinRaw = await readStdin();
  const hookInput = safeParseJson(stdinRaw) || {};
  let projectDir =
    hookInput.cwd ||
    (await lastCwdFromTranscript(hookInput.transcript_path)) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  const config = await resolveProjectConfig(projectDir);
  const projectId = config?.project_id || path.basename(projectDir);
  const relayerUrl =
    config?.relayer_url ||
    process.env.NOOSPHERE_RELAYER_URL ||
    'http://127.0.0.1:3001';
  const sessionId = hookInput.session_id || nowSessionId();

  let summary = process.env.CLAUDE_SESSION_SUMMARY || '';
  if (!summary) {
    summary = await lastAssistantTextFromTranscript(hookInput.transcript_path);
  }
  if (!summary) {
    summary = await summaryFromLatestSession();
  }
  if (!summary) {
    summary = `Claude Code session completed for project ${projectId}.`;
  }

  const payload = {
    project_id: projectId,
    agent_id: 'claude-code',
    action_type: 'session',
    content: summary,
    session_id: sessionId,
    provider: 'Anthropic',
    model: 'claude-code',
    client: 'CLI',
  };

  const headers = {
    'content-type': 'application/json',
    'idempotency-key': `claude-code-${sessionId}`,
  };
  if (process.env.NOOSPHERE_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.NOOSPHERE_API_TOKEN}`;
  }

  try {
    const response = await fetch(`${relayerUrl}/v1/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HOOK_TIMEOUT_SECONDS * 1000),
    });
    if (response.ok) {
      process.stdout.write('✓ Session stored in Noosphere\n');
      return;
    }
    const body = await response.text().catch(() => '');
    process.stderr.write(
      `Noosphere hook: upload failed (${response.status}). Is the relayer running at ${relayerUrl}?\n`,
    );
    if (body) process.stderr.write(`${body}\n`);
  } catch (error) {
    process.stderr.write(
      `Noosphere hook: upload failed (${error.message}). Is the relayer running at ${relayerUrl}?\n`,
    );
  }
}

// Hooks must never prevent Claude Code from ending a session.
main().catch((error) => {
  process.stderr.write(`Noosphere hook: unexpected error: ${error.message}\n`);
});
