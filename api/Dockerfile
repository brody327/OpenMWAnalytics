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

# The commit this image was built from, baked in at BUILD time and served by GET /version.
#
# WHY it is an ARG and not an env var injected by Kubernetes: the whole point is to identify
# THE IMAGE. Anything the cluster supplies at runtime describes the cluster's intent, not the
# artifact -- a manifest could confidently label a stale image with a fresh sha, which is the
# exact failure this is built to detect. Baked in, the value cannot be wrong: it travels with
# the layer or it isn't there.
#
# Defaults to "unknown" so a local `docker build` with no --build-arg still succeeds; CI always
# passes the real sha (see .github/workflows/build-api.yml).
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV OMWA_GIT_SHA=$GIT_SHA
ENV OMWA_BUILT_AT=$BUILT_AT
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# The migration SQL is DATA, not compiled output, so it must be copied explicitly -- tsc will
# never put it in dist/. The initContainer runs `node dist/jobs/migrate.js`, which reads this
# folder at runtime; without it the pod cannot start. (Forgetting exactly this kind of
# not-compiled-but-required file is what kept scripts/ out of the image earlier.)
COPY drizzle ./drizzle
# The API reads PORT (default 4000) and DATABASE_URL from the environment at runtime;
# both are injected by Kubernetes, never baked into the image.
EXPOSE 4000
CMD ["node", "dist/index.js"]
