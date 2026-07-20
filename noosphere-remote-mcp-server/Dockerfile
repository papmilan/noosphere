# Production image for the Noosphere Remote Project Memory HTTP server.
#
# IMPORTANT: the build context is the repository ROOT, not this directory,
# because the server composes two monorepo sibling packages at runtime
# (the OIDC verifier + PostgreSQL repository live in noosphere-remote-mcp-postgres,
# and the versioned contracts/core live in noosphere-remote-mcp). Build with:
#
#   docker build -f noosphere-remote-mcp-server/Dockerfile -t noosphere-remote-mcp-server .
#
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NOOSPHERE_PORT=8080

WORKDIR /app

# --- Contracts (no dependencies; consumed as a file: dependency and imported at
#     runtime by both the server and the postgres repository). ---
COPY --chown=node:node noosphere-remote-mcp/ ./noosphere-remote-mcp/

# --- PostgreSQL control-plane sibling. Provides pg + jose via its own
#     node_modules, which the server's src/main.js imports by relative path.
#     Install prod deps first (cache-friendly), then copy its source. ---
COPY --chown=node:node noosphere-remote-mcp-postgres/package.json noosphere-remote-mcp-postgres/package-lock.json ./noosphere-remote-mcp-postgres/
RUN cd noosphere-remote-mcp-postgres && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node noosphere-remote-mcp-postgres/ ./noosphere-remote-mcp-postgres/

# --- The deployable HTTP server. ---
COPY --chown=node:node noosphere-remote-mcp-server/package.json noosphere-remote-mcp-server/package-lock.json ./noosphere-remote-mcp-server/
RUN cd noosphere-remote-mcp-server && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node noosphere-remote-mcp-server/ ./noosphere-remote-mcp-server/

# The runtime entrypoint is `node`; npm is not needed after install. Removing it
# drops the base image's bundled npm vendor tree as an idle vulnerability surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Run unprivileged. The `node` base image ships a non-root `node` user (uid 1000).
USER node
WORKDIR /app/noosphere-remote-mcp-server

EXPOSE 8080

# Liveness only: /healthz never touches the database, so a healthy process with a
# down database still reports live (use /readyz for traffic gating at the LB).
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NOOSPHERE_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node (PID 1) receives SIGTERM directly; src/main.js installs a SIGTERM handler
# that drains sessions, closes the pg pool, and exits 0.
CMD ["node", "src/main.js"]
