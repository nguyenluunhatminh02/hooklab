# HookLab

Webhook capture, inspection and replay debugging tool.

- **backend/** — NestJS 11 + Prisma 7 (PostgreSQL)
- **frontend/** — React 18 + Vite + TypeScript
- **docs/BUILD_PLAN.md** — binding implementation plan (read before coding)

## Quick start

```bash
cp .env.example .env            # root: docker-compose interpolation (POSTGRES_HOST_PORT)
cp .env.example backend/.env    # backend: dotenv loads this from backend/ cwd —
                                # without it `npm install` dies in postinstall `prisma generate`
                                # (PrismaConfigEnvError) and the API can't boot
# edit BOTH files: fill JWT_SECRET (openssl rand -hex 32)
npm install
docker compose up -d postgres
npm run --workspace backend prisma:migrate   # npx prisma migrate dev --name init
npm run build
```

## Run

```bash
# API on :3000 (needs Postgres up + backend/.env filled)
npm run --workspace backend start:dev

# UI on :5173 with /api + /ingest proxied to :3000
npm run --workspace frontend dev
```

## Scripts (root)

| Script | What it runs |
|---|---|
| `npm run lint` | `eslint --no-fix` in backend and frontend |
| `npm run typecheck` | `tsc --noEmit` in both workspaces |
| `npm test` | backend Jest + frontend Vitest |
| `npm run build` | `nest build` + `vite build` |
| `npm run test:cov --workspace backend` | backend Jest with coverage (`jest --coverage --maxWorkers=2`; summary at `backend/coverage/coverage-summary.json`) |
| `npm run test:cov --workspace frontend` | frontend Vitest with `@vitest/coverage-v8` (summary at `frontend/coverage/coverage-summary.json`) |

## Ops scripts

| Script | What it does |
|---|---|
| `scripts/hooklab-smoke.js` | 98-check live contract sweep against a running API; `BASE` (default `http://127.0.0.1:3100`) and `PG_CONTAINER` env |
| `scripts/loadtest.mjs` | P9 gate: 500 req / 5 min against `/ingest/:token`; asserts 200 or 429+Retry-After, zero timeouts |
| `scripts/rebuild-restart.sh` | Rebuild backend and restart the dev API on `:3100`; kills only the process whose `/proc/<pid>/cwd` and cmdline match this repo's backend |

## Health

- `GET /health` — liveness (process up)
- `GET /ready` — readiness (`SELECT 1` via Prisma)
