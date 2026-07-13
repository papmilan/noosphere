import { createProjectState, decodeEnvelope } from '@noosphere/acp-protocol';

export function decodeProjectStateEnvelope(input) {
  const decoded = decodeEnvelope(input, {
    construct: (envelope) => createProjectState(envelope, { clock: envelope.created_at }),
  });
  if (!decoded.ok) return decoded;
  return { ok: true, envelope: decoded.state.envelope };
}
