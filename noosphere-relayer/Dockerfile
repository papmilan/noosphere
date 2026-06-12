FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    NOOSPHERE_STATE_PATH=/app/.noosphere-runtime/state.json

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node index.js memory.js walrus-memory.js ./
COPY --chown=node:node durable-store.js security.js ./
COPY --chown=node:node credentials.js local-projects.js ./
COPY --chown=node:node public ./public

RUN mkdir -p /app/.noosphere-runtime && chown node:node /app/.noosphere-runtime

USER node

EXPOSE 3001
VOLUME ["/app/.noosphere-runtime"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
