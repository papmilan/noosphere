# Production image for the relayer. The build context is the repository root,
# because the file: dependency on @noosphere/secure-fs must resolve to its real
# sibling package rather than to a dangling npm symlink. Build directly with:
#
#   docker build -f noosphere-relayer/Dockerfile -t noosphere-relayer .
#
# `node scripts/docker-build.mjs relayer` is the portable command for macOS
# external volumes and stages this exact two-package layout automatically.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    NOOSPHERE_STATE_PATH=/app/.noosphere-runtime/state.json \
    NOOSPHERE_SNAPSHOT_PATH=/app/.noosphere-runtime/snapshots

WORKDIR /app

# npm resolves file:../noosphere-secure-fs from /app to this absolute sibling.
# Copy its complete published runtime before npm ci so the resulting link is
# valid both while installing and in the final image.
COPY --chown=node:node noosphere-secure-fs/package.json noosphere-secure-fs/index.js noosphere-secure-fs/windows-owner-only.ps1 /noosphere-secure-fs/

COPY --chown=node:node noosphere-relayer/package.json noosphere-relayer/npm-shrinkwrap.json ./
COPY --chown=node:node noosphere-relayer/vendor/acp-protocol ./vendor/acp-protocol
# npm is only needed to install dependencies; the runtime entrypoint is `node`.
# Remove the base image's bundled npm CLI afterwards so its vendored packages
# (e.g. picomatch, sigstore) are not shipped as an idle vulnerability surface.
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=node:node noosphere-relayer/index.js noosphere-relayer/memory.js noosphere-relayer/local-memory.js noosphere-relayer/walrus-memory.js ./
COPY --chown=node:node noosphere-relayer/durable-store.js noosphere-relayer/durability.js noosphere-relayer/security.js ./
COPY --chown=node:node noosphere-relayer/credentials.js noosphere-relayer/local-projects.js noosphere-relayer/relayer-fetch-guard.js noosphere-relayer/relayer-origins.js noosphere-relayer/secure-fs.js ./
COPY --chown=node:node noosphere-relayer/acp-protocol.js noosphere-relayer/exact-state.js noosphere-relayer/exact-routes.js noosphere-relayer/snapshot-backend.js noosphere-relayer/walrus-snapshot-backend.js ./

RUN mkdir -p /app/.noosphere-runtime/snapshots && chown -R node:node /app/.noosphere-runtime

USER node

EXPOSE 3001
VOLUME ["/app/.noosphere-runtime"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
