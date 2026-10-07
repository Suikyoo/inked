# syntax=docker/dockerfile:1

# ---- build: web SPA and server ---------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
RUN npm ci
COPY core core
COPY server server
COPY web web
COPY scripts scripts
ARG INKED_SEMANTIC=1
RUN if [ "$INKED_SEMANTIC" = "1" ]; then node scripts/fetch-model.mjs web/public/models; fi
RUN npm run build -w web && npm run build -w server

# ---- deps: server production dependencies only -----------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY server/package.json server/
COPY web/package.json web/
COPY mcp/package.json mcp/
RUN npm ci --omit=dev -w server && npm cache clean --force

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/api/status || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
