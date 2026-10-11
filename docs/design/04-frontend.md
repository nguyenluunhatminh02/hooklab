# 04 · Frontend — HookLab SPA (React 18 + Vite + TypeScript)

> **Status:** design-only, authored 2026-10-08. **`docs/design/02-api-contract.md` did not exist at authoring time** — every endpoint in §3 is a proposal derived from `docs/SPEC.md` and **must be reconciled with 02 before implementation** (reconciliation checklist in §3.1). Ingest URL shape follows SPEC literally: `POST /ingest/:token`.

## 1. Stack & data layer

| Choice | Decision | Why (3-week scope) |
|---|---|---|
| Build | Vite + `@vitejs/plugin-react` + TS strict | spec |
| Data layer | **TanStack Query v5** | see §1.1 |
| Router | react-router-dom v7.18.4 (`createBrowserRouter`) | route guards as layout elements |
| Styling | Plain CSS + custom-property tokens (`tokens.css`), no Tailwind/UI kit | §4 requires hand-tuned contrast + font declarations; kit defaults are the AI-fingerprint |
| Tests | Vitest + jsdom + @testing-library/react + user-event | spec |
| Explicitly out | WebSocket, Zustand/Redux, react-hook-form, JSON-syntax-highlight lib, MSW, i18n | 2s poll is the realtime story; forms are 3 small ones (hand-rolled state); highlight = bundle cost for a `<pre>`; fetch stubs suffice at this size |

### 1.1 Why TanStack Query (not plain fetch hooks)

Every screen here is server state on a 2s cadence: list + metrics + opened record refetch in parallel, filters change keys, replay mutations must invalidate. TanStack gives, in one option each: request dedupe across the 3 hooks, `placeholderData: keepPreviousData` (no flicker on search/filter change), `refetchInterval` as a function (the visibility pause), automatic refetch-on-focus, and mutation → `invalidateQueries` for replay. Plain `useFetch` hooks would re-implement abort handling, loading/error flags, and cache-by-key — ~150 lines we would also have to test, while the actual novel logic (replay error mapping, JSON validation, pause/resume) stays the same either way. Cost: one dependency; acceptable.

## 2. Route table

| Path | Page | Guard | Notes |
|---|---|---|---|
| `/login` | `AuthPage mode="login"` | public (redirect if token) | `?next=` return path |
| `/register` | `AuthPage mode="register"` | public | |
| `/` | `HomeRedirect` | auth | → `/w/{localStorage.hooklab.lastWorkspaceId}` if valid, else `/workspaces` |
| `/workspaces` | `WorkspaceListPage` | auth | create/select workspace |
| `/w/:workspaceId` | `WorkspaceOverviewPage` | auth | subscriber list + create form + retention notice |
| `/w/:workspaceId/subscribers/:subscriberId` | `SubscriberDetailPage` | auth | **THE main screen**: timeline + detail + replay editor; selected record in `?record=<recordId>` (deep-linkable, survives refresh, poll-stable) |
| `*` | `NotFoundPage` | — | link back to `/` |

Guards: `<RequireAuth>` wraps a layout route — no token in `localStorage` → `<Navigate to="/login?next=…" replace/>`. Workspace membership comes back 403/404 from the API → overview renders an "not a member" empty state (no client-side membership cache to invalidate).

## 3. API endpoints consumed (PROPOSAL — reconcile with 02)

> **⚠️ SUPERSEDED by `docs/BUILD_PLAN.md` §0 C4/C5 + plan §5.3 — do not implement the rows below as written.** Plan §9 claims precedence: resource = `subscriber` (not `endpoint`); records at `/api/subscribers/:id/records` + `/api/records/:id`; stats at `GET /api/subscribers/:id/stats` (not `/metrics`); query param `q` (not `search`); **no `GET /api/config`**; `DELETE` = destroy (revoke is `POST /revoke`); rotate = **new secret only, `ingestToken` stable** (C5); replay statuses per C4. The **shapes** below are corrected to 02 §5; the **paths** in the table are historical proposals — the route table of record is plan §5.3.

Auth header: `Authorization: Bearer <accessToken>` on everything except register/login/ingest. Errors follow 02 §1.2: `{ error: { code, message, details?, requestId } }` with P2002→409 / P2025→404 mapped server-side (§swe_conventions §3). **Auth exception (02 §1.2/§2):** register and login are the sole bare-body routes — rows #1/#2 consume `AuthResponse { accessToken, tokenType, user }` unwrapped; `GET /api/auth/me` is wrapped (`{ data: User }`) and unwrapped like every other route.

| # | Method + path | Purpose | Returns / notes |
|---|---|---|---|
| 1 | `POST /api/auth/register` | `{ email, password }` | bare `AuthResponse` `{ accessToken, tokenType, user }` (§1.2 exception) |
| 2 | `POST /api/auth/login` | `{ email, password }` | bare `AuthResponse` (same as #1) |
| 3 | `GET /api/auth/me` | boot session validation | `{ data: User }` → `User = { id, email, createdAt }` |
| 4 | `GET /api/workspaces` | list + role | `Workspace[]` |
| 5 | `POST /api/workspaces` | `{ name }` | created `Workspace` |
| 6 | `GET /api/workspaces/:workspaceId/endpoints` | overview list | `EndpointSummary[]` (no metrics — avoids N+1) |
| 7 | `POST /api/workspaces/:workspaceId/endpoints` | create: `{ name?, destinationUrl, destinationMethod, destinationHeaders?, destinationAuth?, signatureHeader? }` | `{ …Endpoint, url, token, secret }` — `url` absolute ingest URL; `token`/`secret` shown once |
| 8 | `PATCH /api/endpoints/:endpointId` | edit destination fields (`destinationAuth` absent or null = keep stored credential; `{type:'none'}` = clear, 02 §4) | `Endpoint` |
| 9 | `POST /api/endpoints/:endpointId/rotate` | new token + secret, old invalid immediately | `{ token, secret, url }` (once) |
| 10 | `DELETE /api/endpoints/:endpointId` | **revoke** — ingest starts returning 410, new requests not recorded | 204 |
| 11 | `GET /api/endpoints/:endpointId/records?status=verified\|rejected&search=&cursor=&limit=` | timeline, newest first, cursor paginated | `{ items: RecordSummary[], nextCursor }` |
| 12 | `GET /api/endpoints/:endpointId/records/:recordId` | detail incl. replay children | `RecordDetail` |
| 13 | `GET /api/endpoints/:endpointId/metrics` | badges | `{ received, verified, rejected }` — **canonical, `replayOfId IS NULL`** |
| 14 | `POST /api/records/:recordId/replay` `{ body }` | replay edited JSON to declared destination | see §6 |
| 15 | `GET /api/config` | `?` retention days | optional; fallback = named constant (§8) |

Shapes (verbatim from 02 §5 — 02 is the wire-contract authority; no field exists here that 02 does not expose):

```ts
RecordSummary = {   // = 02 RecordListItem
  id, subscriberId, workspaceId, subscriberName,
  status: 'verified' | 'rejected',
  reason: 'missing_signature'|'invalid_signature'|'body_too_large'|'rate_limited'|null,  // null iff verified
  eventType: string | null, method, bodyBytes: number,
  isReplay: boolean, replayOfId: number | null, replayResponseStatus: number | null,
  receivedAt: string
}
RecordDetail = RecordSummary & {   // = 02 RecordDetail
  url,
  headers: Record<string, string>, // whitelist (02 §5.1): configured signatureHeader, x-request-id, user-agent, content-type — lowercase keys
  rawBody, bodyParsed: unknown | null,
  destination: Destination | null,     // Destination type defined once in 02 §4 — record-detail wire omits auth (the credential belongs to the subscriber row, never a captured record): frontend types it as RecordDestination = Omit<Destination, 'auth'>
  replays: ReplayChild[]
}
ReplayChild = {     // = 02 §5 wire shape — NOT a flattened { createdAt, outcome, … }
  id, receivedAt,
  request: { method: string; url: string; headers: Record<string, string>; rawBody: string },
  response: {
    outcome: 'ok' | 'timeout' | 'upstream_error',
    status: number | null,          // null for timeout / transport failure
    body: string | null,            // truncated at RESPONSE_BODY_MAX_BYTES
    durationMs: number
  }
}
```

View-model → wire notes: `requestId` is read from detail `headers['x-request-id']` (never a list field); replay count = `replays.length` / `stats.replays` (no `replayCount` on the list item); `bodyPreview` does not exist (C5 — list rows carry `bodyBytes`, detail carries `rawBody`); UI error display maps wire `reason` (not `rejectReason`).

### 3.1 Reconciliation checklist for 02-api-contract.md

1. Paths + verbs above (esp. `DELETE` = revoke, nested records under endpoint vs `/api/records`).
2. Is ingest origin `http://localhost:3000` (same origin, no `/api` prefix)? Frontend only copies the `url` string the API returns — never constructs it.
3. `search` semantics (request-id / event type / free text) and whether filters are query params vs POST body.
4. Replay outcome transport: §6 assumes HTTP status carries the error + `{ code }`.
5. Does create/rotate response really expose `secret` once? If instead a separate `GET …/secret`, the reveal modal consumes that.
6. Metrics: confirm no list/paginated counts on any other endpoint — badges read **only** endpoint #13.
7. Optional `GET /api/config` for retention days.

## 4. Component tree (props)

```
main.tsx → <QueryClientProvider> <AuthStoreProvider> <App routes>
AppShell (layout)                      { children }            <header> brand + workspace switcher + user menu (both inline) · <main>
RequireAuth                            { children }
AuthPage                               { mode: 'login'|'register' }
WorkspaceListPage                      —
WorkspaceOverviewPage                  { workspaceId }
├ RetentionNotice                      { days: number }
├ SubscriberList                       { subscribers }               // inline in WorkspaceOverviewPage.tsx — SubscriberRow lives there too
├ SubscriberForm                       { initial?, submitLabel, submitting?, onSubmit, onCancel? }   // create + edit, one component
├ SecretRevealModal                    { kind: 'created'|'rotated', url, token, secret, onClose } // one-time reveal + copy; props ← wire (02 §4): created: url=endpointUrl, token=ingestToken, secret=create-response.secret; rotated: secret=RotateResult.secret, url/token from pre-rotation cache (rotate = secret-only, ingestToken unchanged — C5)
└ ConfirmDialog                        { title, body, confirmLabel, danger, onConfirm, onCancel }
SubscriberDetailPage                   { workspaceId, subscriberId }   // reads ?record=; header (name/chips/actions) inline
├ CopyButton                           { value, label }              // aria-live "Copied"; clipboard logic in this file
├ MetricsBadges                        { metrics }                   // ONLY {received,verified,rejected} — cannot recount
├ TimelineList                         { records, statusTab, selectedRecordId, onSelect, isPaused }   // server-side q lives in the hook key; no hasMore/onLoadMore yet (first page only)
│ ├ TimelineTabs                       { value: 'verified'|'rejected'|'all', onChange }
│ ├ SearchInput                        { value, onChange }
│ └ TimelineRow                        { record, isSelected, onSelect }   // listbox/option, roving tabindex
├ RecordDetail                         { record: RecordDetail, onClose }
│ ├ JsonView                           { raw: string }               // JSON.parse → pretty, fallback raw text + label
│ ├ HeadersTable                       { headers }
│ ├ ReplayEditor                       { defaultBody, disabled, reason?, onSubmit(body), submitting }
│ └ ReplayComparison                    { original: ReplayComparisonOriginal, replay: ReplayChild }   // 5-field original subset; the error banner is a sibling owned by RecordDetail's ReplaySection
└ EmptyState                           { title, hint? }
NotFoundPage
```

Hooks: `useAuth` (auth/AuthStore), `useDocumentVisibility`, `useDebouncedValue(value, SEARCH_DEBOUNCE_MS)`, `useTimeline(subscriberId, tab, q)` (§5), `useReplay` (mutation + §6 mapping); the query keys and the data hooks (`useRecordDetail`, `useSubscriberStats`) live in `hooks/queries.ts`. Clipboard logic is inline in `CopyButton` — no `useCopyToClipboard` abstraction.

## 5. Data flow — 2s poll

```
visibilitychange ─→ useDocumentVisibility() ─→ visible: boolean
                                                      │
SubscriberDetailPage mount                            ▼
  ├ useTimeline      queryKey ['records', subscriberId, tab, q]
  ├ useSubscriberStats queryKey ['stats', subscriberId]        // queries.ts
  └ useRecordDetail (if ?record=) queryKey ['record', recordId]   // queries.ts
        timeline + stats: refetchInterval: () => (visible && enabled ? POLL_INTERVAL_MS : false)   // 2000; `enabled` is the membership-404 gate
        record detail:    refetchInterval: () => (visible ? POLL_INTERVAL_MS : false)              // no gate — the retention 404 is handled by clearing ?record=
              staleTime 0 · placeholderData: keepPreviousData (list only)
```

1. Mount → immediate fetch of list + stats (+ detail if selected).
2. Every 2000 ms while `document.visibilityState === 'visible'`, the interval refetches all three queries; tab hidden → `refetchInterval` resolves `false`, polling stops; visible again → resumes + one catch-up refetch (Query's focus refetch).
3. Response replaces cache → re-render. List rows prepend newest-first; **selection never auto-moves** (`?record=` unchanged).
4. Tab/search change → new `queryKey` → previous page kept (`keepPreviousData`), no loading flash. Search debounced 300 ms server-side (`q` param — C5).
5. Selected record 404s (retention deleted it mid-view) → clear `?record=`, toast "record expired (7-day retention)", keep polling the list.
6. Replay success → `invalidateQueries` for `['records', subscriberId]`, `['record', recordId]` (new replay child), and deliberately **not** stats — badges come from the canonical count and replays (`replayOfId IS NOT NULL`) must never bump them.
7. 401 from any call → `AuthStore.logout()` + redirect `/login?next=…` (single interceptor in the HTTP client).

No WebSocket (spec), no service worker, no optimistic timeline insert (server is source of truth within 2 s).

## 6. Replay flow & error mapping

`ReplayEditor` is a textarea (mono font, JSON preset = pretty-printed original body). Validation before submit: `JSON.parse` must succeed → else inline error (`aria-invalid` + `aria-describedby`, text = parser message, no silent disable). On submit → `POST /api/records/:id/replay { body }`.

| Transport | Meaning | UI treatment |
|---|---|---|
| 200 `{ data: { replayRecordId, outcome:'ok', response:{ status, body, durationMs }, savedAt } }` | destination answered (any upstream status — upstream 4xx/5xx is a *result*, not an API error) | `ReplayComparison`: original request + ingest outcome (left) vs replay destination response (right); status chip + body `<pre>` |
| **400** `{ code:'replay_target_blocked', … }` | SSRF guard: loopback/private/link-local/metadata IP; **no record written** | banner: "Target blocked — private or metadata address" + link to the subscriber edit form (`#edit-heading` — the only fix is a new destination URL) |
| **502** `{ code:'replay_upstream_error' }` | transport failure to destination (ECONNREFUSED / TLS / DNS gone); replay record saved, outcome `upstream_error` | banner "Destination unreachable — connection failed", retry allowed |
| **504** `{ code:'replay_timeout' }` | destination no response within REPLAY_TIMEOUT (10 s); record saved, outcome `timeout`; `details.replayRecordId` opens the attempt | banner "Destination did not respond within 10 s", retry allowed |
| **401** | JWT invalid/expired (our API) | global logout redirect (client never sees this inline) |
| **404** | record/subscriber gone (retention) | inline error + refresh list, clear selection |
| **410** | subscriber revoked | replay editor disabled with reason banner |
| **413** `{ code:'body_too_large' }` | edited body over the 1 MB transport cap (body parser, before the handler); no record written | banner "Replay body too large — shorten it and replay again", editor stays open |
| network fail (fetch throws) | client offline / DNS to *our* API — request never reached the server | inline "retry" with error text |

No **429** row: replay is never rate-limited — ingest is the only rate-limited surface in v1 (02 §11); offline is covered by the network-fail row above.

Pure function `mapReplayError(status, code, message): ReplayErrorView { title, hint, retryable }` is the single mapping point (unit-tested §9). Note: the **destination's** own 401/404 never arrive here — they come back inside the 200 envelope as `response.status` and render as data.

## 7. Metrics badges

`MetricsBadges({ metrics })` renders received / verified / rejected from endpoint #13 only. No component may derive counts from `records` (replays would double-count — the SPEC interview-story bug). Defensive: the props type is `{received:number; verified:number; rejected:number}`, not the full endpoint, so a records array literally cannot be passed in. After replay, badges must be unchanged — covered by regression test §9.

## 8. State & storage

| State | Where | Notes |
|---|---|---|
| Access token | `localStorage['hooklab.token']` | not httpOnly (SPA, no refresh-token in scope); XSS tradeoff documented in this file — logout clears it; all API via relative `/api` + same-origin cookie would be the alternative, undecided (§11) |
| User | memory, from `GET /api/auth/me` on boot | |
| Last workspace | `localStorage['hooklab.lastWorkspaceId']` | `/` redirect target |
| Selected record | URL `?record=` | deep-linkable, poll-stable |
| Timeline tab / search | component state (+ tab mirrored in `?tab=` nice-to-have) | |
| Theme | none — single dark theme | see §10 |
| Server cache | TanStack Query | no client store |

Named constants in `frontend/src/config.ts`: `POLL_INTERVAL_MS = 2000`, `SEARCH_DEBOUNCE_MS = 300`, `RETENTION_DAYS_FALLBACK = 7` (fallback — `/api/config` overrides it when present), `REPLAY_TIMEOUT_MS = 10_000` (display only — enforced server-side), `INGEST_URL` never constructed client-side.

## 9. Design / UI (swe_conventions §4 — anti-AI-fingerprint)

- **Aesthetic:** log-viewer, not marketing. Dense rows (~28 px), monospace data, hairline borders, no hero, no badge-above-H1, no gradients anywhere (0 occurrences of `linear-gradient(` as decoration), no emoji icons, no numbered "01 02 03" decoration.
- **Fonts (purposeful + fallback):** `--font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif`; `--font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`. Loaded via Google Fonts `preconnect` + `display=swap` (2 families, ≤3 weights). Declared token must match shipped font (§4 rule).
- **Color tokens (dark-first, both requirements explicit):** primary **blue** `oklch(0.72 0.13 245)`; accent **amber** `oklch(0.80 0.14 80)` → OKLCH hue delta **165° ≥ 20°** (copy-confirm + rotate use accent; navigation/links primary). Status semantics separate: verified green `oklch(0.75 0.14 155)`, rejected red-orange `oklch(0.68 0.17 35)` — status is a different job than brand. All interactive/status colors + body text verified **≥ 4.5:1** on `bg: oklch(0.16 0.012 255)`; banned greys `#888/#999` unused for body text. Focus ring = primary at 2px, never removed.
- **States:** hover/focus/active derive from tokens (`color-mix` from base), no per-component invented hues.
- **Landmarks & headings:** single `<h1>` per page (workspace name on overview, endpoint name on detail); sections `<h2>` (Timeline / Request detail / Replay); `<header> <nav> <main> <aside>` (timeline) semantics; tables use real `<table>` with `<caption>`-equivalent labels.
- **Keyboard:** timeline = `role="listbox"` + roving tabindex, ↑/↓ move, Enter/Space select, Escape closes detail/dialog; dialogs trap focus, restore to trigger, `aria-modal`; every icon-only button has `aria-label`; copy feedback via `aria-live="polite"` "Copied".
- **Motion:** CSS transitions only, ≤120 ms, all disabled under `@media (prefers-reduced-motion: reduce)`; no layout animation on new records (row inserts statically).
- **Mobile 320–375:** single column — header wraps, endpoint URL truncates with copy button beside it; on ≤768 px the detail panel becomes a full-width view with "← Timeline" back button (focus moves to detail `<h2>`); dialog width `min(92vw, 480px)`. Must be tested on rendered DOM at 320 px, not screenshot-only.

## 10. File list

```
frontend/
├ index.html · vite.config.ts (dev proxy /api → :3000) · vitest.config.ts (or vite test field) · tsconfig.json
└ src/
  ├ main.tsx · App.tsx (router) · config.ts · styles/{tokens.css, global.css, app.css, replay.css}
  ├ auth/{AuthStore.tsx, RequireAuth.tsx, RequireGuest.tsx, nextPath.ts, tokenStorage.ts}
  ├ api/{httpClient.ts, types.ts, auth.ts, workspaces.ts, subscribers.ts, records.ts}
  ├ hooks/{queries.ts, useDocumentVisibility.ts, useDebouncedValue.ts, useTimeline.ts, useReplay.ts}
  ├ lib/{replayErrors.ts, lastWorkspace.ts}   // mapReplayError — pure
  ├ pages/{AuthPage, HomeRedirect, WorkspaceListPage, WorkspaceOverviewPage, SubscriberDetailPage, NotFoundPage}.tsx
  └ components/{AppShell, RetentionNotice, MetricsBadges, SubscriberForm, SecretRevealModal, ConfirmDialog, CopyButton,
     TimelineTabs, SearchInput, TimelineList, TimelineRow, RecordDetail, JsonView, HeadersTable, ReplayEditor,
     ReplayComparison, StatusBadge, EmptyState, Toast, ErrorBoundary}.tsx
     // WorkspaceSwitcher/UserMenu inline in AppShell.tsx; SubscriberList/SubscriberRow inline in
     // WorkspaceOverviewPage.tsx; ErrorBoundary wraps the app in main.tsx — not standalone component files
```

## 11. Tests (Vitest + Testing Library)

| File | Covers |
|---|---|
| `lib/replayErrors.spec.ts` | 400 `replay_target_blocked`, 413 `body_too_large`, 502 `replay_upstream_error`, 504 `replay_timeout`, 401→logout view, 404, 410, network fail, success envelope; every row of §6 table (no 429 case — replay is never rate-limited) |
| `ReplayEditor.spec.tsx` | invalid JSON → `aria-invalid` + parser message, submit not fired; valid → `onSubmit(text)`; `disabled` renders reason banner |
| `RecordDetail.spec.tsx` | round trip reads the destination URL; stored child wins; 410 keeps editor mounted+disabled with one reason line; 404 → `onExpired`; 502 retryable banner (no link); 400 blocked banner carries the `#edit-heading` link; 413 keeps the editor open; in-flight disables the controls |
| `JsonView.spec.tsx` | pretty-prints parseable JSON; **falls back to raw text** on parse error (label "raw text") |
| `hooks/useTimeline.spec.tsx` | **polling pause/resume**: fake timers, 2000 ms → fetch called again; dispatch `visibilitychange` hidden → no further fetches; visible → resumes; filter change swaps `queryKey` |
| `MetricsBadges.spec.tsx` | renders API numbers; regression: after simulated replay invalidation the rendered counts are unchanged (canonical-count guard) |
| `hooks/useDebouncedValue.spec.ts` | 300 ms collapse of rapid input |
| `ConfirmDialog.spec.tsx` | Escape cancels, focus starts on Cancel for destructive rotate/revoke, confirm fires handler |
| `RequireAuth.spec.tsx` | no token → redirect with `?next=`, token present → renders children |
| `TimelineList.spec.tsx` | ArrowDown/ArrowUp roving focus, Enter selects (listbox contract) |

Deliberately untested in unit scope: Caddy/Docker, real 2s timing against live API (Playwright e2e lives with a future QA pass), pixel layout.

## 12. Deliberately undecided / deferred

1. **Light theme** — tokens structured for a second palette; single dark theme ships (tool aesthetic, halves contrast QA).
2. **JWT storage hardening** — localStorage chosen for scope; httpOnly-cookie + refresh would need a backend change (flag for 02/06 if security review demands).
3. **Syntax highlighting in `JsonView`** — plain `<pre>` + mono now; lib only if demo demands it.
4. **"All" tab** — kept optional; backend supports omitting `status`.
5. **`GET /api/config`** for retention days — fallback constant `RETENTION_DAYS = 7`.
6. **Overview-page metrics** — per-endpoint badges on detail only (avoids N+1); add aggregate later if asked.
7. **i18n** — UI copy English only (spec voice), no i18n framework.

---
**Version:** 1.0.0-draft (2026-10-08) · Author: design agent · Pending: reconcile §3/§3.1 against `docs/design/02-api-contract.md` once it exists.
