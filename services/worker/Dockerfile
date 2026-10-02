# Fractal Farm render worker.
#
# Build from the repository root:
#   docker build -f services/worker/Dockerfile -t n5453313-fractal-worker .
#
# No ports: a worker only pulls from the queue and writes to the store, so it
# needs no inbound network path at all.

FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/fractal-core/package.json packages/fractal-core/
COPY packages/platform/package.json packages/platform/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace @fractal-farm/worker --no-audit --no-fund

COPY packages packages
COPY services/worker/src services/worker/src

USER node
ENV NODE_ENV=production \
    PLATFORM=aws

CMD ["node", "services/worker/src/main.js"]
