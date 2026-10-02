# Fractal Farm API — tile API, stats stream, and the built web client.
#
# Build from the repository root (the shared packages live outside this folder):
#   docker build -f services/api/Dockerfile -t n5453313-fractal-api .
#
# Two stages: the first builds the React client with its dev tooling; the
# second carries only production dependencies and the finished static files.

FROM node:22-alpine AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/fractal-core/package.json packages/fractal-core/
COPY packages/platform/package.json packages/platform/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY web/package.json web/
RUN npm ci --workspace @fractal-farm/web --no-audit --no-fund
COPY packages/fractal-core packages/fractal-core
COPY web web
RUN npm run build --workspace @fractal-farm/web

# -----------------------------------------------------------------------------

FROM node:22-alpine
WORKDIR /app

# Manifests first, so the dependency layer is cached until they change.
COPY package.json package-lock.json ./
COPY packages/fractal-core/package.json packages/fractal-core/
COPY packages/platform/package.json packages/platform/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace @fractal-farm/api --no-audit --no-fund

COPY packages packages
COPY services/worker/src services/worker/src
COPY services/api/src services/api/src
COPY --from=web /build/web/dist ./web-dist

USER node
ENV NODE_ENV=production \
    PLATFORM=aws \
    PORT=8080 \
    WEB_ROOT=/app/web-dist
EXPOSE 8080

CMD ["node", "services/api/src/server.js"]
