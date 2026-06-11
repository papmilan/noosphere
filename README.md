# Noosphere

The shared mind for AI agents.

Noosphere gives AI agents a common project memory that survives switches
between CLIs, IDEs, models, and sessions. An agent can store a decision once,
and another agent can retrieve it later through files, CLI commands, HTTP, or
the Model Context Protocol.

Noosphere is built on
[Walrus Memory](https://docs.wal.app/walrus-memory/getting-started/what-is-walrus-memory)
for encrypted storage and semantic recall.

## What it provides

- A portable format for decisions, findings, code changes, and handoffs
- Automatic checkpoints when the working tree changes
- A refreshed project context file for tools without MCP support
- Semantic recall instead of repeatedly loading an entire project history
- Optional, privacy-aware output evaluation
- HTTP and browser interfaces for universal compatibility
- Configuration for the official Walrus Memory MCP server

## Architecture

```text
AI agent, CLI, IDE, or web UI
              |
              v
     Noosphere memory record
              |
              v
 Official Walrus Memory SDK / MCP
              |
              +-- Seal encryption
              +-- Walrus blob storage
              +-- Semantic indexing and recall
              +-- Sui account ownership and delegate permissions
```

Walrus stores the encrypted project memories. Sui provides ownership and
delegate access control through Walrus Memory. Noosphere does not require a
custom smart contract.

Optional AI evaluations are stored as inspectable metadata beside a memory.
They are not presented as trustless consensus or immutable on-chain
reputation.

## Run locally

Requirements:

- Node.js 22 or newer
- npm

Install and start the local demo:

```sh
cd noosphere-relayer
npm install
npm run demo
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001).

Demo mode uses a gitignored local persistence file. To connect Walrus Memory:

1. Copy `noosphere-relayer/.env.example` to
   `noosphere-relayer/.env`.
2. Create delegate credentials in the
   [Walrus Memory dashboard](https://memory.walrus.xyz/).
3. Set `MEMWAL_PRIVATE_KEY` and `MEMWAL_ACCOUNT_ID`.
4. Set `MEMWAL_NETWORK=mainnet` or `testnet` to match the account.
5. Set `DEMO_MODE=false`.

Noosphere validates the account object and registered delegate key on the
selected Sui network before storing or recalling memory. The matching Walrus
Memory relayer URL is selected automatically.

The relayer binds to `127.0.0.1` by default. For a public deployment, set
`HOST=0.0.0.0`, generate `NOOSPHERE_API_TOKEN` with
`openssl rand -hex 32`, and configure exact `CORS_ORIGINS`. Production startup
fails closed when the API token is missing. CLI tools and hooks read the token
from the `NOOSPHERE_API_TOKEN` environment variable. Production and
non-loopback modes never permit the local authentication bypass.

Every action is written to a permission-restricted local pending queue before
upload. Temporary Walrus failures are retried with exponential backoff, and
pending writes plus idempotency receipts survive process restarts. Successful
memory content remains in Walrus; the local pending entry is removed.

## Enable continuity

Install the user lifecycle once on macOS, Linux, or Windows:

```sh
npm --prefix noosphere-mcp run install:user
~/.noosphere/bin/noosphere setup
```

The installer copies a self-contained runtime to `~/.noosphere`, adds the
`noosphere` command, and installs per-user background services. The relayer
starts at login. A single project manager starts and supervises one watcher
for every canonical registered repository.

Shell integration for zsh, bash, fish, and PowerShell automatically activates
the Git repository whenever a terminal enters it. For projects opened only
through a GUI IDE, open `http://127.0.0.1:3001/#projects`, paste the repository
path, and click **Add project**, or run:

```sh
noosphere register --path /absolute/path/to/repository
```

Noosphere does not scan the whole computer. First registration creates the
project files and registers the repository; later registrations are
idempotent. Each repository gets its own project ID and Walrus namespace.
Add `.noosphere-ignore` to a repository to opt out, or run
`noosphere deactivate`.

`noosphere setup` validates the MemWal account and registered delegate on Sui
before storing credentials in the operating-system credential store. It can
optionally perform a real Walrus store/recall verification. Existing plaintext
credentials can be migrated with `noosphere credentials migrate`.

The watcher fingerprints the Git working tree. After eight quiet seconds, it
stores a metadata-only checkpoint and refreshes `.noosphere/context.md` so
the next agent can continue from the latest shared state. No manual watcher
command is required after installation.

## Connect agents

The universal protocol is documented in `NOOSPHERE.md`. Agents can use:

- `.noosphere/context.md` for current shared context
- `.noosphere/journal.md` for concise decisions and handoffs
- `noosphere context`, `recall`, `remember`, and `journal` CLI commands
- `POST /v1/actions` to store memory
- `POST /v1/projects/:project_id/recall` for semantic recall
- `GET /v1/projects/:project_id/bootstrap` for prompt-ready instructions
- The official Walrus Memory MCP server

Example MCP command:

```sh
npx -y @mysten-incubation/memwal-mcp@0.0.4 \
  --staging \
  --namespace noosphere-<project>
```

Small adapters for Claude, Cursor, Codex, Gemini, and other tools only point
back to the same universal protocol. They do not create separate memory
systems.

## Privacy

Automatic checkpoints contain changed paths, the current branch and commit,
diff statistics, and a timestamp. Raw source diffs are not uploaded by
default.

Noosphere never asks agents to reveal hidden chain-of-thought. Agents record
short, externally understandable conclusions, evidence, failed approaches,
and handoffs instead.

Remote output evaluation is disabled by default. Enabling
`SCORING_MODE=remote` sends the action and recalled context to the configured
AI provider.

See:

- `noosphere-relayer/TRUST.md` for the trust model
- `docs/PRIVACY.md` for data handling and retention
- `docs/DEPLOYMENT.md` for installation, TLS, backup, and recovery

## Packages

- `noosphere-relayer`: HTTP API, Walrus Memory adapter, optional evaluation,
  and browser interface
- `noosphere-mcp`: continuity watcher, CLI, universal project integration,
  MCP configuration, and optional Claude session hook

## Verification

```sh
cd noosphere-relayer
npm run check
npm test

cd ../noosphere-mcp
npm run check
npm test
```

For public deployments, verify authenticated access as well:

```sh
NODE_ENV=production HOST=0.0.0.0 npm start
curl -H "Authorization: Bearer $NOOSPHERE_API_TOKEN" \
  "http://127.0.0.1:3001/v1/projects/<project>/context?q=status"
```

The relayer also includes a non-root production container:

```sh
docker build -t noosphere-relayer noosphere-relayer
docker run --rm -p 3001:3001 \
  --env-file noosphere-relayer/.env \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -v noosphere-state:/app/.noosphere-runtime \
  noosphere-relayer
```

Set `NOOSPHERE_API_TOKEN` and deployment-specific `CORS_ORIGINS` before
starting the container.
