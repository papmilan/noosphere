import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXECUTION_PROTOCOL,
  createExecutionState,
} from '../continuity/acp/execution-state.js';

const CREATED_AT = '2026-07-13T00:00:00.000Z';
const EXPIRES_AT = '2026-07-16T00:00:00.000Z';
const SNAPSHOT = `sha256:${'a'.repeat(64)}`;

function validEnvelope(overrides = {}) {
  return {
    protocol: EXECUTION_PROTOCOL,
    project_snapshot_id: SNAPSHOT,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    origin: { agent_id: 'claude', client: 'claude-code', session_id: null },
    repository: {
      project_id: 'noosphere',
      head: 'b'.repeat(40),
      branch: 'main',
      dirty: false,
      workspace_fingerprint: `sha256:${'c'.repeat(64)}`,
    },
    cursor: {
      step_id: 's2',
      status: 'before-edit',
      opened_files: ['continuity/acp/render.js'],
      target: { file: 'continuity/acp/render.js', symbol: 'renderKernel', purpose: 'Add the advisory header.' },
    },
    steps: [
      {
        id: 's1',
        parent_step_id: null,
        kind: 'task',
        status: 'done',
        target: { file: 'continuity/acp/execution-state.js', symbol: null, content_hash: `sha256:${'d'.repeat(64)}` },
        goal: 'Create the domain object.',
        verify: { command: 'node --test tests/acp-execution-state.test.js', expectation: 'all pass' },
      },
      {
        id: 's2',
        parent_step_id: 's1',
        kind: 'edit',
        status: 'current',
        target: { file: 'continuity/acp/render.js', symbol: 'renderKernel', content_hash: null },
        goal: 'Render the advisory kernel.',
        verify: { command: 'node --test tests/acp-execution-render.test.js', expectation: 'all pass' },
      },
    ],
    frontier: {
      searched: [{ query: 'renderKernel', scope: 'continuity/acp', finding: 'one call site in store.js' }],
      ruled_out: [{ hypothesis: 'reuse project kernel renderer', evidence: 'budget and framing differ' }],
    },
    validation: {
      last_command: 'npm --prefix noosphere-mcp run check',
      last_result: 'pass',
      failing_tests: [],
      expected_after_next_step: 'render test goes red then green',
    },
    working_notes: [
      { text: 'Reuse oneLine() from render.js for sanitization.', created_at: CREATED_AT, expires_at: EXPIRES_AT },
    ],
    integrity: {
      algorithm: 'sha256',
      digest: '0'.repeat(64),
      signature: { status: 'unsigned', algorithm: null, key_id: null, value: null },
    },
    ...overrides,
  };
}

function errorCodes(result) {
  return result.errors.map(({ code }) => code);
}

describe('ACP execution state invariants', () => {
  it('constructs and deep-freezes a valid execution state', () => {
    const result = createExecutionState(validEnvelope(), { clock: CREATED_AT });
    assert.equal(result.ok, true, JSON.stringify(result.errors ?? []));
    assert.ok(Object.isFrozen(result.state));
    assert.ok(Object.isFrozen(result.state.envelope.steps[0]));
    assert.equal(result.state.runtime.byId.s2.status, 'current');
    assert.equal(result.state.runtime.currentStep.id, 's2');
    assert.throws(() => {
      result.state.envelope.steps[0].status = 'pending';
    }, TypeError);
  });

  it('rejects duplicate step ids', () => {
    const envelope = validEnvelope();
    envelope.steps[1] = { ...envelope.steps[1], id: 's1' };
    envelope.cursor = { ...envelope.cursor, step_id: 's1' };
    const result = createExecutionState(envelope, { clock: CREATED_AT });
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('duplicate-id'));
  });

  it('rejects a dangling cursor step and a dangling parent', () => {
    const danglingCursor = createExecutionState(
      validEnvelope({ cursor: { ...validEnvelope().cursor, step_id: 'missing' } }),
      { clock: CREATED_AT },
    );
    assert.equal(danglingCursor.ok, false);
    assert.ok(errorCodes(danglingCursor).includes('dangling-step'));

    const envelope = validEnvelope();
    envelope.steps[1] = { ...envelope.steps[1], parent_step_id: 'missing' };
    const danglingParent = createExecutionState(envelope, { clock: CREATED_AT });
    assert.equal(danglingParent.ok, false);
    assert.ok(errorCodes(danglingParent).includes('dangling-step'));
  });

  it('requires expires_at', () => {
    const result = createExecutionState(validEnvelope({ expires_at: null }), { clock: CREATED_AT });
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('missing-expiry'));
  });

  it('rejects fenced code blocks anywhere as payload-forbidden', () => {
    const envelope = validEnvelope();
    envelope.steps[1] = { ...envelope.steps[1], goal: 'Apply this:\n```js\nrm -rf /\n```' };
    const result = createExecutionState(envelope, { clock: CREATED_AT });
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('payload-forbidden'));
  });

  it('rejects diff and patch syntax as payload-forbidden', () => {
    const envelope = validEnvelope();
    envelope.working_notes = [
      { text: '@@ -1,3 +1,3 @@ replace the guard', created_at: CREATED_AT, expires_at: EXPIRES_AT },
    ];
    const result = createExecutionState(envelope, { clock: CREATED_AT });
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('payload-forbidden'));
  });

  it('rejects multi-line prose as payload-forbidden', () => {
    const envelope = validEnvelope();
    envelope.cursor = {
      ...envelope.cursor,
      target: { ...envelope.cursor.target, purpose: 'line1\nline2\nline3\nline4\nline5' },
    };
    const result = createExecutionState(envelope, { clock: CREATED_AT });
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('payload-forbidden'));
  });

  it('enforces the structural bounds', () => {
    const step = validEnvelope().steps[0];
    const manySteps = Array.from({ length: 65 }, (_, index) => ({
      ...step,
      id: `s${index}`,
      parent_step_id: null,
      status: index === 0 ? 'current' : 'pending',
    }));
    const tooManySteps = createExecutionState(
      validEnvelope({ steps: manySteps, cursor: { ...validEnvelope().cursor, step_id: 's0' } }),
      { clock: CREATED_AT },
    );
    assert.equal(tooManySteps.ok, false);
    assert.ok(errorCodes(tooManySteps).includes('too-many-items'));

    const longCommand = validEnvelope();
    longCommand.steps[0] = {
      ...longCommand.steps[0],
      verify: { command: 'x'.repeat(201), expectation: 'ok' },
    };
    const commandCap = createExecutionState(longCommand, { clock: CREATED_AT });
    assert.equal(commandCap.ok, false);
    assert.ok(errorCodes(commandCap).includes('text-too-long'));

    const notes = Array.from({ length: 9 }, () => ({
      text: 'note', created_at: CREATED_AT, expires_at: EXPIRES_AT,
    }));
    const tooManyNotes = createExecutionState(validEnvelope({ working_notes: notes }), { clock: CREATED_AT });
    assert.equal(tooManyNotes.ok, false);
    assert.ok(errorCodes(tooManyNotes).includes('too-many-items'));
  });

  it('rejects forbidden private-reasoning keys recursively', () => {
    const envelope = validEnvelope();
    envelope.frontier = {
      ...envelope.frontier,
      searched: [{ query: 'x', scope: 'y', finding: 'z', hidden_reasoning: 'secret' }],
    };
    const result = createExecutionState(envelope, { clock: CREATED_AT });
    assert.equal(result.ok, false);
    assert.ok(errorCodes(result).includes('forbidden-key'));
  });

  it('rejects an unknown protocol and invalid enums', () => {
    const badProtocol = createExecutionState(validEnvelope({ protocol: 'acp.other/9' }), { clock: CREATED_AT });
    assert.equal(badProtocol.ok, false);

    const envelope = validEnvelope();
    envelope.cursor = { ...envelope.cursor, status: 'meditating' };
    const badStatus = createExecutionState(envelope, { clock: CREATED_AT });
    assert.equal(badStatus.ok, false);
    assert.ok(errorCodes(badStatus).includes('invalid-enum'));
  });

  it('produces byte-identical error output for equal input', () => {
    const envelope = validEnvelope({ expires_at: null });
    const first = createExecutionState(envelope, { clock: CREATED_AT });
    const second = createExecutionState(structuredClone(envelope), { clock: CREATED_AT });
    assert.deepEqual(first, second);
  });
});
