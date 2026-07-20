import { InMemoryProjectMemoryRepository } from '../../noosphere-remote-mcp/index.js';
import { defineParitySuite } from './parity-suite.js';

// Run the shared behavioural contract against the in-memory reference. This
// proves the suite itself is faithful before it judges the Postgres adapter.
defineParitySuite({
  label: 'in-memory reference',
  createRepository: async () => ({ repository: new InMemoryProjectMemoryRepository() }),
});
