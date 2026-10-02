# Fractal Farm worker scaling controller.
#
# Build from the repository root:
#   docker build -f services/scaler/Dockerfile -t n5453313-fractal-scaler .

FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/fractal-core/package.json packages/fractal-core/
COPY packages/platform/package.json packages/platform/
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
COPY services/scaler/package.json services/scaler/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace @fractal-farm/scaler --no-audit --no-fund

COPY packages packages
COPY services/scaler/src services/scaler/src

USER node
ENV NODE_ENV=production \
    PLATFORM=aws

CMD ["node", "services/scaler/src/main.js"]
