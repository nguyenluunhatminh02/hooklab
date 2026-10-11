# HookLab — Deployment Runbook (Solo-Dev VPS)

> **Scope:** single VPS, Docker Compose + Caddy TLS. This runbook is the operator's checklist for the first deploy and day-2 ops. Every step references a real file in this repo; steps that depend on files not yet committed are tagged **PENDING**.

**Legend:**
- **VERIFIED** — file exists and content matches the command shown (checked against repo state at write time).
- **PENDING** — depends on something not yet committed or not reproducible on this machine (e.g. the git remote). The section tells you what to check; the app-side controllers it used to wait on (auth, subscribers, ingest, retention) have all landed.

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| VPS (Ubuntu 22.04+ or Debian 12) | 1 vCPU / 1 GB RAM is enough for the P9 load test (500 req / 5 min) |
| DNS A record | Point `hooklab.example.com` (or your domain) at the VPS IP — Caddy needs a public FQDN to obtain TLS automatically |
| Docker Engine + Compose plugin | `docker --version` ≥ 24, `docker compose version` ≥ 2.20. Install via Docker's official apt repo, not the Ubuntu `docker.io` package |
| Firewall | **Open:** 80/tcp, 443/tcp. **Closed:** 5432/tcp (postgres), 3000/tcp (app) — see M-1 hardening note below |
| Outbound HTTPS | The replay path fetches destination URLs; the VPS must reach the public internet on 443 |

**M-1 hardening — why 5432 and 3000 stay closed:**
The base `docker-compose.yml` publishes `${POSTGRES_HOST_PORT:-5432}:5432` and `3000:3000` for local dev (set `POSTGRES_HOST_PORT` in `.env` only when the local 5432 is already taken; a fresh VPS needs no override). The prod override (`docker-compose.prod.yml`) drops both `ports:` blocks with `!reset []` — plain merge would concatenate ports and collide on the same host port. Postgres and app are then reachable only on the compose network (caddy proxies to `app:3000`; admin access is `docker compose exec`). All external traffic enters through Caddy on 80/443 only. Verify after deploy with `ss -tlnp | grep -E ':(5432|3000)'`: no output.

---

## 2. First Deploy

### 2.1 Clone the repo **PENDING**

```bash
# Repo is not yet initialized as a git remote on this machine.
# Once the GitHub/GitLab remote exists:
git clone git@github.com:<org>/hooklab.git /opt/hooklab
cd /opt/hooklab
```

*Until the remote is set up, copy the working tree to `/opt/hooklab` by whatever transport you use (rsync, tarball, etc.).*

### 2.2 Generate secrets

```bash
# JWT signing key — 64 hex chars (32 bytes)
openssl rand -hex 32
# → e.g. a3f1...b9c2  (save this)

# Postgres password — pick a strong random string
openssl rand -base64 24
# → e.g. Kz9/...=  (save this, no trailing newline when pasting)
```

### 2.3 Write `.env` **VERIFIED**

Create `/opt/hooklab/.env` (the file is in `.gitignore`, never committed):

```bash
cat > .env <<'EOF'
POSTGRES_USER=hooklab
POSTGRES_PASSWORD=<paste the base64 string from 2.2>
POSTGRES_DB=hooklab
DATABASE_URL=postgresql://hooklab:<same-password>@postgres:5432/hooklab
JWT_SECRET=<paste the 64-hex string from 2.2>
PUBLIC_BASE_URL=https://hooklab.example.com
PORT=3000
EOF
chmod 600 .env
```

`PUBLIC_BASE_URL` is the value the app uses to build `endpointUrl = ${PUBLIC_BASE_URL}/ingest/${ingestToken}` shown in the UI. It **must** be the HTTPS domain, not `http://localhost:3000` — otherwise subscribers paste a localhost URL into Stripe/GitHub and webhooks never arrive.

### 2.4 TLS site block **VERIFIED**

Two Caddyfiles ship, and the prod override mounts the right one:

- `docker/Caddyfile` — dev. Binds `:80` (plain HTTP) so a local `docker compose up` keeps serving `http://localhost`.
- `docker/Caddyfile.prod` — prod. Site address `hooklab.example.com`; that domain site address is what makes Caddy obtain a Let's Encrypt certificate automatically (a bare `:80` bind never triggers ACME). `docker-compose.prod.yml` bind-mounts it over `/etc/caddy/Caddyfile`.

If your domain is not `hooklab.example.com`, edit the first line of `docker/Caddyfile.prod` before deploying. Verify with `grep -E '^\w' docker/Caddyfile.prod` — the first non-blank line must be your domain, not `:80`. Deploying with the base file alone (no prod override) serves HTTP only and `curl https://…` fails at the TLS handshake.

Deploying from this machine (behind NAT, no inbound 80/443)? Skip 2.5–2.6 and use the Cloudflare Tunnel variant in §2.4.1 instead.

### 2.4.1 Cloudflare Tunnel (máy này — deployed 2026-10-11)

**Live:** `https://hooklab.caphesuachua.blog` — production deploy thật trên dev-box này (2026-10-11), đang chạy, smoke 98/98 qua edge.

**Topology (vì sao không phải `Caddyfile.prod`/Let's Encrypt):** máy nằm sau NAT, port 80 inbound chỉ bind loopback (nginx blog/ielts), 443 không có listener — ACME HTTP-01 không thể chạy. Mọi service public trên box này đều đi qua tunnel Cloudflare `3f4969cc-…` (systemd **user** service `cloudflared-tunnel.service`, Linger=yes → sống qua reboot). TLS chấm dứt tại edge; tunnel giao plain HTTP tới loopback:

```
Internet ──TLS──▶ Cloudflare edge ──tunnel──▶ cloudflared (host)
                                              http://127.0.0.1:8095
                                              caddy (hooklab-prod-caddy-1)
                                              ├─ /api/* /ingest/* /health /ready ─▶ app:3000
                                              └─ còn lại ─▶ static SPA (try_files /index.html)
```

**Files trong repo:**

| File | Vai trò |
|---|---|
| `docker-compose.tunnel.yml` | override file **thứ 3** — `ports: !override ["127.0.0.1:8095:80"]` cho caddy + mount `Caddyfile.tunnel`. `!override` thay list base chứ không append — nếu để merge thường, `80:80`/`443:443` vẫn bind public |
| `docker/Caddyfile.tunnel` | site `:80` plain HTTP (sau tunnel) — **không hostname, không ACME**; `encode gzip`, `header Strict-Transport-Security`; 4 handle `/api/* /ingest/* /health /ready` → `app:3000`; fallback SPA |
| `.env.prod` | secrets prod (gitignored, chmod 600) — `POSTGRES_USER/PASSWORD/DB`, `JWT_SECRET` mới, `PUBLIC_BASE_URL=https://hooklab.caphesuachua.blog`. Chỉ đọc bởi lệnh 3-file có `--env-file .env.prod`; dev workflow không bao giờ load file này |

**Tunnel side (host, ngoài repo):**
- Ingress: `~/.cloudflared/config.yml` — `hooklab.caphesuachua.blog → http://127.0.0.1:8095`; backup `~/.cloudflared/config.yml.bak-20261011-pre-hooklab`
- DNS: `cloudflared tunnel route dns 3f4969cc-a072-48d0-a881-24108942e1c2 hooklab.caphesuachua.blog` (CNAME, đã tạo)
- Restart: `systemctl --user restart cloudflared-tunnel.service` — ⚠ làm gián đoạn vài giây **mọi** subdomain khác trên cùng tunnel (dashboard/blog/ielts/sentiment)

**Bring up (chain 3 file bắt buộc):**

```bash
cd /home/kronosss2002/Desktop/hooklab
docker compose -p hooklab-prod \
  -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.tunnel.yml \
  --env-file .env.prod up -d --build
```

Verify (loopback trước, rồi qua edge):
```bash
curl -sS http://127.0.0.1:8095/health            # 200 — chưa qua tunnel
curl -sS https://hooklab.caphesuachua.blog/health # 200 — qua edge
ss -tlnp | grep 8095                              # CHỈ 127.0.0.1:8095
```

**Cô lập:** project `-p hooklab-prod` → container `hooklab-prod-*`, volume `hooklab-prod_pgdata`. Không trùng project `hooklab` (dev postgres :5435) hay rehearsal. Postgres/app không publish port host (kế thừa M-1 từ prod file); chỉ caddy publish loopback.

**Edge thay body 5xx khi qua tunnel (đo 2026-10-11):** Cloudflare edge thay body của response 5xx từ origin bằng trang lỗi của chính nó (16 byte `error code: 504`, `server: cloudflare`, `cf-ray …-SIN`) trong khi **status đi xuyên nguyên vẹn**. Đo trực tiếp cùng một request replay-timeout:

| Đường đi | Kết quả |
|---|---|
| Loopback `127.0.0.1:8095` | `504` sau 10.029 s — body JSON contract đầy đủ: `{"error":{"code":"replay_timeout","message":"destination did not respond within 10 s","requestId":"…","details":{"replayRecordId":97}}}` |
| Qua edge | `HTTP/2 504` sau 10.327 s — 16 byte `error code: 504` |

Timing khớp nhau (10.03 s origin + ~0.3 s edge) → origin đã trả lời đúng; body bị thay trên đường về, không phải edge timeout. **Hệ quả:**

- **UI degrade êm.** `mapReplayError` map theo **status** (504 → banner `timeout`), không theo body; `replayRecordId` là optional (`frontend/src/lib/replayErrors.ts` — "Absent on … a 504 answer that somehow omits details"). `httpClient` JSON.parse fail → payload null → `ApiError(504, …)`. Nút "Open the saved attempt" ẩn khi edge nuốt `details.replayRecordId`; banner vẫn hiện, không crash, không màn hình trắng.
- **Smoke script nhận biết substitution này** — `isEdgeSubstituted(r)` (`server: cloudflare` + body null) chỉ chấp nhận đúng dạng đó; null body từ nguồn khác vẫn fail. Contract body được verify đầy đủ ở lượt chạy loopback.
- **Đừng kết luận app hỏng từ body qua edge** — đối chiếu qua loopback :8095 trước. Test 5xx body qua URL public luôn phải tính đến substitution.

### 2.5 Bring the stack up **VERIFIED**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

- `docker-compose.yml` **VERIFIED** — defines `postgres`, `app`, `caddy` services, `pgdata` and `caddy_data` volumes; both images build from the repo-root context (the Dockerfiles COPY `package-lock.json`, `backend/`, `frontend/`, `docker/`).
- `docker-compose.prod.yml` **VERIFIED** — drops the dev host-port publishes for `postgres` and `app` (M-1), mounts `docker/Caddyfile.prod` for TLS, and sets `restart: unless-stopped` on every service.

The `app` service runs `docker/app-entrypoint.sh` (**VERIFIED**): `npx prisma migrate deploy && exec node dist/main.js`. First boot runs the initial Prisma migration; subsequent boots are no-ops if the schema hasn't changed.

### 2.6 Verify the deploy

```bash
# All four containers healthy
docker compose ps
# Expected: postgres (healthy), app (running), caddy (running)

# Caddy obtains TLS on first request (Let's Encrypt)
# Wait ~5-10s after `up -d`, then:
curl -sS -o /dev/null -w "%{http_code}\n" https://hooklab.example.com/health
# Expected: 200

# Readiness — this is the DB gate (health is liveness-only)
curl -sS https://hooklab.example.com/ready
# Expected: {"status":"ready"} ; 503 {"error":{"code":...,"message":"database not ready"}} until Postgres answers

# Caddy TLS cert
curl -sSI https://hooklab.example.com/health | grep -i strict-transport
# Expected: Strict-Transport-Security header present
```

If `/ready` returns 503, Postgres is not yet healthy — check `docker compose logs postgres` and re-run after the healthcheck passes (up to 50s with 10 retries × 5s interval). `/health` is liveness-only (200 whenever the process runs) and never reports 503 itself.

---

## 3. Smoke Test (End-to-End)

Walk through the full ingest path once after deploy. All commands use `https://hooklab.example.com`; replace with your domain.

### 3.1 Register a user

```bash
curl -sS -X POST https://hooklab.example.com/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-strong-password"}' \
  | tee /tmp/register.json
# Expected: HTTP 201, body bare (register/login are the envelope's sole
# exception, 02 §2): { "accessToken": "...", "tokenType": "Bearer", "user": {...} }

TOKEN=$(jq -r '.accessToken' /tmp/register.json)
```

If register returns 409, the email already exists — use `/api/auth/login` with the same shape to get an `accessToken`.

### 3.2 Create a workspace

```bash
curl -sS -X POST https://hooklab.example.com/api/workspaces \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"demo"}' \
  | tee /tmp/workspace.json
# Expected: HTTP 201, body { "data": { "id": 1, "name": "demo", ... } }

WS_ID=$(jq -r '.data.id' /tmp/workspace.json)
```

### 3.3 Create a subscriber (this gives you the ingest URL + HMAC secret)

```bash
curl -sS -X POST "https://hooklab.example.com/api/workspaces/$WS_ID/subscribers" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "stripe-demo",
    "destinationMethod": "POST",
    "destinationUrl": "https://your-real-app.example.com/webhooks/stripe"
  }' | tee /tmp/subscriber.json
# Expected: HTTP 201
# Body: { "data": { "id": 1, "ingestToken": "<64-hex>", "secret": "<full-hmac-secret>",
#                   "secretHint": "…cdef", "endpointUrl": "https://hooklab.example.com/ingest/<token>", ... } }

INGEST_TOKEN=$(jq -r '.data.ingestToken' /tmp/subscriber.json)
HMAC_SECRET=$(jq -r '.data.secret' /tmp/subscriber.json)
```

**Save `HMAC_SECRET` now.** The full secret appears only in this response and in future `POST /api/subscribers/:id/rotate` responses. Everywhere else the UI shows only `secretHint` (last 4 chars).

### 3.4 Send a signed webhook **VERIFIED** (signature algorithm matches `backend/src/common/constants/ingest.constants.ts`: header `X-Hub-Signature-256`, prefix `sha256=`)

The server verifies HMAC-SHA256 over the **exact received bytes** using `timingSafeEqual`. The bytes you sign must be byte-identical to the bytes `curl` sends — use `--data-binary @file` (not `-d`) and a file with no trailing newline.

```bash
# 1. Write the payload to a file (no trailing newline)
cat > /tmp/hook-body.json <<'EOF'
{"type":"payment.succeeded","id":"evt_demo_1","amount":4200}
EOF

# 2. Compute the signature over the exact file bytes
SIG="sha256=$(openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex /tmp/hook-body.json | awk '{print $NF}')"
echo "$SIG"
# → sha256=<64-hex-chars>

# 3. POST with the signature header
curl -sS -X POST "https://hooklab.example.com/ingest/$INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -H "X-Hub-Signature-256: $SIG" \
  --data-binary @/tmp/hook-body.json \
  -w "\nHTTP %{http_code}\n"
# Expected: HTTP 200
```

**Common mistakes that produce 401:**
- Using `curl -d '{...}'` inline — shell quoting can alter bytes. Always sign a file.
- Signing with the wrong secret (e.g. `secretHint` instead of `secret`).
- Adding a trailing newline to the file after signing (`echo` adds one, `cat >` with heredoc does not unless you type it).

### 3.5 Confirm the record appears in the UI

Open `https://hooklab.example.com/` in a browser, log in, navigate to the `demo` workspace → `stripe-demo` subscriber. The record should appear in the timeline within 2s (the UI polls every 2000ms per `frontend/src` design). Status badge: **Verified**.

Alternatively, via API:

```bash
curl -sS "https://hooklab.example.com/api/subscribers/$(jq -r '.data.id' /tmp/subscriber.json)/records" \
  -H "Authorization: Bearer $TOKEN"
# Expected: { "data": [ { "id": ..., "status": "VERIFIED", "eventType": "payment.succeeded", ... } ] }
```

---

## 4. P9 Gate Commands

The P9 acceptance criterion (BUILD_PLAN §P9): *500 req / 5 min against `/ingest/:token`: every response 200 or 429 with `Retry-After`, zero timeouts; retention log line observed.*

### 4.1 Load test **VERIFIED — executed 2026-10-09** (script at `scripts/loadtest.mjs`)

```bash
# Run from the repo root. Takes ~5 minutes.
# Env: TARGET required (env var or 2nd CLI arg — the script exits 2 if missing), TOKEN = ingest token,
# SUBSCRIBER_SECRET = HMAC secret (requests are signed — unsigned → 401 → gate fail).
TARGET=https://hooklab.example.com \
TOKEN="$INGEST_TOKEN" SUBSCRIBER_SECRET="$INGEST_SECRET" \
node scripts/loadtest.mjs
```

**Output** (JSON on stdout — actual shape; `gate` is the one-line verdict):
```json
{
  "config": { "url": "...", "totalRequests": 500, "durationMinutes": 5, "signed": true, "wallClockMs": 299409 },
  "counts": { "total": 500, "ok200": 300, "rateLimited429": 200, "timeouts": 0, "connectionErrors": 0, "violations": 0 },
  "latencyMs": { "p50": 22, "p95": 45, "p99": 91, "min": 7, "max": 386 },
  "violations": [],
  "gate": "PASS"
}
```

**Acceptance:**
- `gate` must be `PASS` (exit 0); any timeout, connection error, or status outside {200, 429-with-valid-integer-Retry-After} is a violation → exit 1.
- `rateLimited429` will be non-zero: 60 req/min × 5 min = 300 admitted max, so a 500-request run must show ~300 × 200 + ~200 × 429. That is correct behavior; the 429s prove the sliding window works.

**Evidence (2026-10-09, local boot on :3100 against `hooklab-postgres-1`):** 500/500 answered in 299.4 s — `ok200=300`, `rateLimited429=200`, `timeouts=0`, `connectionErrors=0`, `violations=0`; every 429 carried a valid integer `Retry-After`; p50 22 ms / p95 45 ms / p99 91 ms; exit 0.

### 4.2 Retention cron log

The retention cron fires daily at 03:00 UTC (`@Cron('0 0 3 * * *', { name: 'retention', timeZone: 'UTC' })` per BUILD_PLAN C7). Each run logs:

```
retention: deleted <N> records older than 7d
```

Check after the first 03:00 UTC post-deploy:

```bash
docker compose logs app | grep 'retention: deleted'
# Expected: one line per day, e.g. "retention: deleted 0 records older than 7d" on a fresh install
```

There is still no operator-facing manual trigger in v1. What changed: the log line is now pinned by an end-to-end test that boots AppModule, takes the registered `retention` job out of the `SchedulerRegistry`, fires it itself (`waitForCompletion = true`, then `cronJob.fireOnTick()`), and asserts the exact line plus the DB effects (expired rows gone, replays cascaded, stale window rows pruned, young rows kept). Run it from the repo root:

```bash
npm test --workspace backend -- retention.service.spec
# Expected: the "fires the registered cron job end-to-end" case passes (7/7 in this file)
```

The first natural 03:00 UTC run remains the post-deploy acceptance. Until then, confirm the scheduler is wired at boot:

```bash
docker compose logs app | grep -iE 'schedule|cron'
# Expected: ScheduleModule registered (forRoot called exactly once — twice means a duplicate forRoot)
```

---

## 5. Ops

### 5.1 Secret rotation

**Subscriber HMAC secret** (rotates the secret used to verify `X-Hub-Signature-256` on incoming webhooks):

```bash
curl -sS -X POST "https://hooklab.example.com/api/subscribers/$SUBSCRIBER_ID/rotate" \
  -H "Authorization: Bearer $TOKEN"
# Expected: { "data": { "secret": "<new-full-secret>", "secretHint": "…xyz",
#                       "rotatedAt": "...", "note": "previous secret invalid immediately; rate-limit window reset" } }
```

- The old secret fails verification **immediately**.
- The sliding-window rate-limit state for this token is deleted in the same transaction — a rotate during a 429 ban hands out a secret that is not already banned.
- The `ingestToken` (and therefore the ingest URL) is **stable** — you do not need to reconfigure the upstream sender (Stripe/GitHub/Shopee) if they allow you to update the secret independently of the URL.

**JWT_SECRET** (rotates the key that signs user login tokens):

```bash
# 1. Generate a new secret
openssl rand -hex 32
# 2. Update .env
sed -i 's/^JWT_SECRET=.*/JWT_SECRET=<new-value>/' /opt/hooklab/.env
# 3. Restart the app
docker compose restart app
```

**Caveat:** every existing user session is invalidated immediately. All users must log in again. Schedule this during a maintenance window if you have more than yourself as a user.

### 5.2 Backup (Postgres) — **drill executed 2026-10-09 (restore verified)**

The `pgdata` volume holds all Postgres data. Back it up with `pg_dump` via the running container:

> **Drill evidence (2026-10-09, local `hooklab-postgres-1`):** `pg_dump | gzip` produced an 18 K archive; restored into a scratch DB (`hooklab_restore_drill`) — row counts matched the source exactly (User 39 / Workspace 12 / Subscriber 12 / WebhookRecord 42) and an md5 checksum over User.email + Subscriber.name + WebhookRecord.status was identical (`03e4097cd88d7d4ec2509869e1da7045`) on both sides. Scratch DB dropped afterwards; the live DB was never the restore target. Restore always goes to a *new* database first — never over the source.

```bash
# One-shot logical backup
docker compose exec -T postgres pg_dump -U hooklab hooklab \
  | gzip > /var/backups/hooklab/pg-$(date +%F_%H%M%S).sql.gz

# Restore
docker compose exec -T postgres psql -U hooklab hooklab \
  < <(gunzip -c /var/backups/hooklab/pg-YYYY-MM-DD_HHMMSS.sql.gz)
```

Automate with a cron on the host. This repo ships no `scripts/backup.sh`, so the entries below run the pipeline directly — a nightly dump plus a second job that keeps 14 days:

```bash
# /etc/cron.d/hooklab-backup   (% must be escaped as \% inside cron)
0 2 * * * root mkdir -p /var/backups/hooklab && cd /opt/hooklab && { docker compose exec -T postgres pg_dump -U hooklab hooklab | gzip > /var/backups/hooklab/pg-$(date +\%F_\%H\%M\%S).sql.gz; } 2>>/var/log/hooklab-backup.log
15 3 * * * root find /var/backups/hooklab -name 'pg-*.sql.gz' -mtime +14 -delete >> /var/log/hooklab-backup.log 2>&1
```

The `cd /opt/hooklab` puts cron in the compose project directory so `exec` resolves the running `postgres` container; no `-f` flags are needed because `docker compose exec` targets containers by project name, and the dump does not depend on override config.

### 5.3 Rollback

**Roll back the app image** (e.g. a bad deploy):

```bash
# If docker-compose.prod.yml pins image tags (e.g. app: hooklab-app:v1.2.3):
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull app
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d app

# If it uses `build:` with a git SHA, check out the previous SHA and rebuild:
git checkout <previous-sha>
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build app
```

**Full rollback** (nuclear):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The `pgdata` volume survives `down`, so your data is preserved. To wipe data too: `docker compose down -v` (do not do this in prod).

### 5.4 Log locations

| What | Where |
|---|---|
| App (NestJS, including retention cron) | `docker compose logs app` / `docker compose logs -f app` |
| Postgres | `docker compose logs postgres` |
| Caddy (TLS issuance, access log) | `docker compose logs caddy` |
| Caddy TLS certs | `caddy_data` volume (`docker volume inspect hooklab_caddy_data`) |
| Host-level cron (backup) | `/var/log/hooklab-backup.log` (once you set up 5.2) |

### 5.5 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `docker compose ps` shows `app` restarting | DB not ready at boot, or bad env | `docker compose logs app` — look for Prisma P1001 (can't reach DB) or missing `JWT_SECRET`. Wait for postgres healthcheck, then `docker compose restart app`. |
| `GET /ready` returns 503 | Postgres unhealthy | `docker compose logs postgres`. Check `pg_isready` inside the container. If disk full, `docker system prune` or expand volume. |
| `GET /health` returns 200 but UI is blank | Frontend build missing | `docker compose logs caddy` — look for 404 on `/index.html`. Rebuild: `docker compose up -d --build caddy`. |
| `POST /ingest/:token` returns 401 | Signature mismatch | Re-run the smoke test (3.4) and check: (a) signing with full `secret`, not `secretHint`; (b) `--data-binary @file` not `-d`; (c) no trailing newline in the signed file. |
| `POST /ingest/:token` returns 404 | Unknown token | The subscriber was deleted or the token is wrong. List subscribers via UI or `GET /api/workspaces/:id/subscribers`. |
| `POST /ingest/:token` returns 410 | Subscriber revoked | Owner revoked the endpoint. Create a new subscriber. |
| `POST /ingest/:token` returns 413 | Body > 1 MB | By design. The record is still saved with `rejectReason=body_too_large`. |
| `POST /ingest/:token` returns 429 | Over 60 req/min | **Expected.** Wait for the `Retry-After` header value (seconds) before retrying. The limit is fixed at 60/min/token (`backend/src/common/constants/ingest.constants.ts`); v1 has no quota configuration. |
| Caddy logs `TLS: handshake failure` | Let's Encrypt rate limit or DNS not propagated | Check `dig hooklab.example.com` resolves to the VPS IP. Wait 1h if you hit LE rate limits, or use the LE staging env for testing. |
| Retention cron doesn't fire | Module not wired | `docker compose logs app \| grep -i schedule` — should see `ScheduleModule initialized`. If missing, the parallel backend agent hasn't wired `ScheduleModule.forRoot()` in `AppModule` yet. |
| Replay returns `replay_target_blocked` | Destination URL resolves to private IP | By design (SSRF protection). Use a public destination URL. |
| Replay returns `replay_timeout` | Upstream didn't respond in 10s | Check the destination app; HookLab's timeout is fixed at 10s. |

---

## 6. File Index

| File | Owner | Status | Role in deploy |
|---|---|---|---|
| `docker-compose.yml` | — | **VERIFIED** | Base compose: postgres, app, caddy services; pgdata + caddy_data volumes; repo-root build contexts |
| `docker-compose.prod.yml` | — | **VERIFIED** | Prod overrides: drops 5432/3000 host ports (M-1), mounts TLS Caddyfile, restart policies |
| `docker-compose.tunnel.yml` | — | **VERIFIED** (deployed 2026-10-11) | Third chain file for this machine: caddy loopback publish `127.0.0.1:8095:80` (`!override`) + `Caddyfile.tunnel` mount; see §2.4.1 |
| `docker/Caddyfile` | — | **VERIFIED** (dev) | Reverse proxy + static file server on plain `:80` for local `docker compose up` |
| `docker/Caddyfile.prod` | — | **VERIFIED** (TLS) | Domain site block → Caddy auto-HTTPS; mounted by the prod override |
| `docker/Caddyfile.tunnel` | — | **VERIFIED** (deployed 2026-10-11) | Plain `:80` site behind the Cloudflare Tunnel (no ACME); gzip + HSTS; same route handles as prod |
| `.env.prod` | you (operator) | created at deploy (gitignored, 600) | Prod secrets for the tunnel chain; never loaded by the dev workflow |
| `docker/app-entrypoint.sh` | — | **VERIFIED** | `npx prisma migrate deploy && exec node dist/main.js` |
| `backend/Dockerfile` | — | **VERIFIED** | Multi-stage: node:22-alpine build → runtime |
| `frontend/Dockerfile` | — | **VERIFIED** | Multi-stage: vite build → caddy:2-alpine serving dist |
| `scripts/loadtest.mjs` | — | **VERIFIED** | P9 gate: 500 req / 5 min, asserts 200 or 429+Retry-After, zero timeouts |
| `scripts/hooklab-smoke.js` | — | **VERIFIED** | 98-check end-to-end suite over the live contract (auth → workspaces → subscribers → ingest → records → replay → cascade); `BASE` and `PG_CONTAINER` env; verified on dev `:3100` and on the containerized rehearsal stack through Caddy |
| `scripts/rebuild-restart.sh` | — | **VERIFIED** | Rebuild + restart of the dev API on `:3100`; the kill decision reads `/proc/<pid>/cwd` and cmdline, never a bare PID |
| `.env` | you (operator) | created at deploy | Never committed; see 2.3 |
| `.env.example` | — | **VERIFIED** | Reference for env var names |

---

## 7. Post-Deploy Checklist

Run this once after the first successful deploy:

- [ ] `curl -sS https://hooklab.example.com/health` returns 200
- [ ] `ss -tlnp` shows no 5432/3000 listener (M-1; only 80/443 published)
- [ ] Registered a user via UI or API
- [ ] Created a workspace + subscriber
- [ ] Sent a signed `POST /ingest/:token` and saw the record in the UI
- [ ] `node scripts/loadtest.mjs $TOKEN https://hooklab.example.com` exited 0
- [ ] Backed up the DB once (5.2)
- [ ] Set up the host cron for nightly backups
- [ ] Waited for the first 03:00 UTC and confirmed `retention: deleted …` in `docker compose logs app`
