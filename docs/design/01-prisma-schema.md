# 01 — Prisma Schema (HookLab data model)

> Design only · authoritative spec: `docs/SPEC.md` · serves: `docs/design/02-api-contract.md` (envelope, status codes, canonical count), `docs/design/03-ingest-pipeline.md` (sliding window, record lifecycle, retention).
> Prisma 7 facts (generator `output` required, `prisma.config.ts`, driver adapters, `migrate diff` flags) verified against the official upgrade guide and CLI reference — see §7. The §1 schema block itself was run through `prisma validate` and `prisma migrate diff --from-empty --to-schema --script` on Prisma CLI 7.10.0 (both pass).

---

## 1. `schema.prisma`

```prisma
// prisma/schema.prisma — HookLab

generator client {
  provider = "prisma-client"          // prisma-client-js is deprecated in v7
  output   = "../src/generated/prisma" // output is REQUIRED in Prisma 7
}

datasource db {
  provider = "postgresql"
  // url lives in prisma.config.ts — a `url` line here is a hard validation error in v7 (verified, P1012)
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

enum Role {
  OWNER
  MEMBER
}

enum DestinationMethod {
  POST
  PUT
  PATCH
}

enum RecordStatus {
  VERIFIED
  REJECTED
}

enum RejectReason {
  MISSING_SIGNATURE
  INVALID_SIGNATURE
  RATE_LIMITED
  BODY_TOO_LARGE
}

enum ReplayError {
  REPLAY_TARGET_BLOCKED
  REPLAY_TIMEOUT
  REPLAY_UPSTREAM_ERROR
}

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

model User {
  id           Int          @id @default(autoincrement())
  email        String       @unique
  passwordHash String
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt
  memberships  Membership[]
}

model Workspace {
  id          Int          @id @default(autoincrement())
  name        String
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  memberships Membership[]
  subscribers Subscriber[]
}

model Membership {
  id          Int       @id @default(autoincrement())
  workspaceId Int
  userId      Int
  role        Role
  createdAt   DateTime  @default(now())
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, userId])
  @@index([userId])
}

// ---------------------------------------------------------------------------
// Ingest endpoint + destination
// ---------------------------------------------------------------------------

model Subscriber {
  id                  Int                @id @default(autoincrement())
  workspaceId         Int
  name                String
  ingestToken         String             @unique // 32 random bytes as hex → 64 chars (SPEC)
  hmacSecret          String             // plaintext by necessity: server computes HMAC over it
  destinationMethod   DestinationMethod  @default(POST)
  destinationUrl      String
  destinationHeaders  Json?              // optional per CreateSubscriberDto
  destinationAuth     Json?              // per-subscriber outbound credential (02 §4): null | {type:'bearer'|'basic'|'apiKey', …} — nullable so a subscriber with none is DbNull, never an empty object
  signatureHeaderName String             @default("X-Hub-Signature-256")
  revokedAt           DateTime?          // ingest answers 410, writes no record
  rotatedAt           DateTime?
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt
  workspace           Workspace          @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  records             WebhookRecord[]
  rateLimitWindows    RateLimitWindow[]

  @@index([workspaceId])
}

// ---------------------------------------------------------------------------
// Captured request (originals AND replays share this table)
// ---------------------------------------------------------------------------

model WebhookRecord {
  id           Int            @id @default(autoincrement())
  subscriberId Int
  method       String
  url          String         // full original request URL (path + query)
  headers      Json           // WHITELIST only, keys lowercased — captured before verify
  rawBody      String         @db.Text // exact received bytes as utf8; ≤ 1MB enforced in middleware
  bodyBytes    Int            // exact byte count; sentinel MAX_BODY_BYTES + 1 on overflow (C16)
  status       RecordStatus
  rejectReason RejectReason?  // null iff status = VERIFIED
  eventType    String?        // best-effort: body.type / body.event / x-event-type header
  receivedAt   DateTime       @default(now())

  // Replay: this row's own request copy + the outbound leg's outcome
  replayOfId       Int?
  replayOf         WebhookRecord?  @relation("RecordReplay", fields: [replayOfId], references: [id], onDelete: Cascade)
  replays          WebhookRecord[] @relation("RecordReplay")
  replayTargetUrl  String?         // destination actually targeted for this replay
  responseStatus   Int?            // upstream status; null on timeout/transport failure
  responseBody     String?  @db.Text // truncated at RESPONSE_BODY_MAX_BYTES
  replayError      ReplayError?
  replayedAt       DateTime?
  durationMs       Int?

  subscriber Subscriber @relation(fields: [subscriberId], references: [id], onDelete: Cascade)

  @@index([subscriberId, receivedAt]) // timeline list (receivedAt DESC, id DESC via backward scan)
  @@index([receivedAt])               // 7-day retention sweep + oldestKeptAt
  @@index([replayOfId])               // replay children lookup + efficient cascade delete
}

// ---------------------------------------------------------------------------
// Sliding-window rate limit — one row per ADMITTED request only
// ---------------------------------------------------------------------------

model RateLimitWindow {
  id           Int        @id @default(autoincrement())
  subscriberId Int
  occurredAt   DateTime   @default(now())
  subscriber   Subscriber @relation(fields: [subscriberId], references: [id], onDelete: Cascade)

  @@index([subscriberId, occurredAt])
}
```

---

## 2. Per-model notes

### User / Workspace / Membership
- `User.email @unique` → collision surfaces as P2002, mapped to `409 email_taken` by the global filter (02 §1.3).
- Workspace `name` has no uniqueness — the contract never requires it, and duplicate names are harmless.
- `Membership @@unique([workspaceId, userId])` stops duplicate rows (double-owner) at the DB, not by convention; `@@index([userId])` backs "list my workspaces" because the unique index leads with `workspaceId` and cannot serve a `userId`-only lookup.
- Cascades: deleting a Workspace deletes its Memberships and Subscribers, and the Subscriber cascade below carries records + window rows with it.

### Subscriber
- `ingestToken @unique` makes ingest step 1 ("resolve token") an index seek; 32 bytes of entropy makes collision a non-event, but the unique still routes an accidental clash to P2002→409.
- `hmacSecret` stored in plaintext: the server must compute HMAC over incoming bodies, so encryption at rest would only move the problem — exposure is controlled by routing (full secret only in create/rotate responses, `secretHint` elsewhere, 02 §4).
- `destinationHeaders Json?` is nullable because `destinationHeaders` is `@IsOptional()` in the DTO; `destinationMethod @default(POST)` mirrors the DTO default. `signatureHeaderName @default("X-Hub-Signature-256")` = `DEFAULT_SIGNATURE_HEADER`.
- `destinationAuth Json?` (added by migration `20261010045651_destination_auth`) holds the per-subscriber outbound credential, masked on read-back (`…last4` hints, 02 §4). The replay leg binds it last so it outranks any `destinationHeaders` entry naming the same header — names are folded case-insensitively (HTTP field names are), so a stale `Authorization` in the header map can never comma-join with the credential on the wire.
- Cascade: Workspace → Subscriber (`onDelete: Cascade`) → `WebhookRecord` + `RateLimitWindow`, so `DELETE /api/subscribers/:id` (owner-only, 02 §4) destroys its traffic history in one DB statement.

### WebhookRecord
- Indexes: `(subscriberId, receivedAt)` serves the per-subscriber timeline ordered `receivedAt DESC` (backward index scan) and per-subscriber counts; `(receivedAt)` serves the retention sweep (§4) and the `oldestKeptAt` stat; `(replayOfId)` backs the replay-children query in `RecordDetail` **and** makes the cascade in `deleteMany` an index lookup instead of a sequential scan.
- `rejectReason` is nullable and app-enforced: `status = VERIFIED ⇒ rejectReason = null`, `status = REJECTED ⇒ rejectReason set` (every rejected row in 02 §9.1 carries a reason).
- **Cascade on `replayOfId` (`onDelete: Cascade`)**: deleting an original deletes its replay rows — retention's `deleteMany` on old originals depends on this to satisfy SPEC ("xóa record cũ hơn 7 ngày kèm replay của chúng") without a second query. A newer replay of an old original dies with its original; that is the SPEC behavior, not a bug.
- Replay rows **copy `method`/`url`/`headers`/`rawBody` from the original** so the detail view renders exactly what was re-sent without a join and survives later edits, while `replayTargetUrl`/`responseStatus`/`responseBody`/`replayedAt` hold the outbound leg (where it went and what came back) — decision made in 02 §6, not reopened here.
- No `updatedAt`: records are audit rows written once (ingest writes terminal status in a single insert — Reconciliation note 5); `receivedAt` is the only timestamp the contract exposes.
- `bodyBytes Int` (02 `RecordListItem`) is a stored column (C16): exact received bytes when ≤ `MAX_BODY_BYTES`, sentinel `MAX_BODY_BYTES + 1` on overflow (middleware stops buffering at `MAX_BODY_BYTES + 1`; UI renders "≥ 1 MB"). Deriving it from `rawBody.length` is impossible for oversize rows and counts UTF-16 units, not bytes.

### RateLimitWindow
- Exactly one row per **admitted** request; a `rate_limited` rejected record never inserts here (anti self-extending ban, 03 §3.2).
- Composite `@@index([subscriberId, occurredAt])` serves both queries the limiter makes: `count(*) WHERE occurredAt > now()-60s` and the `Retry-After` oldest-row lookup (`ORDER BY occurredAt ASC LIMIT 1`); it also covers the prune of rows older than the window (§4).
- Cascade: deleting a Subscriber deletes its window rows; rotate uses an explicit `deleteMany` instead (§6).

---

## 3. Canonical count — THE one "requests received" query

```ts
// src/common/prisma/record-count.ts — single source of truth
import { Prisma } from '../../generated/prisma/client';

/** Canonical "requests received" filter. Every metric/badge reuses it. */
export const RECEIVED_WHERE = {
  replayOfId: null,
} satisfies Prisma.WebhookRecordWhereInput;

export function receivedWhere(
  scope: Prisma.WebhookRecordWhereInput = {},
): Prisma.WebhookRecordWhereInput {
  return { ...scope, ...RECEIVED_WHERE };
}

// The only shape callers may use:
const received = await prisma.webhookRecord.count({
  where: receivedWhere({ subscriberId }),
});
```

**Rule:** every count the UI shows — `SubscriberStats.received/verified/rejected/reasonBreakdown`, `SubscriberSummary.receivedCount`, `WorkspaceSummary.receivedCount`, list `meta.total` — goes through `receivedWhere(...)` in `RecordsRepository`. Nothing else may count `webhookRecord` directly; a regression test (bug-fix protocol, written first) seeds 1 original + 2 replays and asserts `count === 1`, and a grep-level review check flags raw `webhookRecord.count` call sites outside this file.

**Never uses it:** replay-children queries (`replayOfId = <id>`), the `replays` stat (`replayOfId: { not: null }`), and the retention sweep (§4), which deliberately removes parents *and* cascaded replays.

---

## 4. Retention sweep (7 days, daily 03:00 UTC)

```ts
// retention.service.ts — @Cron('0 0 3 * * *', { timeZone: 'UTC' })
import { RETENTION_DAYS, RATE_LIMIT_WINDOW_MS } from '../common/constants/ingest.constants';
import { MS_PER_DAY } from '../common/constants/app.constants';

const cutoff = new Date(Date.now() - RETENTION_DAYS * MS_PER_DAY); // C14: no date-fns — one subtraction doesn't justify a dependency
const { count } = await prisma.webhookRecord.deleteMany({
  where: { receivedAt: { lt: cutoff } },   // ← served by @@index([receivedAt])
});
// replay children of deleted originals go with them via replayOfId FK cascade;
// `count` = deleted parents — the number the cron logs (SPEC)

// same cron also prunes dead window rows (older than the 60s window are already inert)
await prisma.rateLimitWindow.deleteMany({
  where: { occurredAt: { lt: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) } },
});
```

The `(receivedAt)` index turns the sweep into an index range scan instead of a table scan; the window prune rides the `(subscriberId, occurredAt)` index (index-only scan over `occurredAt`), acceptable at ≤ 60 rows/subscriber/minute with daily pruning.

---

## 5. Migration strategy — scaffold phase

**Pick: `prisma migrate dev` against the docker Compose Postgres.**

```bash
npx prisma migrate dev --name init   # config read from prisma.config.ts
npx prisma generate                   # v7: migrate dev NO LONGER runs generate
npx prisma db seed                    # v7: no auto-seed after migrate
```

Why: it produces the committed `prisma/migrations/` history the repo convention requires (schema changes go through migrations, never `db push`), validates against the real dev database in one command, and CI replays the same history with `migrate deploy`. The offline diff creates SQL without history and without a check against a real database:

```bash
# offline: eyeball the init SQL without a DB (v7 renamed the flag — see §7.5)
npx prisma migrate diff --from-empty --to-schema=prisma/schema.prisma --script
```

Keep a diff-based check as the **CI drift gate**, not as the creation path — it runs in the unit-test job right after `migrate deploy`. `--from-migrations` would need a shadow DB, and v7 removed its `--shadow-database-url` flag, so the gate reads the live database through the config datasource instead (C9):

```bash
# exits 2 if the deployed DB (config datasource) and schema.prisma disagree
npx prisma migrate diff --exit-code --from-config-datasource --to-schema prisma/schema.prisma
```

---

## 6. Rate-limit rotate / reset interaction

SPEC: the window resets when the token/secret rotates — otherwise rotating during a 429 ban hands the user a fresh secret that is already banned. Reset runs in the **same transaction** as the secret swap (02 §4):

```ts
await prisma.$transaction(async (tx) => {
  await tx.subscriber.update({
    where: { id: subscriberId },
    data: { hmacSecret: newSecret, rotatedAt: new Date() },
  });
  await tx.rateLimitWindow.deleteMany({ where: { subscriberId } }); // SPEC: reset khi token rotate
});
```

- The advisory-lock window query (03 §3.3) keys on `subscriberId`, so deleting rows is a complete reset — no counter state survives to re-ban the new secret.
- **Revoke needs no reset:** ingest short-circuits at step 2 (410) before the window is ever consulted (02 §9.3).
- **Delete needs no reset:** the FK cascade removes the rows with the subscriber.
- Retention prunes stale rows daily anyway (§4), so an unrotated subscriber's table never grows past the live 60s window by more than a day.

---

## 7. Prisma 7 gotchas (verified from official docs, 2026-10)

1. **Generator `output` is required; `prisma-client-js` is deprecated.** Use `provider = "prisma-client"` (Rust-free TS client) with explicit `output = "../src/generated/prisma"`; imports become `import { PrismaClient, Prisma } from '../generated/prisma/client'` (path relative to the consumer). The generated code is plain TS inside `src/`, so the app build compiles it — wire `prisma generate` into `postinstall`/`prebuild`, or a fresh clone fails to compile.
2. **`prisma.config.ts` at the project root (next to `package.json`) replaces schema-level datasource config.** `defineConfig` from `prisma/config` carries `schema`, `migrations.path`, `migrations.seed`, and `datasource.url = env('DATABASE_URL')`. Leaving `url` in the `datasource` block is not merely deprecated — `prisma validate` fails with P1012 ("The datasource property `url` is no longer supported in schema files"; verified against CLI 7.10.0). v7 does **not** auto-load `.env` — the config file starts with `import 'dotenv/config'`. The CLI (migrate, db execute) reads the connection from here; `--url`/`--schema` flags were removed.
3. **Driver adapter is mandatory** — `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })` from `@prisma/adapter-pg`. In NestJS this lives inside `PrismaService` (`onModuleInit` init, `enableShutdownHooks`, `onModuleDestroy` close); tests keep mocking **by token** (`overrideProvider(PrismaService)`).
4. **ESM vs CJS:** the upgrade guide *recommends* ESM, but `@prisma/client@7.10.0` and `@prisma/adapter-pg@7.10.0` (registry metadata) expose `require` conditions and no `"type": "module"` — and the generated `prisma-client` output is plain TS compiled by the app. **Backend stays CommonJS** (no `"type":"module"`, `module: commonjs`). Verify the NestJS 11 build (decorators + `emitDecoratorMetadata` under tsc/SWC) under CJS *first* at scaffold — this is the integration most likely to force a build-config decision before any model work. Phase-0 gate: build + tests must pass under CJS before feature work.
5. **Migrate CLI changes:** `migrate dev` no longer runs generate or seed (both run explicitly; `--skip-generate`/`--skip-seed` removed), and `migrate diff` renamed/removed flags — the spec's `--to-schema-datamodel` is now `--to-schema`; `--from-url`/`--to-url` are gone in favor of `--from-config-datasource`/`--to-config-datasource`/`--from-empty`/`--from-migrations`.

---

## 8. Reconciliation notes (this file vs 02/03)

1. **Model/table names.** 03 §3.1/§7 names the tables `CaptureRecord` / `RateWindowRow` with `endpointId` (**BigInt**); 02 §10 references `Prisma.RecordWhereInput` and `prisma.captureRecord` — the two upstream docs already disagree with each other. This file's names (`WebhookRecord`, `RateLimitWindow`, `subscriberId`) are authoritative for the schema; **ids are `Int`**, following 02 §1.5 ("route ids are integers … `ParseIntPipe`") over 03's BigInt. Read every `CaptureRecord`/`Record`/`endpointId` reference in 02/03 as `WebhookRecord`/`RateLimitWindow.subscriberId`; the semantics (`replayOfId: null` canonical filter, cascade, window design) are unchanged.
2. **`signatureHeaderName` vs `signatureHeader`.** The column is `signatureHeaderName` (this design); 02's wire field stays `signatureHeader` (DTO + `SubscriberDetail`) — the response mapper translates 1:1, the API contract is not changed. Per C15, the ingest whitelist key is the subscriber's `signatureHeaderName` **lowercased** (plus `x-request-id` + `user-agent` + `content-type`); header keys are normalized to lowercase at capture.
3. **`Membership` vs `WorkspaceMember`.** 02 §3 prose says the creator row is inserted into `WorkspaceMember`; the model here is `Membership` (same columns/semantics) — update 02's prose at implementation.
4. **Enum casing.** DB values are SCREAMING_SNAKE (`VERIFIED`, `MISSING_SIGNATURE`); 02 §1.2 says wire codes are snake_case (`verified`, `missing_signature`). The lowercase mapping happens in the response mapper — 02's "shared with the Prisma schema" means shared *vocabulary*, not literal casing.
5. **No `PENDING` status.** 03 §2 step 4–5 inserts a `status = pending` row and updates it after HMAC, but neither the status enum (`VERIFIED | REJECTED`, this design) nor 02 §9.1 (every row terminal) contains a pending state. Ingest instead runs the pure `verifySignature` first (it returns a reason, never throws) and performs **one insert with the terminal status**, preserving record-then-respond; the two-step create-then-update is dropped.
6. **SSRF-blocked replay writes no row.** 02 §6 ("nothing was sent, nothing belongs in the timeline") and 03 §4.3 ("save replay row with `replayError = 'replay_target_blocked'`") contradict each other; following 02 (the status-code contract), v1 writes **no** record for `replay_target_blocked`. The `ReplayError.REPLAY_TARGET_BLOCKED` enum value is kept so 03's variant can be enabled later without a migration.
7. **Added/derived fields vs the field list.** `durationMs` added because 02's `ReplayChild.response.durationMs` requires it; `bodyBytes` is a stored `Int` column per C16 (exact bytes ≤ cap, sentinel `MAX_BODY_BYTES + 1` on overflow) — the earlier "derived from `rawBody.length`, not stored" note is superseded.
8. **Doc link:** 02's header pointed at `docs/design/01-schema-design.md`; the actual file is `docs/design/01-prisma-schema.md` — fixed in 02's header.
9. **Wire ↔ column renames (mapper rows).** 02's wire names differ from this schema's column names; every response mapper translates them — undocumented before this pass:

   | Wire field (02) | Column (01) | Mapper rule |
   |---|---|---|
   | `RecordListItem.reason` (`missing_signature` \| … \| `null`) | `rejectReason RejectReason?` | snake_case + lowercased; `null` iff `status = VERIFIED` (same rule as note 4's casing map) |
   | `ReplaySuccess.data.savedAt` | `replayedAt DateTime?` | replay child's `replayedAt` → ISO `savedAt`; `null` never serialized (success implies a written row) |
   | `SubscriberSummary.status: 'active' \| 'revoked'` | `revokedAt DateTime?` | derived, not stored: `revokedAt === null ? 'active' : 'revoked'` |
