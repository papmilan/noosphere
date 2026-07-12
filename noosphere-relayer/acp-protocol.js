import {
  ACP_SCHEMA,
  decodeEnvelope,
} from '@noosphere/acp-protocol';

const REQUIRED_FIELDS = Object.freeze([...ACP_SCHEMA.required]);
const PROTOCOL = ACP_SCHEMA.properties.protocol.const;
const SCHEMA_VERSION = ACP_SCHEMA.properties.schema_version.const;

export function decodeProjectStateEnvelope(input) {
  return decodeEnvelope(input, { construct: validateEnvelopeBoundary });
}

function validateEnvelopeBoundary(envelope) {
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(envelope, field)) {
      return failure(`$.${field}`, 'missing-required-field', `${field} is required`);
    }
  }
  if (envelope.protocol !== PROTOCOL) {
    return failure('$.protocol', 'invalid-protocol', `protocol must be ${PROTOCOL}`);
  }
  if (envelope.schema_version !== SCHEMA_VERSION) {
    return failure('$.schema_version', 'unsupported-version', `schema_version must be ${SCHEMA_VERSION}`);
  }
  return { ok: true, envelope };
}

function failure(path, code, message) {
  return { ok: false, errors: [{ path, code, message }] };
}
