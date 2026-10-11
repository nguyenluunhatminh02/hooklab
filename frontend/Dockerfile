# HookLab frontend image — multi-stage: vite build -> Caddy static serve.
#
# Build context MUST be the repository root (compose: context: .,
# dockerfile: frontend/Dockerfile): npm ci needs the single root
# package-lock.json, and docker/Caddyfile only exists there.

# ---------------------------------------------------------------------------
# Stage 1 — build: tsc --noEmit && vite build (package.json "build" script)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# The lockfile spans both workspaces, so npm ci validates every workspace
# manifest against it.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json

# Full install — the build runs `tsc --noEmit && vite build`, both devDeps.
RUN npm ci --workspace frontend --include-workspace-root

# Selective copy: .dockerignore exists (since 2026-10-08, depth-agnostic **/
# patterns verified 2026-10-10), but frontend/ routinely holds a developer's
# node_modules/ and stale dist/ that must not reach this layer.
# Verified set: install + `npm run build --workspace frontend` succeeds and
# vite emits to the workspace default outDir, frontend/dist.
COPY frontend/src ./frontend/src
COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts frontend/vitest.config.ts ./frontend/

RUN npm run build --workspace frontend

# ---------------------------------------------------------------------------
# Runtime — Caddy serves the bundle. compose bind-mounts docker/Caddyfile over
# this path; the baked copy keeps the image self-contained when run alone.
# ---------------------------------------------------------------------------
FROM caddy:2-alpine
COPY --from=build /app/frontend/dist /usr/share/caddy
COPY docker/Caddyfile /etc/caddy/Caddyfile
