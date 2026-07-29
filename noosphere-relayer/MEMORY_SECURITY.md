# Noosphere memory security

## What protects project memory

- Walrus Memory applies Seal encryption before blob storage on Walrus.
- The MemWal account on Sui controls owner and delegate access.
- Noosphere verifies the selected Sui network, account state, and registered
  delegate public key before memory operations.
- Each project uses a separate Walrus Memory namespace.
- The local relayer binds to loopback by default.
- Public and non-loopback deployments require bearer authentication.
- Browser access is restricted to configured origins.
- Pending uploads and idempotency receipts use owner-only durable state.

## Trust boundary

The managed Walrus Memory relayer receives plaintext to create embeddings and
apply Seal encryption. It can therefore process memory content before the
encrypted blob is written to Walrus. This is not a zero-knowledge flow with
respect to the managed relayer.

Sui contains ownership and authorization state. Project memory text is not
stored directly on Sui.

## Local state

Pending uploads temporarily exist as plaintext in the local durable queue.
Successful uploads remove the pending record. Protect the host, user account,
credential backend, and runtime volume.

The continuity client may also maintain an owner-local authenticated replay
ledger. The relayer is deliberately unaware of that ledger and exposes no
replay writer, recovery, reset, or key-management endpoint. Replay identity is
based on the authenticated local project, trusted local slot, and normalized
content digest—not relayer ranking, timestamps, IDs, labels, or metadata.
Replay/freshness labels are informational and never authenticate remote
authorship or confer content authority.

The local ledger retains at most 4,096 live records for 90 days. Complete local
replay-root deletion loses replay history. Missing or replaced replay-key
material with surviving state fails closed; the product has no replay-key
reinitialization or repair surface.

## Operational limitations

- Semantic recall is relevance-based, not a complete chronological audit.
- Forgetting a local project does not delete remote memory.
- Demo mode is local plaintext development storage.
- The built-in rate limiter is process-local.
- Automatic checkpoints preserve visible workspace state, not private agent
  reasoning.
- Automatic master-prompt capture stores the complete visible user prompt,
  because summaries cannot preserve future phases exactly. It never captures
  hidden reasoning. Later visible prompts are also stored exactly as ordered
  follow-ups. Disable both per project with
  `privacy.capture_master_prompt: false`.

Use Walrus Memory's manual or self-hosted client flow when the managed relayer
trust boundary is not acceptable.
