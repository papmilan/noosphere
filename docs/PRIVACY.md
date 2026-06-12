# Noosphere privacy and data handling

## Data path

The managed Walrus Memory relayer receives plaintext memory content so it can
create embeddings and apply Seal encryption. It then stores encrypted blobs on
Walrus. This is not client-side, zero-knowledge encryption with respect to the
managed relayer.

Sui provides MemWal account ownership and delegate authorization. No project
memory text is stored directly on Sui.

## Automatic checkpoints

Automatic checkpoints are metadata-only by default. They contain changed file
paths, branch and commit information, diff statistics, and a timestamp. Raw
source diffs are uploaded only when `privacy.include_diff` is explicitly set to
`true` in `.noosphere/config.json`.

## Temporary local plaintext

Pending uploads are stored temporarily in the owner-only durable queue until
Walrus confirms storage. Protect the host and runtime-state volume. A successful
upload removes the pending plaintext entry.

## Recall limitations

Recall is semantic and returns relevant records. It is not guaranteed to return
every record or produce a complete chronological audit log.

## Retention and deletion

Noosphere does not currently provide selective deletion or rewriting of
individual Walrus Memory records. Forgetting a project removes it only from the
local watcher registry. Existing remote memories remain subject to Walrus
Memory retention and account-level lifecycle controls.

## Credentials

Use `noosphere setup` for initial configuration and
`noosphere credentials rotate` after registering a replacement delegate.
Noosphere cannot recover the controlling Sui wallet or a lost delegate key.
Linux systems without Secret Service explicitly fall back to an owner-only
`0600` file; that fallback is not encrypted at rest.
