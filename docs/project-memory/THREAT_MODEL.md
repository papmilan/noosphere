# Remote Project Memory Threat Model

## Assets and trust boundaries

Projects, sessions, checkpoints, aliases, and idempotency results are private
to an authenticated owner scope. Checkpoint content is untrusted user/model
data, not executable instruction. OAuth credentials, database credentials, and
encryption keys are secrets and must never enter logs or tool results.

## Required controls

| Threat | Required boundary |
| --- | --- |
| Cross-tenant access or ID enumeration | authenticated owner scope on every query; opaque IDs; generic errors |
| Forged owner input | derive ownership only from validated authentication context |
| Token leakage | OAuth bearer handling, redacted structured logs, no tokens in tool inputs/results |
| Stored prompt injection | label recalled content as untrusted data; never concatenate it into service policy |
| Oversize/storage exhaustion | field, array, object-count, payload, quota, and pagination bounds |
| Replay/duplicate save | owner-scoped idempotency key plus request fingerprint |
| Ambiguous natural-language project name | return candidates; require user/client confirmation |
| Cross-tenant cache leakage | include owner scope in every key; avoid shared response caches |
| SSRF | excluded because v1 cannot fetch URLs or remote artifacts |
| Retention/deletion failure | explicit archive, deletion, export, and retention contracts before implementation |

## Local replay-ledger controls

The continuity client, not the remote project-memory service, owns Phase 5
replay classification. Remote ranking, timestamps, action IDs, blob IDs, agent
IDs, and labels cannot select replay identity, retention, candidate identity,
or authority.

| Threat | Phase 5 boundary |
| --- | --- |
| Cross-session semantic replay | authenticated owner-local record keyed by project, trusted slot, and normalized content digest |
| Ranking or metadata abuse | preserve remote order for presentation; exclude remote metadata from identity, retention, candidates, and authority |
| Approval laundering | replay classification is informational and never reaches the authority decision |
| Restore-candidate duplication | ephemeral trusted tuple match under the ranked candidate-index lock; random candidate IDs |
| Replay/candidate identity confusion | separate schemas, MAC domains, paths, identities, and zero persisted cross-references |
| Crash/partial commit | production mutation entry recovers authenticated before/after journals under the global lock order |
| Evidence flooding | fixed 4,096 live-record and 90-day policy with deterministic eviction |
| Reader-triggered mutation | authenticated `status`/`list` readers never enter recovery or the mutation boundary |
| Key-loss downgrade | surviving replay state plus missing/replaced key fails closed; no reset or reinitialization surface |

Replay state is not server-authenticated authorship, human-presence proof,
unlimited history, or rollback-proof audit evidence. Complete owner-local
replay-root deletion loses history but does not alter authority.

## Residual risks deferred to later PRs

The first service deployment must separately validate reverse-proxy header
trust, OAuth provider configuration, database backups, distributed rate limits,
real-client behavior, data residency, and operational incident response.
