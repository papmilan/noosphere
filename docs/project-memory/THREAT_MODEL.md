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

## Residual risks deferred to later PRs

The first service deployment must separately validate reverse-proxy header
trust, OAuth provider configuration, database backups, distributed rate limits,
real-client behavior, data residency, and operational incident response.
