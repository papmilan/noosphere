import { PROJECT_MEMORY_SCHEMA_VERSION } from '../index.js';

export const timestamp = '2026-07-19T12:00:00.000Z';

export function validProject(overrides = {}) {
  return {
    id: 'prj_01j3bicycle',
    schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
    name: 'Bicycle Repair',
    normalized_name: 'bicycle repair',
    description: 'Repair the hydraulic brake.',
    category: 'personal-task',
    status: 'active',
    aliases: ['bike brakes'],
    created_at: timestamp,
    updated_at: timestamp,
    last_activity_at: timestamp,
    latest_checkpoint_id: null,
    ...overrides,
  };
}

export function validSession(overrides = {}) {
  return {
    id: 'ses_01j3bicycle',
    schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
    project_id: 'prj_01j3bicycle',
    source_client: 'chatgpt',
    source_model: 'gpt-test',
    status: 'active',
    source_conversation_reference: null,
    metadata: {
      entries: [{ key: 'locale', value: { kind: 'string', value: 'en' } }],
    },
    created_at: timestamp,
    updated_at: timestamp,
    latest_checkpoint_id: null,
    ...overrides,
  };
}

export function validCheckpoint(overrides = {}) {
  return {
    id: 'chk_01j3bicycle',
    schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
    project_id: 'prj_01j3bicycle',
    session_id: 'ses_01j3bicycle',
    revision: 1,
    previous_checkpoint_id: null,
    goal: 'Restore reliable braking.',
    current_status: 'Rotor and pads are checked; hydraulic diagnosis remains.',
    established_facts: ['Rotor is within specification.', 'Pads have usable material.'],
    decisions: ['Inspect the hydraulic line before replacing parts.'],
    rejected_options: ['Do not replace the rotor yet.'],
    assumptions: ['The lever has not been recently serviced.'],
    constraints: ['Use only the owner-provided tools.'],
    completed_work: ['Measured rotor and inspected pads.'],
    unresolved_questions: ['Is there air in the line?'],
    blockers: [],
    next_actions: ['Inspect for air in the hydraulic line.'],
    verification_or_evidence: ['Measured rotor thickness against manufacturer specification.'],
    source_summary: 'User-visible discussion summary supplied by the client.',
    source: { client: 'chatgpt', model: 'gpt-test' },
    created_at: timestamp,
    ...overrides,
  };
}
