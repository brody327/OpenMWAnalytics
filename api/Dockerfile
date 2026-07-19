# Multi-stage build for the OpenMW Analytics ingest/query API.
#
# WHY multi-stage: the "builder" stage has everything needed to COMPILE (dev deps +
# TypeScript source); the "runtime" stage carries only what's needed to RUN (prod deps
# + the compiled dist/). The toolchain never ships in the final image — smaller, less
# attack surface. Only the last stage becomes the image; earlier stages are discarded.
#
# Build context is this api/ folder. The API is self-contained (no imports from sibling
# workspaces), so it builds standalone; we use `npm install` rather than `npm ci`
# because the lockfile lives at the monorepo root, not here. (A stricter setup would
# build from the repo root against the workspace lockfile.)

# ---- builder: compile TypeScript -> dist/ ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: prod deps + compiled output only ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# The API reads PORT (default 4000) and DATABASE_URL from the environment at runtime;
# both are injected by Kubernetes, never baked into the image.
EXPOSE 4000
CMD ["node", "dist/index.js"]
