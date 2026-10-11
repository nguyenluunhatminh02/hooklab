# OWNER RUNBOOK — hooklab

> Phần còn lại của repo chỉ owner làm được: cần VPS/domain thật, cần thời gian thực (cron 03:00 UTC), hoặc cần quyết định ngoài phạm vi máy này. Mọi bước dưới đây trỏ tới file/lệnh có thật (trong repo, `docs/DEPLOY.md`, hoặc file rehearsal đã dựng ở §4); không có bước nào được phát minh.
> **Ngày:** 2026-10-10 | **Bối cảnh:** đợt owner-closeout đã đóng phần làm được từ máy này — license, retention fire proof, script, rehearsal stack, coverage (chi tiết + số đo trong `docs/AUDIT_2026-10-10.md` §12).

---

## 1. Deploy P9 lên VPS thật + domain

**Trạng thái 2026-10-11: ĐÃ DEPLOY — không cần VPS nữa.** Production chạy ngay trên dev-box này qua Cloudflare Tunnel: **`https://hooklab.caphesuachua.blog`** (chi tiết topology + files + edge caveat: `docs/DEPLOY.md` §2.4.1). VPS/ACME bên dưới chỉ còn là phương án B nếu muốn tách khỏi máy này.

**Vận hành bản đang chạy (compose project `hooklab-prod`):**

```bash
cd /home/kronosss2002/Desktop/hooklab
CHAIN="-f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.tunnel.yml"

docker compose -p hooklab-prod $CHAIN --env-file .env.prod ps            # trạng thái
docker compose -p hooklab-prod $CHAIN --env-file .env.prod logs -f app   # log app
docker compose -p hooklab-prod $CHAIN --env-file .env.prod up -d --build # rebuild + restart
docker compose -p hooklab-prod $CHAIN --env-file .env.prod down          # tắt (giữ volume/DB)

# Smoke qua URL public (98 check; PG_CONTAINER trỏ DB prod)
BASE=https://hooklab.caphesuachua.blog PG_CONTAINER=hooklab-prod-postgres-1 \
  node scripts/hooklab-smoke.js        # → 98 passed, 0 failed

# Backup DB prod
docker compose -p hooklab-prod $CHAIN --env-file .env.prod exec -T postgres \
  pg_dump -U hooklab hooklab | gzip > /var/backups/hooklab/pg-$(date +%F_%H%M%S).sql.gz
```

**Port table (không đụng nhau):**

| Thứ | Port | Ghi chú |
|---|---|---|
| Dev HookLab API | `:3100` | curl read-only, không restart |
| Dev Postgres (`hooklab-postgres-1`) | `:5435` | project `hooklab` |
| Prod caddy (`hooklab-prod-caddy-1`) | `127.0.0.1:8095` | **loopback-only** — cloudflared gọi vào |
| Prod app/postgres | — | không publish host (M-1) |

**Reboot persistence:** `docker.service` enabled + `restart: unless-stopped` cả 3 service + `Linger=yes` cho `cloudflared-tunnel.service` → tự lên lại, không cần login. Sau reboot verify: `docker compose -p hooklab-prod $CHAIN --env-file .env.prod ps` → 3 container Up, rồi `curl -sS https://hooklab.caphesuachua.blog/ready`.

**Rollback:**
```bash
docker compose -p hooklab-prod $CHAIN --env-file .env.prod down
cp ~/.cloudflared/config.yml.bak-20261011-pre-hooklab ~/.cloudflared/config.yml
systemctl --user restart cloudflared-tunnel.service
# DNS: xóa CNAME hooklab.caphesuachua.blog trên Cloudflare dashboard (CLI không có lệnh xóa route dns)
```

**Bẫy đã gặp (đừng lặp lại):** đừng chạy `docker compose … config` với `--env-file .env.prod` — merged output **in thẳng giá trị secret** ra terminal/log; dùng `config --volumes` nếu cần kiểm tra shape. Và đừng kết luận app hỏng khi đọc body 5xx qua URL public — Cloudflare thay body lỗi (xem `docs/DEPLOY.md` §2.4.1 bảng đo).

### Phương án B — VPS + Let's Encrypt (chưa cần)

**Việc:** dựng stack prod (Docker Compose + Caddy TLS) trên VPS, trỏ domain thật.

**Đọc trước — `docs/DEPLOY.md`:**
- §1 Prerequisites — VPS, DNS A record, Docker Engine ≥ 24 / Compose plugin ≥ 2.20, firewall mở 80/443 và đóng 5432/3000, outbound HTTPS cho replay.
- §2.1–2.6 — clone/copy tree, generate secrets, viết `.env`, TLS site block, `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`, verify `/health` + `/ready` + header HSTS.
- §3 — smoke end-to-end bằng curl (register → workspace → subscriber → signed ingest → record trong UI).

**Điểm phải sửa trước khi deploy:** dòng đầu `docker/Caddyfile.prod` đang là `hooklab.example.com` — thay bằng domain thật. Đó là site address kích hoạt ACME của Caddy; bind `:80` trần thì không có TLS. TLS issuance (Let's Encrypt) không rehearsal được từ máy này vì cần FQDN công khai.

**Pre-flight evidence đã có** — rehearsal stack cùng ngày chạy đúng shape prod, loopback-only:
- Compose project `hooklab-rehearsal`: `hooklab-rehearsal-postgres-1` (127.0.0.1:5437→5432), `hooklab-rehearsal-app-1` (127.0.0.1:3111→3000), `hooklab-rehearsal-caddy-1` (127.0.0.1:8088→80). Entrypoint `prisma migrate deploy` áp 2 migrations (`20261008111025_init`, `20261010045651_destination_auth`); `/health` và `/ready` đều 200 qua Caddy.
- Smoke `scripts/hooklab-smoke.js` **98/98 hai lần** tại `http://127.0.0.1:8088` với `PG_CONTAINER=hooklab-rehearsal-postgres-1`; mọi request log của app mang `"via":"1.1 Caddy"`.
- UI pass đầu tiên trên container (Playwright): đăng ký user → workspace → subscriber với bearer auth → ingest webhook đã ký (HTTP 200) → replay outbound tới `https://example.com/hooks/rehearsal` nhận HTTP 405 trong 253 ms, body render trong UI.
- Khác biệt có chủ đích so với prod: `docker/Caddyfile` (dev `:80`) thay vì `Caddyfile.prod` (TLS); secrets throwaway inline trong `/tmp/hooklab-rehearsal/compose.override.yml` (không commit); port loopback để không đụng các project khác trên máy.

---

## 2. Log line retention 03:00 UTC đầu tiên trên box thật

**Việc:** chờ lần chạy tự nhiên đầu tiên rồi đọc log.

```bash
# DEPLOY.md §4.2 — sau 03:00 UTC đầu tiên post-deploy
docker compose logs app | grep 'retention: deleted'
# Kỳ vọng: 1 dòng/ngày, ví dụ "retention: deleted 0 records older than 7d" trên box mới
```

**Đã pin trong repo:** `backend/src/retention/retention.service.spec.ts` boot `AppModule` thật, lấy job đã đăng ký từ `SchedulerRegistry`, set `waitForCompletion = true`, `await cronJob.fireOnTick()` trên DB sống, spy `Logger.prototype.log` và assert đúng chuỗi `retention: deleted 3 records older than 7d` plus hiệu ứng DB (expired/replay-cascade/stale-window biến mất, row young còn nguyên) rồi cleanup. Phần chưa có chỉ là lần chạy lịch tự nhiên trên box thật; không có manual trigger trong app.

---

## 3. PR-body clause (chỉ khi repo thành git repository)

Repo hiện không phải git repository, không remote, không có PR nào tồn tại. Nếu sau này đưa lên remote: mỗi PR body do người viết (1–3 câu what + why + quyết định ngầm, disclosure AI-assisted) theo `.claude/rules/swe_conventions.md` §5 và BUILD_PLAN P10. Không có template tự động nào được tạo thay owner.

---

## 4. Rehearsal teardown (**đã chạy 2026-10-11**)

Stack `hooklab-rehearsal` đã được thu hồi ngày 2026-10-11 (exit 0): 3 container + network `hooklab-rehearsal_default` xóa, port 5437/3111/8088 trả lại, volumes `hooklab-rehearsal_pgdata` / `hooklab-rehearsal_caddy_data` giữ nguyên; dev stack (`hooklab-postgres-1`, API :3100) không bị chạm. Lệnh đã dùng, giữ lại để dựng/thu hồi vòng sau:

```bash
cd /home/kronosss2002/Desktop/hooklab
docker compose -p hooklab-rehearsal \
  -f docker-compose.yml \
  -f /tmp/hooklab-rehearsal/compose.override.yml \
  up -d --build     # dựng lại (rehearsal)
docker compose -p hooklab-rehearsal \
  -f docker-compose.yml \
  -f /tmp/hooklab-rehearsal/compose.override.yml \
  down              # thu hồi, giữ volumes
```

- `down` giữ volumes `hooklab-rehearsal_pgdata` / `hooklab-rehearsal_caddy_data`; thêm `-v` mới xóa — dữ liệu rehearsal là throwaway.
- Override file ở `/tmp/hooklab-rehearsal/compose.override.yml` (không commit). `/tmp` có thể mất khi reboot — shape dựng lại (secrets mới bằng `openssl rand -hex 16` cho password, `openssl rand -hex 32` cho JWT_SECRET; giữ `!override` để port dev không lọt qua):
  ```yaml
  services:
    postgres:
      ports: !override
        - "127.0.0.1:5437:5432"
      environment:
        POSTGRES_PASSWORD: "<hex-16>"
    app:
      ports: !override
        - "127.0.0.1:3111:3000"
      environment:
        DATABASE_URL: postgresql://hooklab:<hex-16>@postgres:5432/hooklab
        JWT_SECRET: "<hex-32>"
        PUBLIC_BASE_URL: http://127.0.0.1:8088
    caddy:
      ports: !override
        - "127.0.0.1:8088:80"
  ```
- Lệnh này chỉ áp cho project `hooklab-rehearsal`. Stack dev (`hooklab-postgres-1`, API :3100) không nằm trong lệnh này.
