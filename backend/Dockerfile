# HookLab backend image — multi-stage: deps -> build -> runtime.
#
# Build context MUST be the repository root (compose: context: .,
# dockerfile: backend/Dockerfile). npm workspaces keep a single committed root
# package-lock.json and there is no backend/package-lock.json, so `npm ci` can
# only run from the root (BUILD_PLAN §1: "single committed lockfile").
#
# Build-time placeholder for prisma.config.ts's env('DATABASE_URL'). Declared
# once here as a global ARG; redeclared per stage because a pre-FROM ARG is out
# of scope after FROM. It is never turned into ENV in the runtime stage, so the
# shipped image carries no DATABASE_URL — compose injects the real one.
ARG BUILD_DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"

# ---------------------------------------------------------------------------
# Stage 1 — deps: full install (devDependencies needed by nest/tsc/prisma)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
ARG BUILD_DATABASE_URL
WORKDIR /app

# Not cosmetic: prisma.config.ts resolves env('DATABASE_URL') while loading,
# and the backend package runs `prisma generate` from postinstall — without a
# value npm ci aborts with PrismaConfigEnvError (verified).
ENV DATABASE_URL=${BUILD_DATABASE_URL}

# The lockfile spans both workspaces, so npm ci validates every workspace
# manifest against it.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
# postinstall `prisma generate` reads these before npm ci returns
COPY backend/prisma ./backend/prisma
COPY backend/prisma.config.ts ./backend/prisma.config.ts

RUN npm ci --workspace backend --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 2 — build: regenerate the client from schema, then nest build
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

# Selective copy on purpose: even with .dockerignore in place (it exists since
# 2026-10-08 — this build context is the repo root), backend/.env is a
# machine-local secret and stale backend/dist must not reach a build layer.
COPY backend/src ./backend/src
COPY backend/tsconfig.json backend/tsconfig.build.json ./backend/

WORKDIR /app/backend
# src/generated is gitignored, so the client is produced here; nest build then
# follows the ../../generated/prisma/client import and emits it into dist/.
RUN npm run generate && npm run build

# ---------------------------------------------------------------------------
# Stage 3 — runtime: production dependencies only, non-root
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
# Prisma's schema-engine is a native binary linked against OpenSSL and alpine
# ships without it; app-entrypoint.sh needs that engine for migrate deploy.
RUN apk add --no-cache openssl

ARG BUILD_DATABASE_URL
WORKDIR /app
ENV NODE_ENV=production TZ=UTC
# DATABASE_URL deliberately not set here: compose supplies it at container start.

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
# Verified layout: with cwd /app/backend, `npx prisma migrate deploy` resolves
# the hoisted CLI at /app/node_modules/.bin, loads ./prisma.config.ts and
# ./prisma/schema.prisma, and reaches the DB (P1001 without a server).
COPY backend/prisma ./backend/prisma
COPY backend/prisma.config.ts ./backend/prisma.config.ts

# --omit=dev drops nest/jest/eslint/tsx while prisma stays (it is a peer of
# @prisma/client), so the CLI remains for migrate deploy. Scripts stay ENABLED
# on purpose: @prisma/engines' postinstall downloads the schema-engine binary,
# and bcrypt's node-gyp-build selects the musl prebuild. Verified: install
# succeeds, no vite/jest/@nestjs/cli present.
RUN DATABASE_URL="${BUILD_DATABASE_URL}" \
      npm ci --workspace backend --include-workspace-root --omit=dev \
 && chown -R node:node /app

# cwd for the image CMD and for compose's `command:` override
# (docker/app-entrypoint.sh runs `npx prisma migrate deploy` then
# `node dist/main.js` — both are cwd-relative).
WORKDIR /app/backend
COPY --chown=node:node --from=build /app/backend/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
