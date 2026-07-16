# Security Policy

Noosphere handles delegate private keys, API tokens, and project memory.
Security reports are taken seriously and handled privately.

## Supported versions

Only the latest published release of each package receives security fixes.

| Package | Supported |
| --- | --- |
| `noosphere-continuity` | 2.3.x |
| `noosphere-relayer` | 2.1.x |

Older versions do not receive backported fixes. Upgrade to the latest
release before reporting an issue you can only reproduce on an old version.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/papmilan/noosphere/security/advisories/new).

Do **not** open a public issue for a security problem, and do not include
working credentials or private keys in a report. Redacted examples are
enough.

A useful report includes:

- the package and version;
- the environment (OS, Node.js version, backend: local-file or Walrus);
- reproduction steps or a proof of concept;
- the impact you believe it has.

## What to expect

- Acknowledgement within **7 days**.
- An assessment (accepted, needs more information, or declined) within
  **14 days** of acknowledgement.
- Accepted reports are fixed in a patch release for every supported
  package, credited to the reporter unless anonymity is requested, and
  disclosed through a GitHub security advisory after the fix is published.

This project is maintained by a small team; the timelines above are
commitments to respond, not a 24/7 SLA.

## Scope

In scope:

- the `noosphere-continuity` and `noosphere-relayer` npm packages;
- the shared `@noosphere/acp-protocol` package vendored in this repository;
- credential storage and handling (`noosphere setup`, platform keychains,
  the owner-only fallback file);
- the relayer HTTP surface: authentication, CORS, rate limiting, and the
  ACP sync confirmation and quarantine mechanisms;
- ACP envelope validation, including the execution-checkpoint payload
  prohibition.

Out of scope:

- the Walrus Memory service, the managed relayer at
  `memory.walrus.xyz`, and the Sui network (report upstream);
- vulnerabilities requiring an already-compromised machine or root access;
- denial of service against a relayer you run on your own machine;
- issues only reproducible with `ALLOW_LOOPBACK_WITHOUT_TOKEN=true` on a
  loopback-only development instance, which is the documented local mode.

## Security model

The documented trust boundary and data path live in
[docs/PRIVACY.md](docs/PRIVACY.md) and
[noosphere-relayer/MEMORY_SECURITY.md](noosphere-relayer/MEMORY_SECURITY.md).
Read them before reporting a boundary you believe is broken — some
boundaries (for example, the managed relayer seeing plaintext to build
embeddings) are documented design decisions, not leaks.
