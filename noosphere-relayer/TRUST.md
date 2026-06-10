# Noosphere Trust Model

## What is trustless now

- User score manipulation: BLOCKED at relayer
- Every decision: emits on-chain DecisionScored event with blob_id, score, and scorer version
- Scoring policy: public, versioned, hash-verified
- Scorer identity: separate key, every score signed
- Storage: 200 epochs (~13 months)

## Roadmap to full trustlessness

- TEE-based scorer (Q3 2026)
- Multi-scorer consensus (Q4 2026)
- Automatic Walrus renewal via protocol fees (Q3 2026)
- Decentralized indexer (Q1 2027)
