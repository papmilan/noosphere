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

## Operational limitations

- Semantic recall is relevance-based, not a complete chronological audit.
- Forgetting a local project does not delete remote memory.
- Demo mode is local plaintext development storage.
- The built-in rate limiter is process-local.
- Automatic checkpoints preserve visible workspace state, not private agent
  reasoning.

Use Walrus Memory's manual or self-hosted client flow when the managed relayer
trust boundary is not acceptable.
