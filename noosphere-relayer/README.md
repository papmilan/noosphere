# noosphere-relayer

Local-file or Walrus Memory relay server for
[Noosphere](https://github.com/papmilan/noosphere) cross-agent project memory.

The relayer is the HTTP side of Noosphere: agents and the `noosphere` CLI
store and recall project memory through it, it keeps a restart-safe durable
queue in front of the configured backend, and it provides the durable index
that ACP exact-state synchronization depends on.

## Quick start

Requires Node.js 22 or newer.

```sh
npm install
npm run demo
```

Demo mode stores memories in a gitignored local JSON file on this machine —
no credentials needed, no cross-machine memory.

To use Walrus Memory instead:

```sh
cp env.example .env
```

Create or manage credentials in the
[Walrus Memory dashboard](https://memory.walrus.xyz/), then set:

```dotenv
MEMWAL_NETWORK=mainnet
MEMWAL_ACCOUNT_ID=0x...
MEMWAL_PRIVATE_KEY=...
NOOSPHERE_MEMORY_BACKEND=walrus-memory
DEMO_MODE=false
```

Start with `npm start`. The relayer validates the Sui account, its active
state, and the registered delegate key before serving memory operations.

## HTTP surface

Memory:

- `POST /v1/actions` — store a memory (idempotent via `Idempotency-Key`)
- `POST /v1/projects/:project_id/recall` — semantic recall
- `GET /v1/projects/:project_id/recall?q=…` — the same recall over a query
  string, with optional `limit` and `action_type`
- `GET /v1/projects/:project_id/context` — prompt-ready context
- `GET /v1/projects/:project_id/bootstrap` — instructions plus current context
  for any HTTP-capable agent

ACP exact state (see the
[protocol reference](https://github.com/papmilan/noosphere/blob/main/docs/ACP.md)):

- `GET /v1/acp/capabilities` — deployment mode, durability, quotas, and the
  server-owned `relayer_index_id`
- `/v1/projects/{project_id}/acp/snapshots[/{snapshot_id}]`
- `/v1/projects/{project_id}/acp/heads`
- `/v1/projects/{project_id}/acp/history`

Local project control (loopback only — every route below answers `404` to a
non-loopback caller):

- `GET`/`POST /v1/local/projects` — list and register watched projects
- `GET /v1/local/projects/state` — last checkpoint, pending upload count, and
  latest failure per project
- `POST /v1/local/projects/:project_id/{pause,resume,retry,forget}`
- `GET /v1/local/credentials/status` — configured memory backend and account
- `POST /v1/local/credentials/setup` — select a backend and store credentials

Discovery: `GET /.well-known/noosphere.json`, `/openapi.json`, `/health`,
`/ready`.

## Reliability

- writes enter an atomic durable queue before upload;
- idempotency receipts survive restarts;
- temporary failures use exponential backoff and respect upstream cooldowns;
- explicit user memories are prioritized before background checkpoints;
- readiness exposes pending jobs and the next upload slot.

## Security and deployment

The relayer binds to `127.0.0.1` by default. Public or non-loopback
deployments fail closed unless `NOOSPHERE_API_TOKEN` is set, and browser
access is restricted to configured `CORS_ORIGINS`.

The managed Walrus Memory relayer receives plaintext to create embeddings and
apply Seal encryption before blobs reach Walrus storage — it is part of the
trust boundary, not a zero-knowledge flow.

Full details in the repository:

- [Memory security boundary](https://github.com/papmilan/noosphere/blob/main/noosphere-relayer/MEMORY_SECURITY.md)
- [Deployment, TLS, backup, recovery](https://github.com/papmilan/noosphere/blob/main/docs/DEPLOYMENT.md)
- [Privacy and data handling](https://github.com/papmilan/noosphere/blob/main/docs/PRIVACY.md)

## Development

```sh
npm run check
npm test
npm run test:live   # real Walrus store and recall, kept out of routine tests
```

`vendor/acp-protocol/` is a mirror of the repository's shared protocol
package for the Docker build context; parity with the source is enforced by
the noosphere-mcp distribution test.
