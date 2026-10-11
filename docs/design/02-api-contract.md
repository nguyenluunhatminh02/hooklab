# HookLab — REST API Contract (Design 02)

> Companion docs: `docs/SPEC.md` (authoritative scope), `docs/design/01-prisma-schema.md` (data model, canonical count query).
> Status: design, pre-scaffold. Backend: NestJS 11 + Prisma 7.

---

## 1. Conventions

### 1.1 Base path & surface split

| Surface | Prefix | Auth | Body parsing |
|---|---|---|---|
| Application API | `/api/*` | JWT Bearer (global guard + `@Public()`) | JSON, default body parser |
| Public ingest | `/ingest/:token` | none (token in path is the capability) | **dedicated raw-body middleware scoped to `/ingest/*`** — HMAC is computed over the exact received bytes, so this route must never pass through the JSON parser |

Splitting the prefixes keeps the raw-body middleware scope exact (`/ingest/*`), lets Caddy/infra apply different limits later, and makes the unauthenticated surface greppable in one pattern.

### 1.2 Envelope — one shape, chosen deliberately

**Success (2xx with a body):**

```json
{ "data": <payload> }
```

**Paginated list success** adds a `meta` sibling:

```json
{ "data": [<items>], "meta": { "nextCursor": "eyJ…", "hasMore": true, "total": 128 } }
```

`meta` is **optional and pagination-only**: it appears on list routes that accept `limit`/`cursor`/`offset` (the two records lists, §5/§7) and nowhere else. Lists without pagination parameters — `GET /api/workspaces/:workspaceId/subscribers` (§4) is the current example — return a bare `{ "data": [...] }`, exactly as their row in each endpoint table states. `meta.total` is present only in offset mode (§7). A delta cursor for polling is intentionally not defined; the frontend polls page 1 every 2s (SPEC) (deferred, §14).

**Error (4xx/5xx):**

```json
{
  "error": {
    "code": "validation_error",
    "message": "Validation failed",
    "details": [
      { "field": "destinationUrl", "message": "must be an http or https URL" }
    ],
    "requestId": "req_01J…"
  }
}
```

- `code` is `snake_case`, machine-readable; the UI branches on it (`replay_target_blocked` shows the SSRF hint, `rate_limited` shows the countdown). `details` is optional, present on `validation_error` and wherever a reason must surface (ingest 401 → `details.reason = "missing_signature" | "invalid_signature"`).
- **Why this shape:** a single `unwrap<T>()` helper on the frontend, a single mapping site in the global exception filter (§1.4), and `code` stays stable when `message` copy changes. Alternatives rejected: bare payloads (frontend would need two parsers for success vs error), RFC 7807 `application/problem+json` (heavier than this app needs and awkward to combine with list `meta`).
- `data` and `error` never coexist. 204 responses have no body (delete routes).
- **Sole exception — auth:** `POST /api/auth/register` and `POST /api/auth/login` return a **bare** `AuthResponse` (§2), no `{data}` wrapper. Declared here so the frontend keeps a single auth parse path (04 §3 rows #1/#2 consume it unwrapped); implemented in exactly those two handlers. Every other 2xx body on every other route — `GET /api/auth/me` included — uses `{data}`.
- Field naming: `camelCase` everywhere; enum *codes* (`verified`, `missing_signature`) are `snake_case` constants shared with the Prisma schema.

### 1.3 Status code rules

- Every status goes through the `HttpStatus` enum; raw numeric literals are a review blocker (swe_conventions §3).
- Prisma errors map in the one global filter: `P2002 → 409 conflict`, `P2025 → 404 not_found`.
- Existence hiding: a request from a non-member gets `404 not_found` (never 403 — do not leak resource existence). A member attempting an owner-only action gets `403 forbidden`.

### 1.4 Error code table

| `error.code` | HTTP | Where |
|---|---|---|
| `validation_error` | 400 | global ValidationPipe, DTO failures |
| `replay_target_blocked` | 400 | replay route only — SSRF DNS check; **never emitted by `/ingest/*`** |
| `unauthorized` | 401 | bad JWT; ingest missing/invalid signature (`details.reason`) |
| `forbidden` | 403 | member without owner role on an owner-only route |
| `not_found` | 404 | unknown id, non-member access, unknown ingest token |
| `email_taken` | 409 | register, via P2002 map |
| `subscriber_revoked` | 410 | ingest to revoked token; replay against revoked subscriber |
| `body_too_large` | 413 | ingest body over `MAX_BODY_BYTES` |
| `rate_limited` | 429 | ingest; carries `Retry-After` header |
| `replay_upstream_error` | 502 | replay transport failure (ECONNREFUSED, TLS, DNS gone) |
| `replay_timeout` | 504 | replay exceeded `REPLAY_TIMEOUT_MS` |
| `internal_error` | 500 | catch-all filter fallback |

### 1.5 Identifiers & params

- Route ids are integers (autoincrement PKs per schema design) → `@Param('id', ParseIntPipe)` everywhere (swe_conventions §3). The only exception is `:token` on ingest (opaque string, no pipe).
- Query DTOs are classes with class-validator decorators; global pipe is `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.

### 1.6 Named constants (no magic numbers)

```ts
// shared/hooklab.constants.ts
export const TOKEN_BYTES = 32;                    // ingest token entropy (SPEC)
export const DEFAULT_SIGNATURE_HEADER = 'X-Hub-Signature-256';
export const MAX_BODY_BYTES = 1024 * 1024;        // 1 MB (SPEC)
export const RATE_LIMIT_MAX_REQUESTS = 60;        // per token
export const RATE_LIMIT_WINDOW_MS = 60_000;       // 1 minute, sliding
export const REPLAY_TIMEOUT_MS = 10_000;          // 10 s (SPEC)
export const RETENTION_DAYS = 7;                  // cron deletes older rows
export const LIST_LIMIT_DEFAULT = 25;
export const LIST_LIMIT_MAX = 100;
export const PASSWORD_MIN_LENGTH = 8;
export const WORKSPACE_NAME_MAX_LENGTH = 80;
```

---

## 2. Auth — `AuthModule` / `AuthController`

Email + password only. No refresh tokens, no OAuth (SPEC out of scope). Login and register both return the JWT directly; token TTL is the named constant `JWT_TTL` (decided at scaffold, suggested default `12h` for a debug tool).

### Endpoints

| Method | Path | Auth | Request | Response | Status |
|---|---|---|---|---|---|
| POST | `/api/auth/register` | Public | `RegisterDto` | `AuthResponse` | 201, 400, 409 |
| POST | `/api/auth/login` | Public | `LoginDto` | `AuthResponse` | 200, 400, 401 |
| GET | `/api/auth/me` | JWT | — | `{ data: User }` | 200, 401 |

Login failure returns a single `unauthorized` code with message "invalid email or password" (no user enumeration: unknown email and wrong password are indistinguishable).

### Shapes

```ts
interface User {
  id: number;
  email: string;
  createdAt: string;                 // ISO-8601
}

interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  user: User;
}
```

`User` is the wire shape behind `GET /api/auth/me` (`{ data: User }`); `AuthResponse.user` reuses it. Envelope: register/login return `AuthResponse` **bare** (the §1.2 sole exception); `/me` wraps — the frontend's unwrap helper special-cases only those two routes.

### DTO sketches

```ts
export class RegisterDto {
  @IsEmail() @MaxLength(254)
  email!: string;                          // normalized to lowercase before persist

  @IsString() @MinLength(PASSWORD_MIN_LENGTH) @MaxLength(72)
  password!: string;
}

export class LoginDto {
  @IsEmail() @MaxLength(254)
  email!: string;

  @IsString() @IsNotEmpty() @MaxLength(72)
  password!: string;
}
```

Password hashing: bcrypt, cost a named constant. JWT payload: `{ sub: userId, email }`.

---

## 3. Workspaces & membership — `WorkspacesModule` / `WorkspacesController`

### Endpoints

| Method | Path | Auth | Request | Response | Status |
|---|---|---|---|---|---|
| GET | `/api/workspaces` | JWT | — | `{ data: WorkspaceSummary[] }` | 200 |
| POST | `/api/workspaces` | JWT | `CreateWorkspaceDto` | `{ data: WorkspaceSummary }` | 201, 400 |
| DELETE | `/api/workspaces/:workspaceId` | JWT + **owner** | — | 204 | 204, 404, 403 |

`WorkspaceSummary` carries what badges need without an extra round trip:

```ts
interface WorkspaceSummary {
  id: number;
  name: string;
  role: 'owner' | 'member';
  subscriberCount: number;
  receivedCount: number;   // canonical count query (§10)
  createdAt: string;
}
```

Creating a workspace inserts the creator as `owner` in `WorkspaceMember` inside the same callback-style transaction as the workspace row.

### Membership semantics (permission matrix)

| Action | owner | member | non-member |
|---|---|---|---|
| View workspace / subscribers / records / stats | yes | yes | 404 |
| Create subscriber | yes | yes | 404 |
| Update subscriber (name, destination, headers) | yes | yes | 404 |
| Replay a record | yes | yes | 404 |
| **Rotate** subscriber secret/token | yes | 403 | 404 |
| **Revoke** subscriber (ingest → 410) | yes | 403 | 404 |
| **Delete** subscriber | yes | 403 | 404 |
| **Delete** workspace | yes | 403 | 404 |

Rationale: rotate/revoke/delete change the shared-secret surface or destroy data, so they are owner-only. Replay only re-sends to a destination URL a member can already read, so members may replay. Enforcement lives in one `MembershipService` (`assertMember(workspaceId, userId)` / `assertOwner(workspaceId, userId)`) called from controllers, so the matrix has a single test site.

Member management (invite/remove) is not in v1 — see §14.

### DTO sketch

```ts
export class CreateWorkspaceDto {
  @IsString() @IsNotEmpty() @MaxLength(WORKSPACE_NAME_MAX_LENGTH)
  name!: string;
}
```

---

## 4. Subscribers — `SubscribersModule` / `SubscribersController`

A subscriber = one ingest endpoint + one destination. `endpointUrl` appears in every detail/list payload so the UI can offer "copy URL" for pasting into Stripe/GitHub/Shopee.

### Endpoints

| Method | Path | Auth | Request | Response | Status |
|---|---|---|---|---|---|
| GET | `/api/workspaces/:workspaceId/subscribers` | JWT member | — | `{ data: SubscriberSummary[] }` | 200, 404 |
| POST | `/api/workspaces/:workspaceId/subscribers` | JWT member | `CreateSubscriberDto` | `{ data: SubscriberDetail & { secret } }` | 201, 400, 404 |
| GET | `/api/subscribers/:subscriberId` | JWT member | — | `{ data: SubscriberDetail }` | 200, 404 |
| PATCH | `/api/subscribers/:subscriberId` | JWT member | `UpdateSubscriberDto` | `{ data: SubscriberDetail }` | 200, 400, 404 |
| POST | `/api/subscribers/:subscriberId/rotate` | JWT **owner** | — | `{ data: RotateResult }` | 200, 403, 404 |
| POST | `/api/subscribers/:subscriberId/revoke` | JWT **owner** | — | `{ data: RevokeResult }` | 200, 403, 404 |
| DELETE | `/api/subscribers/:subscriberId` | JWT **owner** | — | 204 | 204, 403, 404 |

Item routes are flat (`/api/subscribers/:id/...`); creation/listing is nested under the workspace because the workspace id is required to *create* (where does this subscriber live?) but redundant on item ops (the row already knows its workspace). Membership resolves subscriber → workspace → member table.

Two deliberate contract notes for this table:

- The list row returns a bare `{ data: SubscriberSummary[] }` — the route has no pagination params, so no `meta` sibling (§1.2 "pagination-only" rule). The implementation returning `{data}` alone is correct, not a drift.
- `PATCH /api/subscribers/:subscriberId` is **last-writer-wins** on `name`/`destination`/`signatureHeader`: no version field or `If-Match` precondition, so concurrent edits to cosmetic fields resolve to whichever commit lands second. This is an accepted trade-off — the dangerous write path (rotate vs ingest) is serialized by the `pg_advisory_xact_lock` in `SecretService.rotate` (§4.4), and the unprotected surface is name/URL edits only. Optimistic locking (`version` column → 409 on stale) is deferred until a real concurrent-edit conflict shows up in practice.

### Shapes

```ts
/** Read-back shape: secrets reduced to a `…last4` hint, never the value itself. */
type DestinationAuthMasked =
  | { type: 'none' }
  | { type: 'bearer'; tokenHint: string }
  | { type: 'basic'; usernameHint: string }
  | { type: 'apiKey'; headerName: string; valueHint: string };

/** Write shape (create/update only, never read-back). */
type DestinationAuthInput =
  | { type: 'none' }                                            // explicit clear marker
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; headerName: string; value: string };

interface Destination {
  method: 'POST' | 'PUT' | 'PATCH';
  url: string;                      // http/https only — SSRF-checked again at replay (§6)
  headers: Record<string, string>;  // replay/forward headers, count capped at MAX_DESTINATION_HEADERS
  auth: DestinationAuthMasked;       // outbound credential, masked; `{type:'none'}` when absent
}

interface SubscriberSummary {
  id: number;
  workspaceId: number;
  name: string;
  status: 'active' | 'revoked';
  endpointUrl: string;               // `${PUBLIC_BASE_URL}/ingest/${ingestToken}`
  ingestToken: string;
  destination: Destination;
  signatureHeader: string;
  receivedCount: number;             // canonical count query (§10)
  verifiedCount: number;
  rejectedCount: number;
  createdAt: string;
  revokedAt: string | null;
}

interface SubscriberDetail extends SubscriberSummary {
  secretHint: string;                // "…cdef" — last 4 chars, safe to show anywhere
}

interface RotateResult {
  secret: string;                    // FULL HMAC secret, shown once per rotation
  secretHint: string;
  rotatedAt: string;
  note: 'previous secret invalid immediately; rate-limit window reset';
}

interface RevokeResult {
  revokedAt: string;
  note: 'ingest now answers 410 Gone; future requests are not recorded';
}
```

- **`Destination` is defined exactly once (above)** and reused by summary and detail — no anonymous re-declaration. Mapper rule: DB `null`/missing destination headers → `headers: {}` and `method` defaults `'POST'`; the wire shape is non-nullable in both payloads. `auth` serializes from the nullable `destinationAuth` JSON column — SQL `NULL` maps to `{type:'none'}`, and stored secrets (plaintext in the column, since the server must render them into outbound headers at replay time) reduce to their `…last4` hint. The client never sees a stored credential value, so it can never resend one.
- **Destination auth (Svix/Stripe-style outbound credential):** applied to the destination on every replay and forwarded delivery as exactly one header — `authorization: Bearer <token>`, `authorization: Basic base64(user:pass)`, or `<headerName>: <value>` for apiKey (header name is structural — an RFC 7230 token, so it can never split the header block). Credential-bound headers are merged **last** on the outbound leg, winning over a same-named entry in `destination.headers`; the merge folds field names case-insensitively (HTTP field names are), so a case-variant entry (`Authorization` vs the credential's `authorization`) is replaced, not comma-joined into a second value on the wire. A stored credential is single-line, within the destination-header value cap, and free of code units fetch cannot convert (the DTO gate rejects C0/DEL and anything above Latin-1), so it is replay-safe by construction. Leading/trailing SP/HTAB are normalized to the wire spelling (WHATWG fetch strips them before sending) on the way out, so the header fetch receives is what the emission computed — and therefore what redaction targets.
- **PATCH keep/clear semantics:** an **absent** `destinationAuth` key or JSON `null` keeps the stored credential (the client only ever holds the masked hint, so it can never overwrite a credential it cannot read); only the explicit `{ type: 'none' }` marker clears it (written as SQL `NULL`). The DTO constraint also enforces an **exact key set per type** — `{type:'none'}` cannot smuggle extra credential keys, and a half-pair (`basic` with only a username) is a 400. `@IsOptional` passes `null` through, which is why the service treats `null` as "keep" rather than letting a bare null wipe the column.
- **Secret exposure:** the full secret appears only in the create response and `RotateResult`. Detail/list expose `secretHint` only; rotation is the supported way to re-obtain it. The server must store the secret in plaintext (it computes HMAC over incoming bodies), so the secret column never leaks through any other route. Destination credentials follow the same rule: plaintext in the `destinationAuth` column (the server sends them on the wire), never serialized — read-back carries only the `…last4` hint, and update replaces a credential wholesale or leaves it untouched (no partial field merge). The one serialization boundary the column itself does not control is the replay leg's stored response body: an echo destination (httpbin) reflects the outbound request into its reply, and that reply becomes the child row's `responseBody` (record detail renders it). The exact credential value this leg emitted is therefore scrubbed (`[redacted]`) out of the upstream response body before truncation and storage (`redactDestinationResponseBody` in `subscribers/destination-auth.ts`) — the emitted `headerValue`, exactly — so a plaintext credential can never ride an echo back into a member-readable row. Bodies from subscribers without a credential, or bodies that did not echo it, are stored verbatim.
- **Reveal-modal mapping (04 `SecretRevealModal`):** create → `url` = `endpointUrl`, `token` = `ingestToken`, `secret` = `secret`. Rotate returns **neither** URL nor token (secret-only, BUILD_PLAN §0 C5) — on `kind: 'rotated'` the modal takes `url`/`token` from the pre-rotation subscriber cache (`ingestToken` is unchanged by rotate) and `secret` from `RotateResult.secret`.
- **Rotate semantics (SPEC):** new secret generated (`TOKEN_BYTES`), old secret fails verification immediately, and the sliding-window rate-limit state for this token is deleted in the same transaction — otherwise a rotate during a 429 ban hands out a secret that is already banned.
- **Revoke semantics (SPEC):** ingest returns 410 and writes **no record**. Rows are kept so the UI can still show the revoked endpoint.

### DTO sketches

```ts
export class CreateSubscriberDto {
  @IsString() @IsNotEmpty() @MaxLength(80)
  name!: string;

  @IsUrl({ require_protocol: true, protocols: ['http', 'https'], require_tld: false })
  destinationUrl!: string;           // SSRF blocklist applies again at replay time (§6)

  @IsIn(['POST', 'PUT', 'PATCH'])
  @IsOptional()
  destinationMethod?: 'POST' | 'PUT' | 'PATCH';   // default 'POST'; ingest accepts whatever the sender uses

  @IsObject()
  @IsOptional()
  destinationHeaders?: Record<string, string>;    // each value @IsString + @MaxLength

  @IsOptional()
  @Validate(IsDestinationAuthConstraint)          // exact key set per type; see §4 semantics above
  destinationAuth?: DestinationAuthInput;

  @Matches(/^[\w-]{1,64}$/)          // header name, e.g. X-Hub-Signature-256
  @IsOptional()
  signatureHeader?: string;          // default DEFAULT_SIGNATURE_HEADER
}

export class UpdateSubscriberDto extends PartialType(CreateSubscriberDto) {}
```

`forbidNonWhitelisted: true` makes unknown fields a 400, not a silent drop.

---

## 5. Timeline (records) — `RecordsModule` / `RecordsController`

### Endpoints

| Method | Path | Auth | Request | Response | Status |
|---|---|---|---|---|---|
| GET | `/api/subscribers/:subscriberId/records` | JWT member | `ListRecordsQueryDto` | `RecordListResponse` | 200, 400, 404 |
| GET | `/api/workspaces/:workspaceId/records` | JWT member | `ListRecordsQueryDto` | `RecordListResponse` | 200, 400, 404 |
| GET | `/api/records/:recordId` | JWT member | — | `{ data: RecordDetail }` | 200, 404 |

Two list routes, one query DTO, one repository method. The workspace-level route exists because SPEC searches "by token/event type" — token search only means something across subscribers.

### Default view excludes replays (SPEC)

Every list query starts from the canonical filter (§10): `replayOfId: null`. Passing `includeReplays=true` drops the filter; replay rows then carry `isReplay: true` and their `replayOfId` parent so the UI can nest them. The verified/rejected tabs operate on either view.

### Query params (`ListRecordsQueryDto`)

| Param | Type | Default | Notes |
|---|---|---|---|
| `status` | `verified` \| `rejected` | both | single value only (`@IsIn`), matches the two UI tabs |
| `q` | string ≤ 200 | — | substring on `eventType`; prefix on `ingestToken` (workspace route); exact match on captured `x-request-id` |
| `limit` | int 1..100 | `LIST_LIMIT_DEFAULT` | `@Type(() => Number)` + `@Min`/`@Max` |
| `cursor` | opaque string | — | base64url of `{ receivedAt, id }`; **exclusive with `offset`** (400 if both) |
| `offset` | int ≥ 0 | — | page-jump mode; response includes `meta.total` |
| `includeReplays` | boolean | `false` | `@Transform` to boolean |

Ordering: `receivedAt DESC, id DESC` (id tiebreak keeps cursors stable).

### Response shapes

```ts
interface RecordListItem {
  id: number;
  subscriberId: number;
  workspaceId: number;
  subscriberName: string;
  status: 'verified' | 'rejected';
  reason: 'missing_signature' | 'invalid_signature' | 'body_too_large'
        | 'rate_limited' | null;         // null iff verified
  eventType: string | null;              // best-effort: body.type / body.event / x-event-type header
  method: string;
  bodyBytes: number;
  isReplay: boolean;
  replayOfId: number | null;
  replayResponseStatus: number | null;   // upstream status, replay rows only
  receivedAt: string;                    // ISO-8601
}

interface RecordListResponse {
  data: RecordListItem[];
  meta: { nextCursor: string | null; hasMore: boolean; total?: number };
}

interface RecordDetail extends RecordListItem {
  url: string;                           // full original request URL
  headers: Record<string, string>;       // WHITELIST only (§5.1)
  rawBody: string;                       // exact bytes as text
  bodyParsed: unknown | null;            // JSON.parse(rawBody), null when invalid
  destination: Destination;              // LIVE subscriber destination (§4) — never null; rotate/edit is reflected immediately, no capture-time snapshot
  replays: ReplayChild[];                // rows with replayOfId = this.id, oldest first
}

interface ReplayChild {
  id: number;
  receivedAt: string;
  request: { method: string; url: string; headers: Record<string, string>; rawBody: string };
  response: {
    outcome: 'ok' | 'timeout' | 'upstream_error';
    status: number | null;               // null for timeout / transport failure
    body: string | null;                 // truncated at RESPONSE_BODY_MAX_BYTES
    durationMs: number;
  };
}
```

`destination` is the subscriber's **live** destination, not a capture-time snapshot: the detail view re-reads the current subscriber row, so a destination edit or header rotation shows on every record immediately, and the field is never null (the detail query always resolves the subscriber). Frontends that show "original capture target" must accept this — the value is what a replay would use today.

### 5.1 Header whitelist (SPEC)

Captured and stored: `x-hub-signature` (or the subscriber's configured `signatureHeader`), `x-request-id`, `user-agent`, `content-type`. Every other request header is dropped at capture time, so the detail view cannot leak an `authorization` header a sender attached. Keys normalized to lowercase.

---

## 6. Replay — `ReplayModule` / `ReplayController`

### Endpoint

| Method | Path | Auth | Request | Response | Status |
|---|---|---|---|---|---|
| POST | `/api/records/:recordId/replay` | JWT member | `ReplayDto` | `ReplaySuccess` | 200, 400, 404, 410, 502, 504 |

| Failure | HTTP | `error.code` | Record written? | Notes |
|---|---|---|---|---|
| SSRF block | 400 | `replay_target_blocked` | **no** | `details: { blockedIp }`; DNS resolve then check against loopback/private/link-local/metadata ranges (SPEC list); nothing was sent, nothing belongs in the timeline |
| unknown record / non-member | 404 | `not_found` | no | |
| subscriber revoked | 410 | `subscriber_revoked` | no | destination is no longer a live target |
| success (any upstream status) | 200 | — | **yes**, `replayOfId = recordId` | upstream 4xx/5xx is a *result*, not an API error: the round trip completed, so 200 + stored response |
| transport failure | 502 | `replay_upstream_error` | yes, outcome `upstream_error` | ECONNREFUSED / TLS / post-resolve DNS failure |
| timeout | 504 | `replay_timeout` | yes, outcome `timeout` | `REPLAY_TIMEOUT_MS`; `details.replayRecordId` so the UI can open the attempt |
| edited body over the transport cap | 413 | `body_too_large` | no | JSON body parser rejects at `MAX_BODY_BYTES` before the handler runs — same cap the ingest route declares (§9.1); not a handler status, reachable whenever the edited body exceeds 1 MB |

DNS/SSRF validation runs **again at replay time**, not only at subscriber create: DNS answers are attacker-controllable and can change between create and replay (TOCTOU). The upstream response body is stored truncated at `RESPONSE_BODY_MAX_BYTES`.

### DTO & success shape

```ts
export class ReplayDto {
  @IsObject()                              // edited JSON payload; arrays not accepted in v1 (§14)
  body!: Record<string, unknown>;
}

interface ReplaySuccess {
  data: {
    replayRecordId: number;
    outcome: 'ok';
    response: { status: number; body: string | null; durationMs: number };
    savedAt: string;
  };
}
```

Replaying a replay row is allowed: `replayOfId` points at the row acted on, and the canonical filter excludes every non-null `replayOfId`, so chains never inflate counts. Destination = the subscriber's configured method + URL + headers; `ReplayDto` supplies only the body. A stored destination auth credential (§4) is merged last onto the outbound header block, so it wins over a same-named entry in the subscriber's destination headers.

---

## 7. Pagination

- **Cursor mode (default):** opaque `nextCursor` = base64url of `{ receivedAt, id }` of the last item. Stable under the 2s poll: new rows land at the head, so a cursor never skips or duplicates. This is the mode the frontend uses. Cursor responses omit `meta.total` (no count query on this path) — only offset mode carries it (§1).
- **Offset mode:** `offset` + `limit`, returns `meta.total` (via canonical count, §10) for page numbers. Mutually exclusive with `cursor`.
- `hasMore` = a next row existed beyond the page (extra-row probe, then slice).

---

## 8. Stats — owned by `RecordsController`

### Endpoint

| Method | Path | Auth | Request | Response | Status |
|---|---|---|---|---|---|
| GET | `/api/subscribers/:subscriberId/stats` | JWT member | — | `{ data: SubscriberStats }` | 200, 404 |

```ts
interface SubscriberStats {
  subscriberId: number;
  received: number;        // MUST be canonical count (§10): replayOfId IS NULL
  verified: number;        // canonical + status=verified
  rejected: number;        // canonical + status=rejected
  replays: number;         // replayOfId IS NOT NULL (reported separately, never added into `received`)
  reasonBreakdown: {       // canonical + status=rejected, groupBy reason
    missing_signature: number;
    invalid_signature: number;
    body_too_large: number;
    rate_limited: number;
  };
  retention: {
    days: RETENTION_DAYS;
    notice: 'records auto-delete after 7 days';
    oldestKeptAt: string | null;   // max(now − 7d, oldest receivedAt)
  };
}
```

`received`, `verified`, `rejected`, `reasonBreakdown`, and list `meta.total` all go through the canonical count helper (§10). The `retention` block feeds the static banner in the UI. Workspace-level aggregate stats are deferred (§14).

---

## 9. Public ingest — `IngestModule` / `IngestController`

**Route:** `POST /ingest/:token` — no JWT, no session. Possession of the token addresses the endpoint; possession of the secret lets you sign.

### 9.1 Exact status-code contract

| # | Outcome | HTTP | Body | Record saved? | `reason` stored | Counted in rate-limit window? |
|---|---|---|---|---|---|---|
| 1 | unknown token | **404** | `error: not_found` | **no** | — | no |
| 2 | token revoked | **410** | `error: subscriber_revoked` | **no** (SPEC: request tới token revoke không được lưu) | — | no |
| 3 | over limit | **429** + `Retry-After: <seconds left in window, ceil>` | `error: rate_limited` | **yes**, `status=rejected` | `rate_limited` | **no** — the rejected row must not extend the ban (anti self-extending) |
| 4 | body > `MAX_BODY_BYTES` | **413** | `error: body_too_large` | **yes**, `status=rejected` | `body_too_large` | yes |
| 5 | signature header absent | **401** | `error: unauthorized`, `details.reason: missing_signature` | **yes**, `status=rejected` | `missing_signature` | yes |
| 6 | signature mismatch | **401** | `error: unauthorized`, `details.reason: invalid_signature` | **yes**, `status=rejected` | `invalid_signature` | yes |
| 7 | signature valid | **200** | `{ data: { recordId, status: 'verified' } }` | **yes**, `status=verified` | — | yes |

`400 replay_target_blocked` **never comes from this route** — it belongs exclusively to `POST /api/records/:id/replay` (§6). No other status is part of the contract; unexpected failures fall to `500 internal_error` through the global filter.

### 9.2 Processing order (each step short-circuits)

1. **Resolve token** → 404 (lookup by `ingestToken`, index-backed).
2. **Revoked?** → 410, write nothing.
3. **Rate-limit check** — sliding window over `RATE_LIMIT_WINDOW_MS` keyed by token. The decision uses the token only, before the body is buffered. Over limit → save the rejected record, respond 429, **skip the increment**. Under limit → **increment exactly once**, continue.
4. **Read raw body** with cap `MAX_BODY_BYTES` (raw-body middleware; HMAC must never see re-serialized JSON). Over cap → save rejected record, 413.
5. **Verify HMAC-SHA256** over the exact bytes with `timingSafeEqual` against the `<signatureHeader>` value `sha256=<hex>` → 200 verified / 401 rejected.

Because the increment happens only after the limit check passes: outcomes 4/5/6/7 count once each, outcome 3 counts zero. The window can never be extended by the traffic it is blocking. Window rows live in their own rate-limit table (schema design); if that table is ever derived from `Record` instead, the query must still apply `replayOfId IS NULL` (§10).

### 9.3 Rate-limit reset

Window state for a token is deleted in the same transaction as a **rotate** (§4) — SPEC requires the window to reset on rotation. Revoke needs no reset because ingest stops at step 2.

---

## 10. Canonical count query — every badge and metric

Defined once in the schema design and consumed through `RecordsRepository` only:

```ts
// records.repository.ts — single source of truth
const CANONICAL_RECEIVED = { replayOfId: null } satisfies Prisma.RecordWhereInput;

countReceived(where?: Prisma.RecordWhereInput);   // { ...where, ...CANONICAL_RECEIVED }
countByStatus(where, status);                     // canonical + status
groupReasons(where);                              // canonical + status=rejected, groupBy reason
```

**Must go through it (enforced by review + unit tests):**

| Call site | Route / code | Count |
|---|---|---|
| `SubscriberStats.received / verified / rejected / reasonBreakdown` | `GET /api/subscribers/:id/stats` | badge numbers |
| `SubscriberSummary.received/verified/rejected` | subscriber list & detail | badge numbers |
| `WorkspaceSummary.receivedCount` | `GET /api/workspaces` | workspace badge |
| `meta.total` | any records list, offset mode | rows in view |
| Rate-limit window count | ingest step 3 | only if ever derived from `Record` — must include `replayOfId IS NULL` (replays never touch ingest, so today this is defensive) |

**Must NOT use it:** replay-children queries (`replayOfId = <id>`), the `replays` stat (`replayOfId IS NOT NULL`), retention deletion (removes everything older than the cutoff, parents and cascaded replays alike).

Regression coverage follows the bug-fix protocol: a test asserting `received` stays unchanged after a replay row is written gets written **first**, before any change to this helper.

---

## 11. Module map & route ownership

| Module | Controller | Owns | Key providers |
|---|---|---|---|
| `AuthModule` | `AuthController` | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` | `JwtStrategy`, global `JwtAuthGuard` with `@Public()` on these routes + ingest |
| `WorkspacesModule` | `WorkspacesController` | `GET /api/workspaces`, `POST /api/workspaces`, `DELETE /api/workspaces/:workspaceId` | `MembershipService` (`assertMember` / `assertOwner`) |
| `SubscribersModule` | `SubscribersController` | `GET/POST /api/workspaces/:workspaceId/subscribers`, `GET/PATCH/DELETE /api/subscribers/:subscriberId`, `POST /api/subscribers/:subscriberId/rotate`, `POST /api/subscribers/:subscriberId/revoke` | `SecretService` (generate/rotate, clears rate-limit window), destination URL validation |
| `RecordsModule` | `RecordsController` | `GET /api/subscribers/:subscriberId/records`, `GET /api/workspaces/:workspaceId/records`, `GET /api/records/:recordId`, `GET /api/subscribers/:subscriberId/stats` | **`RecordsRepository` — the canonical count helper lives here** |
| `ReplayModule` | `ReplayController` | `POST /api/records/:recordId/replay` | `SsrfGuard` (DNS resolve + blocked-range check), `ReplayService` (outbound fetch, `REPLAY_TIMEOUT_MS`, `redirect: 'manual'`, credential redaction) |
| `IngestModule` | `IngestController` | `POST /ingest/:token` | raw-body middleware (`/ingest/*` scope), `HmacVerifier` (`timingSafeEqual`), `RateLimiter` (sliding window), `CaptureService` (header whitelist, 1 MB cap) |
| `RetentionModule` | — (no routes) | — | `RetentionService`: `@Cron('0 3 * * *')` UTC daily; deletes records older than `RETENTION_DAYS` with cascaded replays; logs the deleted-row count each run |
| `AppModule` + `common` | — | — | `PrismaService`; global `APP_PIPE` (`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`); single `APP_FILTER` catch-all (P2002→409, P2025→404, `HttpException` passthrough, else 500) |

Cross-module reads go through exported repositories/services; no service is registered in two modules (swe_conventions §3). Ingest is the only rate-limited surface in v1.

---

## 12. End-to-end route index (one glance)

```
POST   /api/auth/register                          Public        RegisterDto              201
POST   /api/auth/login                             Public        LoginDto                 200
GET    /api/auth/me                                JWT           —                        200
GET    /api/workspaces                             JWT           —                        200
POST   /api/workspaces                             JWT           CreateWorkspaceDto       201
DELETE /api/workspaces/:workspaceId                JWT owner     —                        204
GET    /api/workspaces/:workspaceId/subscribers    JWT member    —                        200
POST   /api/workspaces/:workspaceId/subscribers    JWT member    CreateSubscriberDto      201
GET    /api/subscribers/:subscriberId              JWT member    —                        200
PATCH  /api/subscribers/:subscriberId              JWT member    UpdateSubscriberDto      200
POST   /api/subscribers/:subscriberId/rotate       JWT owner     —                        200
POST   /api/subscribers/:subscriberId/revoke       JWT owner     —                        200
DELETE /api/subscribers/:subscriberId              JWT owner     —                        204
GET    /api/subscribers/:subscriberId/records      JWT member    ListRecordsQueryDto      200
GET    /api/workspaces/:workspaceId/records        JWT member    ListRecordsQueryDto      200
GET    /api/records/:recordId                      JWT member    —                        200
POST   /api/records/:recordId/replay               JWT member    ReplayDto                200 | 400 | 404 | 410 | 502 | 504 | 413
GET    /api/subscribers/:subscriberId/stats        JWT member    —                        200
POST   /ingest/:token                              Public token  raw body                 200 | 401 | 404 | 410 | 413 | 429
```

---

## 13. Testing notes (contract-level)

- Ingest status contract: one table-driven unit spec per row of §9.1, including "429 row exists AND window count unchanged" and "410 writes nothing".
- `RecordsRepository`: canonical counts stay unchanged after inserting a replay row (regression test written first, bug-fix protocol).
- Membership matrix: one spec per role × action cell in §3 (member rotate → 403, non-member read → 404).
- DTO specs beside source (`*.spec.ts`); mock `PrismaService` by token; `app.close()` in `afterAll` (swe_conventions §3/§6).

---

## 14. Deliberately left undecided

- **Member management endpoints** (invite/remove): v1 assumes a workspace is created by its owner and used by them; the owner/member matrix (§3) is enforced, but no API adds members yet.
- **Workspace-level stats aggregate:** only per-subscriber stats ship; the workspace list carries a single `receivedCount`.
- **Content-type allow-list on ingest:** SPEC scopes payloads to JSON/text but defines no rejection for other types; v1 accepts any bytes ≤ 1 MB and relies on HMAC + size cap. Revisit if binary noise shows up in timelines.
- **`ReplayDto` arrays:** replay bodies must be JSON objects in v1; a top-level array returns `validation_error`.
- **Delta polling (`sinceCursor`):** the frontend re-fetches page 1 every 2s; add only if payload size becomes a problem.
- **JWT TTL / refresh flow:** `JWT_TTL` named constant (suggested `12h`); no refresh tokens in v1.
- **`/health` + `/ready`:** required by swe_conventions §3 for the orchestrator, but they belong to the bootstrap/deploy design (03+), not this contract.
