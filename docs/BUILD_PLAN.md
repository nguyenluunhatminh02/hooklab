# HookLab — BUILD PLAN

> Single source of truth an implementation team executes from.
> Inputs: `docs/SPEC.md` (authoritative scope — wins every conflict) + `docs/design/{01-prisma-schema,02-api-contract,03-ingest-pipeline,04-frontend}.md`.
> This file is design output only. Implementation workflows execute §7 phases in order; §0–§6 decisions are settled — do not re-litigate, record new evidence in §9 instead.
> Version facts (Prisma 7.10.0 CLI behavior, package `require` conditions, `migrate diff` flags, `prisma.config.ts` API) verified 2026-10-08 against prisma.io `/docs/orm/v7/*` and registry.npmjs.org.

---

## 0. Reconciled conflicts (read before coding)

Where 02/03/04 disagree, the resolution below is binding. "Why" is the review answer.

| # | Conflict | Resolution | Why |
|---|---|---|---|
| C1 | **Ingest gate order**: 02 §9.2 = rate before size; 03 §2 = size before rate | **03 wins** (state machine §4): token → size → rate → capture → HMAC | 02's rationale ("rate check before the body is buffered") is architecturally false under the shared design — the path-scoped raw-body middleware buffers before any controller code runs. Size is a precomputed flag (cheapest gate); oversized payloads never consume quota. Task designates 03 as the state-machine source. |
| C2 | **Capture is two-step `pending` → update** (03 §2 step 4–5) vs **every row terminal** (02 §9.1, 01 §8.5, SPEC) | **Single insert with terminal status**: run pure `verifySignature` first (never throws, tested), then one `create` before responding. No `pending` exists in the enum | 02's status table and SPEC know only verified/rejected; a `pending` row would leak into list mappers with no wire representation. Record-then-respond is preserved (insert strictly precedes response). Verify-crash gap closed by making `verifySignature` total (03 §7 already requires no-throw; §8 tests it). |
| C3 | **SSRF-blocked replay**: 03 §4.3 writes a row; 02 §6 writes none | **02 wins**: 400 `replay_target_blocked` + `details.blockedIp`, **no record**, nothing sent | "Nothing was sent, nothing belongs in the timeline" (02 §6); 04's `ReplayChild` outcome enum has no `blocked` case. `ReplayError.REPLAY_TARGET_BLOCKED` enum value stays for a future toggle (01 §8.6). |
| C4 | **Replay HTTP contract**: 03 §4.3 answers 201-with-entity for every outcome; 02 §6 branches status | **02 wins**: 200 `ReplaySuccess` / 504 `replay_timeout`+`details.replayRecordId` (record written) / 502 `replay_upstream_error` (record, outcome `upstream_error`) / 400 / 404 / 410 | 04's `mapReplayError` branches on exactly these statuses; a 201-everywhere shape breaks the frontend contract (04 §6 table matches 02). |
| C5 | **Endpoint shapes**: 04 §3 (PROPOSAL) vs 02 contract | **02 wins on every row**: resource = `subscriber` (not `endpoint`); records at `GET /api/subscribers/:id/records`, `GET /api/workspaces/:id/records`, `GET /api/records/:id`; stats at `GET /api/subscribers/:id/stats` (not `/metrics`); query param `q` (not `search`); envelope `{data}` / `{error:{code,message,details,requestId}}` (not `{statusCode,code,message}`); **no `GET /api/config`**; `RecordListItem` per 02 (no `bodyPreview` — list rows show `eventType`/`method`/`bodyBytes`, detail carries `rawBody`) | 02 is the contract doc; 04 labels its own §3 "PROPOSAL — reconcile with 02". SPEC's rotate = "sinh secret mới" → **rotate returns new SECRET only, `ingestToken` stable** (04's "new token + secret" rejected). |
| C6 | **Model names**: 02 (`Record`, `captureRecord`), 03 (`CaptureRecord`, `RateWindowRow`, `endpointId` **BigInt**), 01 (`WebhookRecord`, `RateLimitWindow`, `subscriberId`, `Membership`) | **01 wins** (schema doc): `WebhookRecord`, `RateLimitWindow`, `Membership`, `Subscriber`; **ids `Int @id @default(autoincrement())`**; column `subscriberId`, `signatureHeaderName` | 02 §1.5 requires integer route ids + `ParseIntPipe`; 03's BigInt adds JSON-serialization friction for no gain (int4 ample under 7-day retention). Read every `CaptureRecord`/`RateWindowRow`/`endpointId` in 02/03 as the 01 names; wire fields (`signatureHeader`, snake_case enum codes) are unchanged — mapper translates (01 §8.2/§8.4). |
| C7 | **Retention cron**: 02 §11 `@Cron('0 3 * * *')` (5-field) vs 03 §6 `@Cron('0 0 3 * * *', { name:'retention', timeZone:'UTC' })` (6-field) | **03 wins**: 6-field seconds-first, `timeZone: 'UTC'`; `ScheduleModule.forRoot()` exactly once in `AppModule` | Docs-verified (03 header): `@nestjs/schedule` 6-field with optional seconds; explicit UTC + `TZ=UTC` container = belt and braces. Double `forRoot()` re-registers handlers and runs the job twice. |
| C8 | **Constants home**: 02 `shared/hooklab.constants.ts` vs 03 `src/common/constants/ingest.constants.ts` | **One backend directory** `backend/src/common/constants/` with two files, each value defined exactly once: `ingest.constants.ts` (03 §0 names) + `app.constants.ts` (02 §1.6 remainder). No cross-workspace shared package in v1 | Two workspaces compiling one shared TS package buys little for ~15 constants (frontend reads retention from `stats.retention.days`, only a display fallback is duplicated in `frontend/src/config.ts`). |
| C9 | **CI drift gate**: 01 §5 suggests `--from-migrations`; docs' canonical sync check is `--from-config-datasource` | **`npx prisma migrate diff --exit-code --from-config-datasource --to-schema prisma/schema.prisma`** after `migrate deploy` (unit-test job) | v7 docs' own "check if sources are in sync" example; exits 2 on drift. `--from-migrations` needs a shadow DB (its `--shadow-database-url` flag was removed in v7 → config only); `--from-config-datasource` rides the job's postgres service. |
| C10 | **Migration creation**: offline `migrate diff --from-empty` vs `migrate dev` | **`prisma migrate dev` against docker postgres** is canonical; offline `--from-empty --to-schema --script` only to eyeball SQL with no DB | Documented v7 dev workflow: real DB validation + shadow-DB drift detection + committed `prisma/migrations/` history. Offline diff creates SQL without history — never the creation path (01 §5). |
| C11 | 01 §7.4 claims "**Prisma 7 ships as ESM only**" | **Refuted.** `@prisma/client@7.10.0` and `@prisma/adapter-pg@7.10.0` (registry metadata) expose `require` conditions and no `"type": "module"`. **Backend stays CommonJS** (no `"type":"module"`, `module: commonjs`) | The upgrade guide *recommends* ESM; the packages are dual/CJS-compatible and generated `prisma-client` output is plain TS compiled by the app. Keep 01's underlying advice as a Phase-0 gate: build + tests must pass under CJS before feature work. |
| C12 | Prisma version drift | **Pin exact `7.10.0`**: `prisma`, `@prisma/client`, `@prisma/adapter-pg` (+ `pg`, `@types/pg`); lockfile committed; Dependabot/Renovate PRs bumping to 8.x rejected until a dedicated upgrade pass | npm dist-tag `latest` for `prisma` is `8.0.0-rc.x` — `npm i -D prisma` today installs 8. Docs default to v8; repo targets v7 (`/docs/orm/v7`). |
| C13 | Window-row cleanup ownership (03 §9 undecided) | Retention cron does **both**: `webhookRecord.deleteMany({receivedAt < cutoff})` **and** `rateLimitWindow.deleteMany({occurredAt < now−window})` in the same job | FK cascade only fires on subscriber delete — it never removes time-expired rows. 01 §4's explicit prune is correct; 03's "cascade covers stragglers" is wrong for time-based expiry. |
| C14 | `subDays` from date-fns (01 §4, 03 §6) | **No date-fns.** Cutoff = `new Date(Date.now() - RETENTION_DAYS * MS_PER_DAY)` with `MS_PER_DAY` a named constant | One subtraction does not justify a dependency (supply-chain hygiene: prune unused deps, conventions §3). |
| C15 | Whitelist literal `x-hub-signature` (SPEC shorthand) vs configurable header | Whitelist = **subscriber's `signatureHeaderName` (lowercased) + `x-request-id` + `user-agent` + `content-type`** (02 §5.1) | SPEC's default header is `X-Hub-Signature-256`; the configured header is the one senders actually set. `eventType` is extracted (`body.type`/`body.event`/`x-event-type`) *before* non-whitelisted headers are dropped. **Deliberate, recorded deviation from SPEC's literal `x-hub-signature` shorthand** (the only place SPEC does not win: its own default-header line contradicts the shorthand): a sender using literal `x-hub-signature` must set it as the subscriber's `signatureHeaderName` to have it stored. |
| C16 | `body_too_large` storage (03 §9 undecided); 01 says `bodyBytes` derived from `rawBody.length` | Middleware stops **buffering and reading** at `MAX_BODY_BYTES + 1` (no unbounded drain — DoS), then record + 413 + close. Row: `rawBody = ''`, **`bodyBytes Int` column** stores exact bytes when ≤ cap, sentinel `MAX_BODY_BYTES + 1` on overflow (UI renders "≥ 1 MB") | Derivation impossible for oversize rows, and `rawBody.length` counts UTF-16 units, not bytes. **Supersedes 01 §2's "no column" note.** Immediate 413 (don't wait for a 10 GB upload to finish); edge backstop note in §9 (C21). |
| C17 | `JWT_TTL` undecided (02 §14) | Named constant `JWT_TTL = '12h'` (02's suggested default) | Debug tool; no refresh tokens in v1. |
| C18 | Replay **method**: 03 §4.3 uses `record.method`; 02 §6 uses subscriber config | **02 wins**: replay sends `destinationMethod` + `destinationUrl` + `destinationHeaders`; `ReplayDto` supplies only the body | SPEC: "gửi lại tới destination đã khai báo ở subscriber (method + URL + header)". Body = `content-type: application/json` default, overridden if `destinationHeaders` sets it. |
| C19 | `/health` + `/ready` deferred by 02 §14 but required by conventions §3 | **Added in Phase 0**, `@Public()`: `/health` = liveness (process up), `/ready` = `SELECT 1` via Prisma | Orchestrator/Caddy health checks need them; additive routes do not touch 02's contract. |
| C20 | Ingest non-POST verbs (03 §9 undecided) | `@Post(':token')` only → other verbs get Nest's default **405**; not part of the contract (02 §9.1 has 7 rows only) | SPEC story is POST-only. |
| C21 | Structured logging / requestId (conventions §3) | Phase 0: `nestjs-pino` with per-request `requestId` correlation; `error.requestId` in the envelope comes from the same id (filter generates `req_<uuid>` if absent) | Conventions mandate structured logging + correlation IDs for new features; single mapping site in the global filter. |

---

## 1. Monorepo layout

npm workspaces, one lockfile at root. One line per top-level entry:

```
hooklab/
├── package.json              # root: {"workspaces":["backend","frontend"]}; scripts: lint, typecheck, test, build
├── package-lock.json         # single committed lockfile (npm ci in CI; no shrinkwrap)
├── .env.example              # DATABASE_URL, JWT_SECRET, PUBLIC_BASE_URL, PORT (committed; no real secrets)
├── .gitignore                # node_modules, .env, dist, backend/src/generated/, *.log, caddy_data
├── docker-compose.yml        # services: postgres, app, caddy (§6)
├── docker/
│   ├── Caddyfile             # serves frontend/dist; reverse_proxy /api/* and /ingest/* → app:3000; NO request_body limit (C21-adjacent, §9)
│   └── app-entrypoint.sh     # `npx prisma migrate deploy` then `node dist/main.js` (app container boot)
├── .github/workflows/ci.yml  # exactly 4 jobs: lint, typecheck, unit-test, docker-build (§6)
├── scripts/
│   ├── loadtest.mjs          # 500 req / 5 min against /ingest/:token; asserts every response 200 or 429+Retry-After, zero timeouts (P9 gate)
│   ├── hooklab-smoke.js      # 98-check live contract sweep across auth/workspaces/subscribers/ingest/records/replay; BASE + PG_CONTAINER env
│   └── rebuild-restart.sh    # rebuild backend + restart the :3100 dev API; kill decision from /proc/<pid>/cwd + cmdline
├── docs/
│   ├── SPEC.md               # authoritative scope
│   ├── BUILD_PLAN.md         # this file — execution source of truth
│   └── design/               # 01-prisma-schema, 02-api-contract, 03-ingest-pipeline, 04-frontend (reference; §0 deltas win)
├── backend/                  # NestJS 11 + Prisma 7 workspace (details below)
├── frontend/                 # React 18 + Vite + TS workspace (04's `web/` name mapped here)
├── .claude/                  # existing repo rules/hooks (rules tracked; hooks machine-local/gitignored — do not disable)
└── (no other top-level dirs)
```

`backend/`:

```
backend/
├── package.json              # prisma/pins exact 7.10.0 (C12); "postinstall": "prisma generate"
├── prisma.config.ts          # next to package.json (§2)
├── tsconfig.json             # module commonjs (C11), strict, emitDecoratorMetadata
├── eslint.config.js  jest.config.ts  Dockerfile
├── prisma/
│   ├── schema.prisma         # THE schema (§2)
│   ├── migrations/           # committed; only `prisma migrate dev` writes here
│   └── seed.ts               # optional demo seed; run explicitly (`prisma db seed`)
├── src/
│   ├── main.ts               # bodyParser:false → ingest raw middleware → express.json → app listen (§4)
│   ├── app.module.ts         # global enhancers, ScheduleModule.forRoot() once, pino
│   ├── generated/prisma/     # prisma-client output (gitignored; postinstall generates)
│   ├── config/env.validation.ts   # joi validate at bootstrap — fail fast (conventions §6)
│   ├── common/
│   │   ├── constants/{ingest.constants.ts, app.constants.ts}   # C8 — no magic numbers elsewhere
│   │   ├── crypto/hmac.ts    # verifySignature(...) — pure, timingSafeEqual, one audit site
│   │   ├── prisma/{prisma.module.ts, prisma.service.ts, record-count.ts}  # canonical count helper (§4/§8)
│   │   ├── filters/http-exception.filter.ts   # THE one APP_FILTER: P2002→409, P2025→404, HttpException passthrough, else 500; requestId
│   │   ├── guards/public.decorator.ts         # @Public() marker for JwtAuthGuard
│   │   └── membership/membership.service.ts   # assertMember / assertOwner — single matrix test site
│   ├── health/health.controller.ts            # GET /health, GET /ready (C19, @Public)
│   ├── auth/  workspaces/  subscribers/       # controllers + DTOs (classes) + services + *.spec.ts
│   ├── records/{records.controller.ts, records.repository.ts, records.service.ts, *.spec.ts}
│   ├── replay/{replay.controller.ts, replay.service.ts, ssrf.ts, *.spec.ts}
│   ├── ingest/{ingest.module.ts, ingest.controller.ts, ingest.service.ts, rate-limit.service.ts,
│   │           middleware/ingest-raw-body.middleware.ts, *.spec.ts}
│   └── retention/retention.service.ts         # @Cron 6-field UTC + window prune (C7/C13)
└── test/                       # *.e2e-spec.ts only (happy-path flow e2e)
```

`frontend/` (from 04 §10's proposal `web/`, renamed `endpoints`→`subscribers` per C5; the tree below is the delivered file list — 04 §10 is not kept in sync):

```
frontend/
├── package.json  vite.config.ts (dev proxy /api → :3000)  vitest.config.ts  tsconfig.json  eslint.config.js  Dockerfile  index.html
└── src/
    ├── main.tsx  App.tsx (createBrowserRouter)  config.ts (POLL_INTERVAL_MS=2000, SEARCH_DEBOUNCE_MS=300, RETENTION_DAYS fallback=7)
    ├── styles/{tokens.css, global.css, app.css, replay.css}   # IBM Plex Sans/Mono, dark OKLCH, blue primary / amber accent (04 §9)
    ├── auth/{AuthStore.tsx, RequireAuth.tsx, RequireGuest.tsx, nextPath.ts, tokenStorage.ts}
    ├── api/{httpClient.ts, types.ts, auth.ts, workspaces.ts, subscribers.ts, records.ts}   # unwrap {data}; error → {code,...}
    ├── hooks/{queries.ts, useDocumentVisibility, useDebouncedValue, useTimeline, useReplay}   # queries.ts = queryKeys + data hooks (workspaces/subscribers/stats/record); stats key ['stats', id] — see §5.2
    ├── lib/{replayErrors.ts, lastWorkspace.ts}   # replayErrors = mapReplayError(status, code, message) — pure, 02 shapes (C4)
    ├── pages/{AuthPage, HomeRedirect, WorkspaceListPage, WorkspaceOverviewPage, SubscriberDetailPage, NotFoundPage}.tsx   # HomeRedirect = the `/` redirector (04 §2)
    └── components/{AppShell, RetentionNotice, MetricsBadges, SubscriberForm, SecretRevealModal, ConfirmDialog, CopyButton,
        TimelineTabs, SearchInput, TimelineList, TimelineRow, RecordDetail, JsonView, HeadersTable, ReplayEditor, ReplayComparison,
        StatusBadge, EmptyState, Toast, ErrorBoundary}.tsx   # WorkspaceSwitcher/UserMenu live inside AppShell.tsx; SubscriberList/SubscriberRow inside WorkspaceOverviewPage.tsx; ErrorBoundary wraps the app in main.tsx (P8) — none are standalone files
```

---

## 2. Prisma schema + migrations

### 2.1 Location & content

**`backend/prisma/schema.prisma`** — the one schema. Content = `01-prisma-schema.md` §1 verbatim, with these binding deltas:

1. **`WebhookRecord.bodyBytes Int` added** (C16): exact received bytes; sentinel `MAX_BODY_BYTES + 1` when overflow (UI renders "≥ 1 MB"). Supersedes 01 §2's "derived from `rawBody.length` — no column".
2. Everything else stands as written in 01: enums `Role{OWNER,MEMBER}`, `DestinationMethod{POST,PUT,PATCH}`, `RecordStatus{VERIFIED,REJECTED}`, `RejectReason{MISSING_SIGNATURE,INVALID_SIGNATURE,RATE_LIMITED,BODY_TOO_LARGE}`, `ReplayError{REPLAY_TARGET_BLOCKED,REPLAY_TIMEOUT,REPLAY_UPSTREAM_ERROR}`; models `User`, `Workspace`, `Membership` (`@@unique([workspaceId,userId])`), `Subscriber` (`ingestToken @unique` 64-hex, `hmacSecret` plaintext, `signatureHeaderName` default `X-Hub-Signature-256`, `revokedAt`/`rotatedAt` nullable, cascade from Workspace), `WebhookRecord` (replay self-FK `replayOfId` nullable, `onDelete: Cascade`, **not unique**; indexes `[subscriberId,receivedAt]`, `[receivedAt]`, `[replayOfId]`; `rawBody @db.Text`; replay leg fields `replayTargetUrl/responseStatus/responseBody/replayError/replayedAt/durationMs`), `RateLimitWindow` (`@@index([subscriberId,occurredAt])`, one row per **admitted** request only).
3. Generator/datasource (Prisma 7, verified):

```prisma
generator client {
  provider = "prisma-client"            // prisma-client-js deprecated in v7
  output   = "../src/generated/prisma"  // required in v7; gitignored; postinstall generates
}
datasource db {
  provider = "postgresql"               // NO url field — P1012 in v7.10.0; URL lives in prisma.config.ts
}
```

No `PENDING` status anywhere (C2). DB enum casing SCREAMING_SNAKE; wire snake_case via mappers (01 §8.4).

### 2.2 `backend/prisma.config.ts` (API verified against v7 reference)

```ts
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'npx tsx prisma/seed.ts' },
  datasource: { url: env('DATABASE_URL') },
});
```

Prisma 7 does not auto-load `.env` → `import 'dotenv/config'` is mandatory. Client construction (driver adapter **required**): `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })` inside `PrismaService` (`onModuleInit` init, `enableShutdownHooks`, `onModuleDestroy` `$disconnect`).

### 2.3 Migration approach (pick: `migrate dev` against docker postgres)

| Context | Command | Notes |
|---|---|---|
| **Local dev (canonical)** | `docker compose up -d postgres` → `npx prisma migrate dev --name init` | Reads config file; shadow DB catches drift; **v7 no longer runs generate or seed** → follow with explicit `npx prisma generate` (+ `npx prisma db seed` when seeding) |
| Schema change (any) | edit schema → `npx prisma migrate dev --name <change>` | Never `db push`; migrations are the only schema history (conventions §3) |
| **CI / prod deploy** | `npx prisma migrate deploy` | No shadow DB, no prompts, no generate; runs from `docker/app-entrypoint.sh` before `node dist/main.js` |
| **CI drift gate** | after deploy: `npx prisma migrate diff --exit-code --from-config-datasource --to-schema prisma/schema.prisma` | exits 2 if DB and schema disagree (C9); lives in the unit-test job |
| Offline only | `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` | eyeball initial SQL with no DB — never the creation path (C10) |

`generated/` is gitignored; typecheck/lint jobs run `prisma generate` first (root `postinstall` covers local clones).

---

## 3. Backend module map + endpoints

### 3.1 Modules (merge of 02 §11 + 03 §7)

| Module | Route ownership | Key providers / notes |
|---|---|---|
| `AppModule` | — | Global: `APP_PIPE` `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, **one** `APP_FILTER` (C21 filter), `APP_GUARD` JwtAuthGuard with `@Public()` opt-out, `ScheduleModule.forRoot()` **once**, nestjs-pino, joi env validation at bootstrap |
| `PrismaModule` (`@Global()`) | — | `PrismaService` + adapter-pg (C12 pins); root-anchored, registered once |
| `HealthModule` | `GET /health`, `GET /ready` (`@Public`) | ready = `SELECT 1` via Prisma (C19) |
| `AuthModule` | auth routes (3) | `JwtStrategy`, bcrypt (cost named constant, proposed 10); login: single `unauthorized` message (no user enumeration) |
| `WorkspacesModule` | workspaces routes (3) | `MembershipService.assertMember/assertOwner` — the permission matrix has one test site |
| `SubscribersModule` | subscriber routes (7) | `SecretService` (32-byte hex gen; rotate = new secret + window `deleteMany` **in one callback-style transaction** that first takes the §4.4 `pg_advisory_xact_lock(<subscriberId>::bigint)` before reading/replacing the secret); destination URL validation (http/https only) |
| `RecordsModule` | records routes (3) + stats (1) | **`RecordsRepository`** — canonical count helper is consumed here only (§4.3 of this plan / 02 §10) |
| `ReplayModule` | replay (1) | `SsrfGuard` helpers (`ssrf.ts` pure), `ReplayService` (`AbortSignal.timeout(REPLAY_TIMEOUT_MS)`, `redirect:'manual'`, credential redaction) |
| `IngestModule` (`@Public`) | `POST /ingest/:token` | raw-body middleware (registered in `main.ts`, §4.1), `HmacVerifier` (`common/crypto/hmac.ts`), `RateLimiter` (advisory-lock window), `CaptureService` (whitelist + single terminal insert) |
| `RetentionModule` (no routes) | — | `@Cron('0 0 3 * * *', { name:'retention', timeZone:'UTC' })` + window prune + log deleted count (C7/C13/C14) |

Conventions binding this table: DTO = class + class-validator; route ids via `@Param('id', ParseIntPipe)`; every status via `HttpStatus` enum (raw numeric = review blocker); Prisma P2002→409 / P2025→404 through the one filter; services never registered in two modules; cross-module reads via exports.

### 3.2 Endpoint index (02 §12 + Phase-0 health)

```
GET    /health                                   Public   —                          200
GET    /ready                                    Public   —                          200 | 503
POST   /api/auth/register                        Public   RegisterDto                201 | 400 | 409
POST   /api/auth/login                           Public   LoginDto                   200 | 400 | 401
GET    /api/auth/me                              JWT      —                          200 | 401
GET    /api/workspaces                           JWT      —                          200
POST   /api/workspaces                           JWT      CreateWorkspaceDto         201 | 400
DELETE /api/workspaces/:workspaceId              JWT owner —                         204 | 403 | 404
GET    /api/workspaces/:workspaceId/subscribers  JWT member —                         200 | 404
POST   /api/workspaces/:workspaceId/subscribers  JWT member CreateSubscriberDto      201 | 400 | 404
GET    /api/subscribers/:subscriberId            JWT member —                         200 | 404
PATCH  /api/subscribers/:subscriberId            JWT member UpdateSubscriberDto       200 | 400 | 404
POST   /api/subscribers/:subscriberId/rotate     JWT owner  —                         200 | 403 | 404
POST   /api/subscribers/:subscriberId/revoke     JWT owner  —                         200 | 403 | 404
DELETE /api/subscribers/:subscriberId            JWT owner  —                         204 | 403 | 404
GET    /api/subscribers/:subscriberId/records    JWT member ListRecordsQueryDto       200 | 400 | 404
GET    /api/workspaces/:workspaceId/records      JWT member ListRecordsQueryDto       200 | 400 | 404
GET    /api/records/:recordId                    JWT member —                         200 | 404
POST   /api/records/:recordId/replay             JWT member ReplayDto                 200 | 400 | 404 | 410 | 413 | 502 | 504
GET    /api/subscribers/:subscriberId/stats      JWT member —                         200 | 404
POST   /ingest/:token                            token    raw body                    200 | 401 | 404 | 410 | 413 | 429
```

Envelope (02 §1.2): success `{ data }`, list `{ data, meta:{ nextCursor, hasMore, total? } }`, error `{ error:{ code, message, details?, requestId } }`. Membership matrix (02 §3): rotate/revoke/delete (subscriber & workspace) owner-only → member gets 403, non-member gets **404** (never leak existence). Cursor pagination default (`receivedAt DESC, id DESC`), `offset` mode returns `meta.total`, mutually exclusive (400 if both).

### 3.3 `POST /ingest/:token` — THE single status-code contract

Merged from 02 §9.1 with C1/C2 applied (this table is normative; no other status exists — unexpected failures fall to 500 through the global filter):

| # | Outcome | HTTP | Body | Record saved? | `reason` | Counted in rate window? |
|---|---|---|---|---|---|---|
| 1 | unknown token | **404** | `error: not_found` | **no** | — | no |
| 2 | token revoked | **410** | `error: subscriber_revoked` | **no** (SPEC: revoked token's requests are not saved) | — | no |
| 3 | body > `MAX_BODY_BYTES` | **413** | `error: body_too_large` | **yes** (`status=REJECTED`, `rawBody=''`, sentinel `bodyBytes`) | `body_too_large` | **no** — size gate runs before the window (C1/C2; supersedes 02 §9.1 row 4's "yes") |
| 4 | window full | **429** + `Retry-After: <max(1, ceil seconds until oldest admitted row expires)>` | `error: rate_limited` | **yes** (`REJECTED`) | `rate_limited` | **no** — anti self-extending ban (SPEC) |
| 5 | signature header absent | **401** | `error: unauthorized`, `details.reason: missing_signature` | **yes** | `missing_signature` | yes |
| 6 | signature mismatch | **401** | `error: unauthorized`, `details.reason: invalid_signature` | **yes** | `invalid_signature` | yes |
| 7 | signature valid | **200** | `{ data: { recordId, status: 'verified' } }` | **yes** (`VERIFIED`) | — | yes |

`400 replay_target_blocked` **never** comes from ingest (belongs to replay only). If a request is both oversized and over-limit → **413 wins** (size precedence). Consequences to know: rows 5/6/7 are the only window-consuming outcomes, so an admitted flood recovers ≤60 s after traffic stops.

### 3.4 Constants (exact contents)

`backend/src/common/constants/ingest.constants.ts` (03 §0):
`RATE_LIMIT_WINDOW_MS = 60_000`, `RATE_LIMIT_MAX = 60`, `MAX_BODY_BYTES = 1024 * 1024`, `REPLAY_TIMEOUT_MS = 10_000`, `RETENTION_DAYS = 7`, `DEFAULT_SIGNATURE_HEADER = 'X-Hub-Signature-256'`, `SIGNATURE_PREFIX = 'sha256='`.
(Name reconciliation: 02 §1.6 calls the max `RATE_LIMIT_MAX_REQUESTS`; this plan's `RATE_LIMIT_MAX` wins — one name, one definition, per C8.)

**Advisory-lock key (§4.4):** both sides key on the subscriber id itself — `pg_advisory_xact_lock(<subscriberId>::bigint)`. `subscriberId` is an autoincrement `Int`, so it fits `bigint` without hashing; a text-hash key can collide across distinct subscribers and would silently serialize (or fail to serialize) the wrong pair. One key, one definition, same rule as `RATE_LIMIT_MAX`.

`backend/src/common/constants/app.constants.ts` (02 §1.6 + settled proposals): `TOKEN_BYTES = 32`, `LIST_LIMIT_DEFAULT = 25`, `LIST_LIMIT_MAX = 100`, `PASSWORD_MIN_LENGTH = 8`, `WORKSPACE_NAME_MAX_LENGTH = 80`, plus **proposed, confirm-or-amend in §9**: `JWT_TTL = '12h'` (C17), `BCRYPT_COST = 10`, `RESPONSE_BODY_MAX_BYTES = 1024 * 1024`, `MAX_DESTINATION_HEADERS = 20`, `MS_PER_DAY = 86_400_000` (C14), `BEARER_PREFIX = 'Bearer '`.

---

## 4. Ingest request lifecycle — the ONE state machine

Every implementation follows this order (03 §2, with C2's single-insert capture). **Record-then-respond always**: the record insert strictly precedes sending the response, so a crashed response never leaves an invisible request.

### 4.1 Bootstrap order in `main.ts` (non-negotiable)

```ts
const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
app.use('/ingest', ingestRawBodyMiddleware());   // 1) raw capture, BEFORE any JSON parser
app.use(express.json({ limit: '100kb' }));       // 2) everything else parses normally
app.use(express.urlencoded({ extended: true }));
```

Nest's `rawBody: true` stays **off** (global-only, would double-parse). Middleware: streams chunks, buffers while ≤ `MAX_BODY_BYTES`, at `MAX_BODY_BYTES + 1` **stops buffering AND reading** (C16 — no unbounded drain), sets `req.bodyOverflow`, never throws, `next()`. HMAC always reads `req.rawBody: Buffer` via `RawBodyRequest<Request>`; JSON parsed lazily only to extract `eventType` for storage. A `MiddlewareConsumer` registration runs after Nest's default parser — that is the exact ordering bug this design avoids.

### 4.2 Ordered steps

| # | Step | Outcome | Why here |
|---|---|---|---|
| 1 | Resolve token (index seek on `ingestToken`) | unknown → **404** no record; revoked → **410** no record; active → continue | Cheapest gate; nothing else matters if the endpoint doesn't exist. Revoked: persisting traffic defeats decommissioning (SPEC). |
| 2 | Body-size check (`bodyOverflow` flag — already computed by middleware) | overflow → **insert `REJECTED`/`body_too_large` record** → **413** | Before rate: oversized payload never becomes admitted quota (C1). Before HMAC: signing bytes we refuse to keep is meaningless. |
| 3 | Sliding-window rate check (advisory-lock transaction, §4.4) | full → **insert `REJECTED`/`rate_limited` record (NOT in window)** → **429** + `Retry-After` | Cheapest remaining DB gate before HMAC — under flood, a garbage signature must not burn 1 MB of hashing (03 §2 rationale). Rejected rows never enter the window (anti self-extending ban). |
| 3a | admitted → **write window row FIRST**, same transaction | fail-closed: if capture later fails, quota was still consumed — a broken DB can't bypass the limit | |
| 4 | Capture: pure `verifySignature(rawBody, headerValue, secret, headerName)` → **single insert with terminal status** (`VERIFIED`, or `REJECTED` + reason) | missing → `missing_signature`; no `sha256=` prefix / bad hex / wrong length / 1-byte diff → `invalid_signature`; length checked **before** `timingSafeEqual` (throws on unequal lengths) | C2: no `pending`. Whitelist headers (C15) only — cookies/`authorization` from misconfigured senders are dropped at capture, never stored. `timingSafeEqual` not `===` (string compare leaks prefix bytes via timing). **The HMAC secret is read at capture time (inside its transaction) under the §4.4 advisory lock — never cached from step 1.** Rotate's $transaction holds the same lock (see §4.4), so no ingest verifies with a pre-rotate secret after rotate commits. Bodies treated as UTF-8 end-to-end (non-UTF-8 unsupported, per SPEC).
| 5 | Respond | 200 `{data:{recordId,status:'verified'}}` / 401 + `details.reason` | Insert already committed (record-then-respond). |

**Encoding (capture step):** bodies are treated as UTF-8 end to end. HMAC is computed over the exact received bytes, but `rawBody` is `String @db.Text` — `Buffer.toString('utf8')` replaces invalid sequences — so **non-UTF-8 byte sequences are unsupported** (SPEC scopes binary/multipart **out of scope**) and replay re-sends the decoded string. No new §3.3 status row: the status contract stays frozen at its existing rows.

```mermaid
stateDiagram-v2
    [*] --> resolveToken
    resolveToken --> notFound404: unknown (no record)
    resolveToken --> revoked410: revoked (no record)
    resolveToken --> sizeCheck: active
    sizeCheck --> storeTooLarge413: overflow (record, NOT in window)
    sizeCheck --> rateCheck: ok
    rateCheck --> storeRateLimited429: window full (record, NOT in window)
    rateCheck --> captureAndVerify: admitted (window row FIRST)
    captureAndVerify --> verified200: signature ok (single terminal insert)
    captureAndVerify --> rejected401: missing/invalid (single terminal insert)
    storeTooLarge413 --> [*]
    storeRateLimited429 --> [*]
    verified200 --> [*]
    rejected401 --> [*]
```

### 4.3 Canonical count (the replay-count bug chokepoint)

```ts
// backend/src/common/prisma/record-count.ts — the ONLY place this filter exists
export const RECEIVED_WHERE = { replayOfId: null } satisfies Prisma.WebhookRecordWhereInput;
export const receivedWhere = (scope = {}) => ({ ...scope, ...RECEIVED_WHERE });
```

**Rule:** every number the UI shows — `SubscriberStats.received/verified/rejected/reasonBreakdown`, `SubscriberSummary.received/verified/rejected`, `WorkspaceSummary.receivedCount`, list `meta.total` — flows through `receivedWhere` inside `RecordsRepository` (02 §10). No other module may call `prisma.webhookRecord.count`; grep-level review check, documented in the PR body. **Never uses it:** replay-children queries (`replayOfId = <id>`), the `replays` stat (`replayOfId: { not: null }`), and the retention sweep (removes parents *and* cascaded replays). Regression test written FAILING first (§8).

### 4.4 Rate-limit concurrency + rotate reset

```sql
BEGIN;
SELECT pg_advisory_xact_lock($subscriberId::bigint);   -- key = subscriberId itself; ingest AND rotate share it (§3.4)
SELECT count(*) ... WHERE "subscriberId"=$1 AND "occurredAt" > now() - interval '60 seconds';
-- count < 60  → INSERT window row; COMMIT → continue to capture
-- count >= 60 → no insert; ROLLBACK → 429 path
```

- One row per admitted request only; clock source is PostgreSQL `now()` (single clock).
- **Lock semantics (both sides, one key):** ingest and rotate both take `pg_advisory_xact_lock(<subscriberId>::bigint)` — the subscriber id itself, never a text hash (§3.4). The rate-check transaction above uses that key, and **capture (step 4) re-takes/uses that same key in its transaction before verifying HMAC and inserting the terminal record**: the secret is NOT cached from step 1; it is read at capture time from the row under the same advisory lock. Rotate's `$transaction` acquires the **same** lock before reading/replacing the secret, so every in-flight ingest drains before the swap commits, and every ingest reaching capture after the swap reads the new secret. **Invariant: no ingest verifies with a pre-rotate secret after the rotate transaction commits.**
- **Rotate steps** (SPEC, one `$transaction(callback)`): (1) take the advisory lock above, (2) replace `hmacSecret`, (3) `rateLimitWindow.deleteMany({ subscriberId })` (01 §6) — one commit, so old secret invalidates immediately and the window reset is atomic with the swap. Revoke needs no reset (410 short-circuits at step 1); delete needs none (FK cascade).
- `Retry-After = max(1, ceil((oldestWindowRow.occurredAt + RATE_LIMIT_WINDOW_MS − dbNow) / 1000))` — the `max(1, …)` clamp is mandatory: the oldest window row can expire between the count and the response, which would otherwise yield ≤ 0.
- Boundary rule: `occurredAt > now()−60s` (exact-60s-old row excluded).

### 4.5 Replay + retention (contract only — details in 02 §6 / 03 §4)

- SSRF: `dns.promises.lookup(host, { all: true })` → **every** A/AAAA address must pass; block `127/8, 0/8, 10/8, 172.16/12, 192.168/16, 169.254/16` (metadata), `::1`, `fc00::/7`; **unwrap `::ffff:`-mapped IPv4 before matching** (03 §9 — must ship + test); DNS failure/empty ⇒ blocked (fail closed). Blocked → **400, no record, fetch never called** (C3).
- Send: `fetch(dest, { method: subscriber.destinationMethod, headers: { 'content-type': 'application/json', ...destinationHeaders }, body, signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS), redirect: 'manual' })` (C18). Success (any upstream status incl. 4xx/5xx) → insert replay row → **200** `ReplaySuccess`; timeout → insert (`replayError=REPLAY_TIMEOUT`) → **504** + `details.replayRecordId`; transport failure → insert (`REPLAY_UPSTREAM_ERROR`) → **502**. Response body truncated at `RESPONSE_BODY_MAX_BYTES`. Replay-of-replay allowed (`replayOfId` → acted-on row; canonical filter keeps counts flat). **Retention race (read vs insert):** retention can delete the original while a replay fetch is mid-flight, so the replay-row insert's `connect` on `replayOfId` throws **P2025** → catch it on that insert and respond **404** with the existing not-found error shape (`record expired between read and insert`) — never surface it as a 500. The reverse order needs no special case: a replay committed first is deleted with its parent by FK cascade.
- Retention: `@Cron('0 0 3 * * *', { timeZone: 'UTC' })` → `deleteMany({ receivedAt: { lt: now − RETENTION_DAYS*MS_PER_DAY } })` + `rateLimitWindow.deleteMany({ occurredAt: { lt: now − RATE_LIMIT_WINDOW_MS } })`; replay children go via FK cascade; **log `deleted N records older than 7d`** (SPEC observability).

---

## 5. Frontend (from 04, reconciled with 02/05-contract)

### 5.1 Routes

| Path | Page | Guard | Notes |
|---|---|---|---|
| `/login`, `/register` | `AuthPage` | public (redirect if token) | `?next=` return path |
| `/` | redirector | auth | → `/w/{localStorage['hooklab.lastWorkspaceId']}` if valid, else `/workspaces` |
| `/workspaces` | `WorkspaceListPage` | auth | create/select |
| `/w/:workspaceId` | `WorkspaceOverviewPage` | auth | subscriber list + create form + retention notice |
| `/w/:workspaceId/subscribers/:subscriberId` | `SubscriberDetailPage` | auth | **main screen**: timeline + detail + replay editor; selected record in `?record=<id>` (deep-link, poll-stable) |
| `*` | `NotFoundPage` | — | |

Route rename: 04's `endpoints/:endpointId` → **`subscribers/:subscriberId`** (C5). `RequireAuth`: no token → `<Navigate to="/login?next=…" replace/>`. Membership failures (403/404) render the "not a member" empty state — no client-side membership cache.

### 5.2 Components & data flow (04 §4–§5, unchanged except renames)

`AppShell` (header: brand + workspace switcher + user menu — both inline in `AppShell.tsx`, not standalone components) · `TimelineList` (listbox + roving tabindex, `TimelineTabs` verified|rejected|all, `SearchInput`) · `RecordDetail` (`JsonView`, `HeadersTable` — renders stored C15 whitelist headers only; cookies/authorization are dropped at capture and cannot appear — `ReplayEditor`, `ReplayComparison`) · `MetricsBadges` (props typed `{received,verified,rejected}` only — a records array cannot be passed in) · `SecretRevealModal` (create/rotate one-time reveal) · `ConfirmDialog` (focus starts on Cancel for destructive actions).

Data flow: TanStack Query v5, queryKeys `['records', subscriberId, tab, debouncedQ]` / `['stats', subscriberId]` / `['record', recordId]`; each `refetchInterval: () => (visible ? 2000 : false)` + `visibilitychange` pause, `staleTime 0`, list uses `placeholderData: keepPreviousData`; replay success → `invalidateQueries` records+record, **not** stats (badges canonical); selected record 404s mid-retention → clear `?record=`, toast "record expired (7-day retention)"; any 401 → logout + `/login?next=…`. Search param sent as **`q`**, debounced 300 ms (C5).

### 5.3 Endpoints consumed (= §3.2, every route)

register/login/me · GET/POST `/api/workspaces` · list/create subscribers · GET/PATCH subscriber · rotate/revoke/DELETE subscriber · `GET /api/subscribers/:id/records?q&status&cursor&limit&includeReplays` · `GET /api/workspaces/:id/records` (token search across subscribers) · `GET /api/records/:id` · `POST /api/records/:id/replay` · `GET /api/subscribers/:id/stats`. **Not consumed:** `GET /api/config` (doesn't exist — retention days come from `stats.retention.days`, fallback constant 7) (C5).

Replay error mapping (`mapReplayError`, pure): 400 `replay_target_blocked` → SSRF banner + destination edit link; 504 `replay_timeout` → "destination did not respond within 10 s" + retry; 502 `replay_upstream_error` → transport banner; **413 `body_too_large` → "body too large" banner, editor stays open (transport-cap rejection: the replay route parses with the same `MAX_BODY_BYTES` limit as ingest — probe-verified live, not a handler status)**; 404 → inline + clear selection; 410 → editor disabled with reason; success 200 → `ReplayComparison` with `outcome:'ok'` (04's `'success'` literal corrected to 02's `'ok'` — C4).

UI conventions (04 §9 = conventions §4): no gradients/decoration, IBM Plex Sans+Mono declared and shipped identically, OKLCH blue primary vs amber accent (hue delta ≥20°), body text ≥4.5:1 on `oklch(0.16 0.012 255)`, headings/landmarks semantic, `prefers-reduced-motion` kills the ≤120 ms transitions, 320 px single-column verified on rendered DOM, timeline `role="listbox"` keyboard contract.

---

## 6. Env, docker-compose, CI

**Binding CORS rule:** CORS disabled app-wide; `/api` and `/ingest` are same-origin only; never enableCors(origin:true)+credentials.

### 6.1 `.env.example` (committed; real `.env` gitignored; joi-validated at bootstrap — fail fast)

```
DATABASE_URL=postgresql://hooklab:hooklab@localhost:5432/hooklab
JWT_SECRET=            # openssl rand -hex 32 ; never committed, never logged
PUBLIC_BASE_URL=http://localhost:3000    # builds endpointUrl = ${PUBLIC_BASE_URL}/ingest/${ingestToken}
PORT=3000
```

Frontend needs **no env** (relative `/api` + Vite dev proxy; prod same-origin via Caddy). Secrets in code/config = blocker (conventions §6); `check-token-leak.sh` runs on push.

### 6.2 docker-compose services (3)

| Service | Image/build | Details |
|---|---|---|
| `postgres` | `postgres:16-alpine` | volume `pgdata`; healthcheck `pg_isready -U hooklab`; env from `.env` |
| `app` | build `backend/Dockerfile` | `TZ=UTC`; `depends_on: postgres: condition: service_healthy`; `command: docker/app-entrypoint.sh` → `npx prisma migrate deploy && node dist/main.js`; env `DATABASE_URL`, `JWT_SECRET`, `PUBLIC_BASE_URL`, `PORT` |
| `caddy` | build `frontend/Dockerfile` (multi-stage: vite build → caddy) | ports `80:80`, `443:443`; volumes `docker/Caddyfile` + `caddy_data`; serves `frontend/dist`, `handle /api/*` + `handle /ingest/*` → `reverse_proxy app:3000`; **no `request_body` size directive** (an edge 413 would bypass the record-then-413 contract); compression lives **only** here (conventions: exactly one compression layer); `/health` proxied for checks |

### 6.3 CI — `.github/workflows/ci.yml`, exactly 4 jobs (SPEC)

| Job | Steps |
|---|---|
| `lint` | checkout → setup-node (cache npm) → `npm ci` → `prisma generate` → `eslint --no-fix` in `backend/` **and** `frontend/` (zero warnings-as-errors for new code) |
| `typecheck` | `npm ci` → `prisma generate` → `tsc --noEmit` in both workspaces |
| `unit-test` | postgres:16 service container (healthcheck) → `npm ci` → `prisma generate` → `prisma migrate deploy` → **drift gate** `prisma migrate diff --exit-code --from-config-datasource --to-schema prisma/schema.prisma` (C9) → backend Jest → frontend Vitest |
| `docker-build` | `docker build` backend image + frontend image (no push; validates both Dockerfiles + entrypoint syntax) |

`npm ci` everywhere (lockfile committed). Branch protection requires all 4.

---

## 7. Build order — next workflows execute in this order

Each phase = one workflow. **Do not start a phase until the previous acceptance check is green.** (SPEC reality: 3 weeks; if slipping, cut search/filter inside P7 first — verify/replay/rate-limit are the interview signal and never cut.)

**Execution waves (fleet script = source of truth):** Wave A = **P1 ∥ P3 ∥ P5a** → Review A; Wave B = **P2 ∥ P4 ∥ P5b** → Review B, starting only after Review A is green — so P2's `rotate-race` spec (which exercises ingest) runs with P3's module already in place, at Review B, not at Wave-B start; frontend **P6 → P7 → P8** → integration; **P9 (infra track)** runs in parallel on disjoint files (docker/CI/docs only); **P10** last. The "previous acceptance green" rule binds at wave boundaries and between the sequential frontend phases; within a wave, phases are independent by construction (disjoint file ownership).

- [x] **P0 — Foundation** (now): root workspaces + lockfiles + `.env.example`/`.gitignore` · docker-compose postgres up · Prisma schema (§2) + `migrate dev --name init` + generate wired to postinstall · `main.ts` bootstrap order (§4.1) · global pipe/filter/guard+`@Public`/joi env validation · constants files (§3.4) · `PrismaService` (adapter-pg) · `/health` + `/ready` · nestjs-pino requestId · CI 4 jobs.
  **Acceptance:** `docker compose up -d postgres && npx prisma migrate dev` clean; `/health` 200, `/ready` 503-then-200 with DB; CI green on an empty test suite; `npm run build` passes under **CJS** (C11 gate).
  **Evidence (2026-10-10):** compose postgres up on host :5435; migration `20261008111025_init` applied; `/health` 200 + `/ready` 503-then-200 pinned in `health.controller.spec.ts` and `test/app.e2e-spec.ts`; `npm run build` exit 0 under CJS (`module: commonjs`, no `type` field); `ci.yml` = exactly 4 jobs — verified by reading the file; the workflow has never executed (repo is not under git and has no remote), so "CI green" is read-validated, not run-validated.
- [x] **P1 — Auth + workspaces + membership**: register/login/me, bcrypt, JWT guard + `@Public`, workspaces CRUD, `MembershipService` matrix.
  **Acceptance:** membership-matrix spec green (owner/member × all actions → 200/403/404 exactly); no user enumeration (login failures indistinguishable); P2002→409 `email_taken` via the one filter.
  **Evidence (2026-10-10):** `membership.service.spec.ts` + `workspaces.api.spec.ts` (owner/member × actions); `auth.api.spec.ts:185` "login failures are indistinguishable — unknown email vs wrong password"; `auth.api.spec.ts:148` P2002→409 `email_taken` via the one global filter. Full backend unit suite green: 21 suites / 277 tests.
- [x] **P2 — Subscribers**: create/list/detail/PATCH/rotate/revoke/delete; `SecretService` (32-byte hex); rotate = new secret only + window reset in one callback transaction that takes the §4.4 `subscriberId` advisory lock **before** reading/replacing the secret; secret exposed only in create + rotate responses (`secretHint` elsewhere); destination URL validation.
  **Acceptance:** rotate spec proves old secret fails immediately, window rows gone in same tx, token unchanged; owner-only routes return 403 to members; **concurrent rotate-vs-ingest race spec (§8.2) green — zero old-secret ingests succeed after the rotate transaction commits**; **destination-URL spec: `file://`/`ftp://`/scheme-less/credential-bearing (`http://user:pass@host`) URLs rejected 400 on POST + PATCH subscriber, plain `http://`/`https://` accepted (02 §4)**.
  **Evidence (2026-10-10):** `rotate-race.spec.ts:84` (secret swapped, token kept, window drained in one tx) + `:163` post-commit old-secret probes all 401; owner-only 403s throughout `subscribers.api.spec.ts`; `destination-url.spec.ts` rejects all four bad shapes on POST+PATCH and accepts plain http/https; `''` signatureHeader contract pinned both directions in `subscribers.api.spec.ts` (client must omit the key).
- [x] **P3 — Ingest (critical path)**: raw-body middleware, `verifySignature`, advisory-lock rate limiter, state machine (§4.2), 7-row contract (§3.3).
  **Acceptance:** table-driven spec = every §3.3 row (incl. "429 record exists AND window count unchanged", "413 before response", "404/410 never create") green; 10-parallel-vs-55 spec on real PG admits exactly 5; middleware cap/cap+1 specs green.
  **Evidence (2026-10-10):** `ingest.service.spec.ts` table over every §3.3 row; `rate-limit.service.spec.ts:266` "admits exactly 5 of 10 parallel attempts when 55 slots are already used" (real PG); `ingest-raw-body.middleware.spec.ts:42` exact-cap and `:72` cap+1 overflow; live 429+Retry-After leg in `test/app.e2e-spec.ts`.
- [x] **P4 — Records + stats**: list routes (cursor/offset, `q`, status, includeReplays), detail, stats, `RecordsRepository` canonical count (§4.3).
  **Acceptance:** **replayOfId regression test written FAILING first, then green** (§8); grep audit: no `webhookRecord.count` outside `record-count.ts`/repository; cursor stability under insert-at-head verified.
  **Evidence (2026-10-10):** `record-count.spec.ts` (regression written FAILING first per §8.1, then green); grep audit: `webhookRecord.count` occurs only in `records.repository.ts` (the §4.3 home) + the generated Prisma client; `records.repository.spec.ts:210` "cursor paging stays stable when a new record lands at the head".
- [x] **P5 — Replay + retention**: SSRF table incl. `::ffff:` unwrap + boundaries, fetch contract (C4/C18), 6-field UTC cron + window prune + deleted-count log.
  **Acceptance:** ssrf/replay specs green (blocked → 400 no record + fetch-not-called; timeout row; 502 row; 200 success); retention spec deletes >7d + cascades replays + logs count; cron fires once (UTC) — module-introspection asserts exactly one job registered under name `retention` (guards the C7 double-`forRoot` hazard, not just the expression string).
  **Evidence (2026-10-10):** `ssrf.spec.ts` (incl. `::ffff:` unwrap + boundaries) and `replay.service.spec.ts` (blocked → 400 no record + fetch not called; timeout; 502; 200) green; `retention.service.spec.ts:93` asserts `[...registry.getCronJobs().keys()]` equals exactly `[RETENTION_CRON_NAME]` (C7 introspection) and `:99` pins the 6-field UTC expression; deleted-count log at `retention.service.ts:34`.
- [x] **P6 — Frontend core**: scaffolding (Vite, router, tokens), auth pages, workspace list/overview, subscriber CRUD, `SecretRevealModal`, `ConfirmDialog`.
  **Acceptance:** Vitest specs (`RequireAuth` `?next=`, `ConfirmDialog` focus/Escape) green; login → create workspace → create subscriber → reveal secret works against local compose; `npm run build` passes.
  **Evidence (2026-10-10):** `RequireAuth.spec.tsx:35` (`?next=` round-trips full path+query), `ConfirmDialog.spec.tsx` (focus on Cancel for destructive, focus on confirm otherwise, Escape cancels); the full flow was exercised live against local compose on 2026-10-09 (throwaway user, real HTTP) and again for the SubscriberForm fix on 2026-10-10; `npm run build` (tsc --noEmit && vite build) exit 0.
- [x] **P7 — Frontend timeline**: `useTimeline` 2s poll + visibility pause, tabs, search (`q`, 300 ms debounce), `?record=` detail, `MetricsBadges` from stats only, `JsonView` fallback.
  **Acceptance:** polling pause/resume spec (fake timers) green; metrics regression spec (counts unchanged after replay) green; **search/filter specs green: status tab (verified|rejected|all) returns only that status's rows; `q` = event-type substring on subscriber records and workspace-level token-prefix search across subscribers return the filtered rows, empty state when no match**; live flow: signed curl appears in ≤2 s without refresh; RetentionNotice renders "records auto-delete after 7 days" with days from `stats.retention.days` (fallback 7); 320 px check = component renders single-column at 320 px on rendered DOM (§6 UI conventions, not a pixel screenshot).
  **Evidence (2026-10-10):** `useTimeline.spec.tsx` (fake timers + `visibilitychange` pause/resume, 5 its); `useDebouncedValue.spec.ts` (300 ms); `TimelineTabs.spec.tsx` (status tabs, 6 its); `WorkspaceOverviewPage.spec.tsx` (q/status filtering + empty state); `MetricsBadges.spec.tsx` includes the counts-unchanged-after-replay regression; live ≤2 s leg was exercised on 2026-10-09 in the compose drill (signed curl appeared without refresh); `RetentionNotice.spec.tsx:18` "7 days by default" + `:23` server-provided days; 320 px is pinned at the token/layout level (`app.css:486` single-column at 320px) and in `MetricsBadges.spec.tsx:138` wrap spec — jsdom has no layout engine, so this is a rendered-DOM check, not a pixel check, per §6.
- [x] **P8 — Frontend replay**: `ReplayEditor` (JSON validation, `aria-invalid`), `mapReplayError` (every §6-of-04 row against 02 statuses), `ReplayComparison`.
  **Acceptance:** `replayErrors.spec.ts` covers 200/400/413/502/504/404/410/network-fail; invalid JSON never submits; replayed payload visibly round-trips to destination.
  **Evidence (2026-10-10):** `replayErrors.spec.ts` — table-driven over the whole 04 §6 matrix (transport rows + 404 hint with server retention window + ApiError passthrough + non-API throw), plus the non-empty/single-purpose banner sweep; `ReplayEditor.spec.tsx` pins invalid-JSON-never-submits; round-trip of the edited payload to the destination is verified end-to-end at the API layer in `test/app.e2e-spec.ts` (outbound leg carries the EDITED bytes, not the capture).
- [ ] **P9 — Deploy/CI hardening**: Dockerfiles, Caddyfile, app entrypoint (`migrate deploy`), VPS + Caddy TLS, `scripts/loadtest.mjs`.
  **Acceptance:** `docker compose up` on a clean VPS serves UI over HTTPS; `POST /ingest/:token` public works end-to-end; **500 req/5 min: every response 200 or 429 with `Retry-After`, zero timeouts**; retention log line observed; docker-build CI job green.
  **Status (2026-10-10) — NOT fully verifiable here; left open:** artifacts exist and were exercised as far as this machine allows. DONE: `docker compose up` full stack locally (UI served, `POST /ingest/:token` public end-to-end, drill recorded in DEPLOY.md §4.1/§5.2); load-test gate **PASS — 500/500 answered in 299.4 s (300 ok + 200 rate-limited, zero timeouts; p50 22 ms / p95 45 ms / p99 91 ms; exit 0)**; entrypoint runs `migrate deploy` then `exec node dist/main.js` (read); `docker/Caddyfile` (compose, plain :80) and `docker/Caddyfile.prod` (TLS) exist; CI `docker-build` job builds both images without push (read-validated — the workflow has never run: no git remote). NOT DONE / NOT OBSERVED: clean-VPS HTTPS deploy (no VPS or domain available from this machine; also an outward-facing action requiring the owner); the retention cron log line was not observed live (the job fires once daily at 03:00 UTC, so a short drill cannot see it) — it is pinned by `retention.service.spec.ts` instead.
- [ ] **P10 — Review**: sweep conventions §6 checklist (0 magic numbers/empty catches/`any`-without-reason; `HttpStatus` enum only; DTO pipes; transaction tests; mass-test-update audit), frontend §4 checklist (WCAG AA dark, reduced-motion, landmarks, 320 px), Chesterton's Fence notes for any deletion, **PR body written by a human** (what + why + decisions; AI-assisted disclosed).
  **Acceptance:** checklist signed off; no open §9 item silently resolved.
  **Status (2026-10-10) — in progress:** the frontend §4 a11y half (WCAG AA dark, reduced-motion, landmarks, headings, 320 px rendered-DOM) is closed by the axe + token-contrast + shell-contract gate (W6), verified green on 2026-10-10: 7 gate specs (`tokens.a11y.spec.ts`, `shell-a11y.spec.ts`, `AuthPage.a11y.spec.tsx`, `WorkspaceListPage.a11y.spec.tsx`, `AppShell.a11y.spec.tsx`, `SecretRevealModal.a11y.spec.tsx`, `SubscriberForm.a11y.spec.tsx`) land inside the full frontend suite — **49 files / 277 tests pass**; the adversarial verifier (high effort) confirmed `verdict: "verified"` with 7 mutations each turning a gate RED then md5-restored byte-identical, no vacuous specs, and an independent Python OKLCH→contrast implementation agreeing with the spec's numbers within rounding. Conventions §6 backend checklist and the accepted Rust dead-code report items were re-checked after the supply-chain change (2026-10-10): `npm ci` on the regenerated lockfile, `npx prisma generate` exit 0, `migrate status` = up to date (1 migration), backend jest **21 suites / 277 tests pass**, backend e2e **2 suites / 10 tests pass** (incl. cors.e2e-spec), frontend `tsc 0 / vitest 49×277 / eslint 0 / build exit 0`. PR-body clause is N/A: the project is not a git repository and has no remote, so no PR exists to write. **Dev-toolchain upgrade (2026-10-10, same P10 pass):** jest 29.7.0→30.5.2, @types/jest 29.5.14→30.0.0, ts-jest manifest range ^29.3.4→^29.4.14 (resolved 29.4.14 in **both** lockfiles — checked against the pre-upgrade backup), vitest 3.2.7→4.1.11; @types/react-dom 18.3.7 flipped dev→devOptional in the lockfile metadata with the same resolved version + integrity (an arborist artifact of the npm-11 regeneration, not a real change) — dev-inclusive audit **37 (2 critical, 29 high) → 20 moderate (0 critical, 0 high)**; the npm-10.9.2 arborist `#loadPeerSet` crash on vitest-4 resolution was root-caused and worked around by regenerating the lockfile with npm 11.21.0; `npm ci` with npm 10.9.2 on the regenerated lockfile exits 0; backend tsc/lint clean on @types/jest 30; one frontend spec retype (`MockInstance<typeof document.addEventListener>` — vitest 4 makes `ReturnType<typeof vi.spyOn>` collapse to `any`) proved load-bearing via mutation (detach → RED → byte-identical restore); all suites re-run green on the new toolchain (backend jest 21×277, e2e 2×10, frontend tsc/vitest 49×277/eslint/build 0), and the prod dependency closure is **identical** to the previous lockfile — verified twice (JSON resolver walk + real `npm ci` of both lockfiles in clean dirs, filesystem walk, 316 packages / 0 diffs). Bundle baselines re-anchored and re-measured: jsRaw 325,561 / jsGzip 102,112 / cssRaw 13,473 / cssGzip 2,777 via zlib-9 exactly as ci.yml measures; 0/4 metrics over the 1.15 threshold. Both Docker images build on the new lockfile; frontend image ships the exact baseline bytes as of that morning measurement (js moved to 330,994 with the day's later destination-auth work — see the byte-correction note below). **Final corrections pass (2026-10-10, same P10 pass):** ci.yml gzip + audit comments corrected, BUILD_PLAN ts-jest claim corrected, both Dockerfile "no .dockerignore" claims corrected, `.dockerignore` root-anchored→depth-agnostic (`**/` forms; probe proved nested backend/.env was NOT excluded before; `**/.playwright-mcp` added; only `.env.example` survives at both depths), frontend vitest config hardened (`retry` + `testTimeout` — the Vitest-4 key is `retry`; the pre-4 `retries` was caught by tsc TS2769 through `npm run build` and failed the caddy image build, then fixed and re-verified) — all six applied and re-verified same day: prisma seed idempotent (40 users, exit 0), backend e2e 2×10 PASS on final tree, zero-spec-surface audit 48 sources / 49 specs / 0 uncovered, both compose images rebuild green, shipped assets byte-exact on the morning image (js 325,561 / css 13,473 — the day's later destination-auth work moved js to 330,994; see the byte-correction note below), services postgres/app/caddy. **Full evidence + honest open items (P9 clean-VPS HTTPS, retention cron natural 03:00 UTC run, PR-body N/A, SIGSEGV matrix) in `docs/AUDIT_2026-10-10.md` §7 — the LICENSE and coverage-config half of that list as first written here was closed the same day in the owner-closeout pass (§12).** **Byte correction (2026-10-11):** the 325,561/102,112 pair above is the morning re-anchor (js md5 `1760cb89…` on the 03:41 image); the day's later frontend work grew the bundle — a fresh build and the rehearsal image both ship **js 330,994 B** (md5 `7e3500c6…`), css still 13,473 B; both remain 0/4 under the 1.15 gate (AUDIT §12). Re-check before signing off.

---

## 8. Testing plan

Runner split (SPEC note): **backend Jest** (NestJS default — Vitest fights `emitDecoratorMetadata`), **frontend Vitest**. Conventions for every backend spec: `.spec.ts` colocated with source (e2e `.e2e-spec.ts` in `backend/test/`), mock `PrismaService` **by token** (`overrideProvider(PrismaService)`), `app.init()` in `beforeAll` + `app.close()` in `afterAll`, `.expect(status).expect(body)` chained.

### 8.1 The regression test (bug-fix protocol — write FAILING, then fix, then green)

`backend/src/common/prisma/record-count.spec.ts`:

```ts
it('counts only originals after replays are written (replayOfId count bug)', async () => {
  // 1. seed: 1 original + 2 replay rows (replayOfId -> original.id)
  // 2. RED first: under pre-fix code (replays stored with replayOfId: null) this FAILS at 3
  const received = await prisma.webhookRecord.count({ where: receivedWhere() });
  expect(received).toBe(1);
  // 3. fix: replay inserts carry replayOfId; every metric routes through receivedWhere
  // 4. extra assertions (same test): verified/rejected stats unchanged by the 2 replays;
  //    timeline default listing excludes them; `replays` stat (replayOfId not null) === 2
});
```

Sequence is mandatory: test commits RED → fix lands → green → grep audit (`webhookRecord.count` only in `record-count.ts`/`RecordsRepository`) noted in the PR body. Never accept a mass test update without per-change audit (conventions §5).

### 8.2 Backend Jest specs (colocated `*.spec.ts`)

| Spec | Must prove |
|---|---|
| `common/crypto/hmac.spec.ts` | RFC 4231 case-2 ("Jefe") vector through `verifySignature`; valid `sha256=<hex>` over exact bytes; missing header → `missing_signature`; no-prefix/odd-length/non-hex/1-byte-flip → `invalid_signature`; 63-char hex does **not** throw (length before `timingSafeEqual`); `{"a":1,"b":2}` vs reordered bytes differ (capture-not-reparse proof) |
| `ingest/middleware/ingest-raw-body.middleware.spec.ts` | exactly `MAX_BODY_BYTES` → buffered, no overflow; `+1` → `bodyOverflow`, buffered ≤ cap+1 even when stream offers 10 MB, reading stopped; non-JSON bytes pass untouched |
| `ingest/rate-limit.service.spec.ts` | 59-in-window admits (inserts window row), 60 rejects (never calls `rateWindowRow.create`); boundary `now−60s` excluded, `now−59.9s` included; `Retry-After` = `max(1, ceil(...))` — deterministic clock **advanced 1 s between the count and the response, assert `Retry-After ≥ 1`** (oldest-row-expiry edge, §4.4); **10 parallel vs 55-in-window → exactly 5 admitted on real PG** (advisory lock, CI service container) |
| `ingest/ingest.service.spec.ts` | one case per §3.3 row: 404/410 never `create`; 413 record created **before** the response (`invocationCallOrder`); 200/401/401 with exact `reason`; exactly one row per request; oversized+over-limit → 413 (C1 precedence) |
| `records/records.repository.spec.ts` | canonical counts (8.1 regression), cursor paging stability, `includeReplays` toggle, `meta.total` goes through helper |
| `replay/ssrf.spec.ts` | every blocked boundary (`127.0.0.1`, `127.255.255.255`, `10.0.0.1`, `172.16.0.1`, `172.31.255.255`, `192.168.1.1`, `169.254.169.254`, `0.0.0.0`, `::1`, `fc00::1`, `fd12:3456::1`, **`::ffff:127.0.0.1`**), allowed (`8.8.8.8`, `93.184.216.34`, `2606:4700::1111`), mixed A+AAAA → blocked, DNS failure → blocked (fail closed) |
| `replay/replay.service.spec.ts` | blocked → 400, **no record**, `fetch` mock throws if called; timeout → record `REPLAY_TIMEOUT` + 504; transport → record + 502; success → 200 + row with `responseStatus/body/durationMs`; subscriber revoked → 410 no record; original deleted mid-flight → insert P2025 → **404** not-found shape (§4.5 retention race) |
| `common/membership/membership.service.spec.ts` | full matrix (02 §3): every role × action cell → 200/403/404 |
| `auth/*.spec.ts` | register P2002→409 `email_taken`; login identical failure for unknown email vs wrong password; `@Public()` routes skip guard |
| `subscribers/*.spec.ts` | rotate: new secret invalidates old, token unchanged, `deleteMany` window in same tx under the §4.4 advisory lock; revoke: `revokedAt` set, ingest then 410 |
| `subscribers/rotate-race.spec.ts` | **concurrent rotate-vs-ingest regression (gates §7 P2):** spawn ~10 ingests signed with the old secret, fire rotate mid-flight; assert **zero old-secret ingests succeed AFTER the rotate transaction commits** (every post-commit outcome is 401 `invalid_signature`, no `VERIFIED` row); window rows reset in the same tx |
| `subscribers/destination-url.spec.ts` | POST/PATCH reject `file://`, `ftp://`, scheme-less, and credential-bearing URLs (`http://user:pass@host`) with 400; `http://`/`https://` plain-host URLs accepted (02 §4) |
| `retention/retention.service.spec.ts` | deletes `receivedAt < 7d`, replays cascade, window rows pruned, logs count; cron expression = 6-field UTC (C7); module introspection: exactly one scheduled job named `retention` (no double `ScheduleModule.forRoot()`) |
| `test/app.e2e-spec.ts` | happy path: register → workspace → subscriber → **signed** `POST /ingest/:token` → 200 + record visible → replay → stats received unchanged |

### 8.3 Frontend Vitest + Testing-LC (04 §11, renames applied)

`lib/replayErrors.spec.ts` (every row: 200/400/413/502/504/404/410/network-fail against 02 shapes) · `ReplayEditor.spec.tsx` (invalid JSON → `aria-invalid` + no submit; valid → `onSubmit`; disabled renders reason) · `JsonView.spec.tsx` (pretty-print; falls back to raw text labeled) · `hooks/useTimeline.spec.tsx` (**fake timers**: 2000 ms refetch; hidden → stops; visible → resumes; tab/search swaps queryKey) · `MetricsBadges.spec.tsx` (**regression**: rendered counts unchanged after simulated replay invalidation) · `useDebouncedValue.spec.ts` (300 ms collapse) · `ConfirmDialog.spec.tsx` (Escape cancels; focus on Cancel for destructive) · `RequireAuth.spec.tsx` (`?next=` redirect) · `TimelineList.spec.tsx` (ArrowUp/Down roving focus, Enter selects; **tab click renders only verified|rejected|all rows; search `q` filters visible rows, debounced via `useDebouncedValue`**) · `RetentionNotice.spec.tsx` (days from `stats.retention.days`, fallback 7; copy "records auto-delete after 7 days").

Out of unit scope: Caddy/Docker, live 2s timing (Playwright e2e deferred — §9), pixel layout.

---

## 9. Open risks / deferred decisions

**Risks (known, accepted, or gated):**

1. **`01-prisma-schema.md` was authored concurrently with this plan** (it did not exist when reading started). §2 embeds its schema plus binding deltas (`bodyBytes`); if 01 is edited after this file, **this plan wins** and the delta must be re-reconciled into 01 — not vice versa.
2. **Proposed constants need confirm-or-amend** (§3.4): `JWT_TTL='12h'`, `BCRYPT_COST=10`, `RESPONSE_BODY_MAX_BYTES=1MB`, `MAX_DESTINATION_HEADERS=20`, sentinel semantics of `bodyBytes = MAX_BODY_BYTES+1`. Values are named and isolated — amending them is a one-line change, never a refactor.
3. **Prisma 8 trap**: npm `latest` dist-tag for `prisma` is already 8.0.0-rc. Install scripts must pin `7.10.0` exactly (C12); dependency bots must be configured to ignore major bumps on `prisma*` until an upgrade pass.
4. **Auth/write-endpoint rate limiting** (conventions §3) deferred — SPEC scopes rate limiting to ingest only. Mitigations in place: bcrypt cost 10 + non-enumerating login. Tracked as a post-demo item, not silently dropped.
5. **JWT in `localStorage`** (04 §12): XSS tradeoff accepted for scope; httpOnly cookie + refresh needs a backend change — flag if security review demands it.
6. **DNS-rebinding TOCTOU** (03 §4.2): resolve→validate→fetch without IP pinning, out of scope for 1-worker demo; documented follow-up = `{ lookup }` re-validation at connect. **But `::ffff:` normalization ships now** (tested — §8.2).
7. **Ingest oversized-body DoS surface**: reading stops at cap+1 (C16) so memory is bounded, but the socket still ties a connection until response+close; admitted-traffic flood is bounded by 60/min, oversized flood is not rate-gated (size gate runs first, C1). Accepted for v1; edge hardening (Caddy `request_body` limits) would break the 413+record contract if misconfigured — **do not add a Caddy body limit below the app cap**.
8. **Crash between insert and response** leaves a terminal record with no client response (C2 — no `pending` cleanup needed). Observable, benign, documented.
9. **Playwright e2e deferred** (SPEC stack names Vitest unit only); live-VPS demo (SPEC story) is a manual P9 acceptance, not automated.
10. **02 §14 items resolved here** (no longer open): member-management endpoints deferred; workspace aggregate stats deferred (list carries one `receivedCount`); content-type allowlist deferred (bytes ≤1 MB accepted, UTF-8-decoded per §4.2 — binary/multipart stay out of scope as a *supported* feature, no special handling); `ReplayDto` objects only (arrays → 400); delta polling deferred; `/health`+`/ready` → Phase 0 (C19); `JWT_TTL` → 12h (C17).

**Deliberately deferred (explicitly out, revisit only with new evidence):** light theme · httpOnly JWT · JSON syntax highlighting · `/api/config` · i18n · "All"-tab niceties beyond 04's optional flag · member invite/remove API · auto-retry/queue for replay · binary/multipart payloads · alerting · analytics charts · multi-region · search/filter **cut first** if the 3-week schedule slips (SPEC REALITY), never verify/replay/rate-limit.

---
**Version:** 1.0.0 (2026-10-08) · Author: plan agent · Status: binding for implementation workflows · Maintainer: dev (kronosss2002)
