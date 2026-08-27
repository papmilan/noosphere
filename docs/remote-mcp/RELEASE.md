# Remote Project Memory — Release guide

How to version, tag, verify, and ship the Remote MCP server and its packages.
This is process documentation; it does not change build or runtime behavior.

## Versioning

- The Remote Project Memory packages (`@noosphere/remote-mcp*`) follow
  **semantic versioning**: `MAJOR.MINOR.PATCH`.
  - **MAJOR** — a breaking change to a public MCP tool schema, the wire
    contract, the auth model, or a non-additive database migration.
  - **MINOR** — backward-compatible additions (new optional config, additive
    migrations, new tools).
  - **PATCH** — bug/operational fixes with no contract change.
- The **tool schemas and protocol are the compatibility surface.** Changing them
  is always at least a MINOR (additive) or MAJOR (breaking) event.
- Database migrations are **forward-only and additive**; a migration that drops
  or rewrites existing data/columns is a breaking change and a MAJOR bump.

## Tagging

Tag releases from `main` after CI is green:

```sh
git tag -a remote-mcp-vX.Y.Z -m "Remote Project Memory X.Y.Z"
git push origin remote-mcp-vX.Y.Z
```

## Release checklist

1. `main` is green: `ci.yml` (all behavioral suites) **and** `deploy.yml`
   (image build + container startup + packaging) pass.
2. Version bumped in the affected `package.json` files; `package-lock.json`
   regenerated and committed (kept in sync — `npm ci` fails otherwise).
3. New migrations are ordered, contiguous, additive, and tested against the
   PostgreSQL CI service.
4. `CONFIGURATION.md` matches `KNOWN_ENV_KEYS` in `src/main.js` (no drift).
5. No secrets added; `deploy/*.env` still ignored, only `*.example` tracked.
6. `npm audit --audit-level=high` clean for the changed packages.
7. Changelog / release notes drafted, breaking changes called out explicitly.

## Verification checklist (pre-tag)

Run locally or confirm from CI:

```sh
# Behavioral suites (unchanged by operational releases)
(cd noosphere-remote-mcp-postgres && npm ci && npm run test:nodb)
(cd noosphere-remote-mcp-server && npm ci && npm test)

# Image + startup
node scripts/docker-build.mjs remote-mcp --tag noosphere-remote-mcp-server:rc
docker run -d --name rc -p 8080:8080 \
  -e NOOSPHERE_AUDIENCE=https://rc.example/pm \
  -e NOOSPHERE_RESOURCE_METADATA_URL=https://rc.example/.well-known/oauth-protected-resource \
  -e 'NOOSPHERE_OIDC_ISSUERS=[{"iss":"https://rc.example/","jwks_uri":"https://rc.example/jwks"}]' \
  noosphere-remote-mcp-server:rc
curl -fsS http://127.0.0.1:8080/healthz && curl -fsS http://127.0.0.1:8080/readyz
docker rm -f rc

# Working tree hygiene
git diff --check
```

## Supported upgrade path

- Upgrades are **N → N+1**: apply pending migrations, then roll the server.
  Skipping multiple minor versions is supported as long as every intervening
  migration is applied in order (`migrate.js` handles this automatically).
- The server is stateless; rolling restarts lose no data.

## Downgrade policy

- Downgrades are **not supported across a migration.** Because migrations are
  forward-only, rolling back to an older server version requires restoring the
  pre-upgrade database dump as well (see
  [`OPERATIONS.md`](OPERATIONS.md#rollback-guidance)).
- Within the same schema version, redeploying an older PATCH build is safe.

## Breaking-change policy

- Breaking changes require a MAJOR bump and an explicit migration/operator note
  in the release.
- Public MCP tool schemas and the wire protocol are **stable**; a breaking
  change to them is a deliberate, documented, major event — never a silent one.
- Deprecations ship at least one MINOR before removal, with the replacement
  documented.
