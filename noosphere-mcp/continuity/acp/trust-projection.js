const REPOSITORY_REFERENCE_KINDS = new Set(['file', 'commit', 'command', 'test']);
const ASSERTION_COLLECTIONS = [
  'plan', 'completed_work', 'decisions', 'evidence', 'assumptions',
  'rejected_approaches', 'unknowns', 'blockers', 'risks', 'next_actions',
];

export function projectAdvancedTrust(state) {
  const envelope = state.envelope;
  const assertionIds = ASSERTION_COLLECTIONS.flatMap((name) =>
    (envelope[name] || [])
      .filter((item) => item.repository_fingerprint !== null)
      .map((item) => item.id));
  return Object.freeze({
    trustDowngrade: 1,
    nonAuthoritativeAssertionIds: Object.freeze([...new Set(assertionIds)].sort()),
    nonAuthoritativeReferenceIds: Object.freeze((envelope.references || [])
      .filter((item) => REPOSITORY_REFERENCE_KINDS.has(item.kind))
      .map((item) => item.id).sort()),
    nonAuthoritativeNextActionIds: Object.freeze((envelope.next_actions || [])
      .map((item) => item.id).sort()),
  });
}
