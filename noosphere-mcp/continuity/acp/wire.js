import {
  canonicalize,
  decodeEnvelope as decodeWireEnvelope,
  digestEnvelope,
  encodeEnvelope,
} from '@noosphere/acp-protocol';
import { createProjectState } from './project-state.js';

export { canonicalize, digestEnvelope, encodeEnvelope };
export const decodeEnvelope = (input, options = {}) =>
  decodeWireEnvelope(input, { ...options, construct: createProjectState });
