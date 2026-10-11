# HookLab

> Trung cấp · 3 tuần · devtools

Dev tích hợp payment/SaaS bên thứ ba (Stripe, GitHub, Shopee...) cần một nơi nhận webhook thật để debug, nhưng ngrok thì hết hạn còn log server thì không cho replay payload đã sửa. HookLab cấp cho mỗi workspace một endpoint công khai ổn định, verify chữ ký HMAC, ghi lại timeline request gần realtime và cho phép replay payload đã chỉnh sửa về đích đã khai báo — đúng thứ một team backend dùng hàng ngày khi tích hợp service bên ngoài.

## Phạm vi

- **Subscriber endpoint theo workspace:** mỗi workspace tạo endpoint tạm `POST /ingest/:token` với token sinh ngẫu nhiên 32 byte, HMAC-SHA256 secret riêng, và destination mặc định (method + URL + optional headers — validate URL khi tạo/sửa, chỉ chấp nhận http/https); token có thể rotate (sinh secret mới, secret cũ hết hiệu lực ngay) hoặc revoke (endpoint trả 410 Gone, request tới token đã revoke không được lưu)
- **Chống SSRF khi replay:** trước khi gửi request ra ngoài, DNS resolve rồi chặn loopback / private / link-local / cloud-metadata range (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7) — blocked trả 400 `replay_target_blocked`, không gửi request
- **Capture raw request nguyên vẹn:** middleware body parser riêng cho route `/ingest/*` giữ raw body (không parse JSON trước khi verify), lưu method, URL, whitelist header (x-hub-signature, x-request-id, user-agent, content-type), raw body tối đa 1MB — vượt 413 vẫn ghi 1 record rejected kèm lý do `body_too_large`
- **Verify chữ ký HMAC theo endpoint:** header tên configurable (mặc định `X-Hub-Signature-256` dạng `sha256=<hex>`), so sánh bằng `timingSafeEqual`; đúng chữ ký → record `status=verified` trả 200, sai/thiếu chữ ký → vẫn lưu record `status=rejected` kèm lý do cụ thể (`missing_signature` / `invalid_signature`) và trả 401, để hai tab Verified/Rejected trong UI luôn tách bạch
- **Timeline request gần realtime:** list record mới nhất trước, filter theo status (verified/rejected), search theo token/event type, mở chi tiết xem raw body đã format JSON + toàn bộ header; poll mỗi 2s (không WebSocket) để thấy request mới xuất hiện mà không refresh trang
- **Replay payload đã sửa:** người dùng sửa JSON ngay trong detail view rồi gửi lại tới destination đã khai báo ở subscriber (method + URL + header), bản replay lưu riêng với `replayOfId` trỏ về record gốc; metric "requests received" và mọi count/badge chỉ đếm record `where replayOfId IS NULL` nên replay không bao giờ làm số liệu tăng ảo; response status + body của bản replay lưu lại để so sánh với phản hồi gốc, timeout 10s trả về `replay_timeout`
- **Rate limit 60 request/phút/token:** vượt limit trả 429 kèm header `Retry-After` (số giây còn lại của window) và vẫn ghi 1 record rejected với `reason=rate_limited` để chủ endpoint thấy traffic đang bị chặn; counter sliding window trong PostgreSQL chỉ đếm request đi qua trước khi check limit — record `reason=rate_limited` KHÔNG được cộng vào window (tránh self-extending ban), reset khi token rotate
- **Retention 7 ngày:** cron hàng ngày (03:00 UTC, `@nestjs/schedule`) xóa record cũ hơn 7 ngày kèm replay của chúng (cascade), mỗi lần chạy ghi log số record đã dọn; workspace thấy "records auto-delete after 7 days" ngay trong UI

## Ngoài phạm vi

- Không làm RBAC nhiều role/SSO/OAuth2 — chỉ JWT email/password + membership owner/member đơn giản, mọi record thuộc workspace
- Không làm retry/backoff tự động cho replay (chỉ replay thủ công từng bản, không job queue, không dead-letter)
- Không hỗ trợ payload binary/multipart/streaming và không vượt 1MB — chỉ JSON/text; không làm tunnel kiểu ngrok, không IP allowlist, không mTLS
- Không làm alerting (Slack/email khi webhook fail) hay analytics nâng cao (chart phân bố event theo thời gian)
- Không làm multi-region/horizontal scaling cho ingest path — 1 VPS, 1 worker là đủ

## Stack

React 18 + Vite + TypeScript (frontend SPA), NestJS 11 + Prisma 7 + PostgreSQL (API, raw body capture qua body parser riêng cho route `/ingest/*`), JWT auth, `@nestjs/schedule` cho cron retention, Docker Compose deploy VPS (Caddy TLS), GitHub Actions CI (lint, typecheck, unit test, docker build). Vitest (unit test)

> **Note (quyết định khi scaffold):** backend unit test dùng Jest (test runner mặc định của NestJS 11 — Vitest friction với `emitDecoratorMetadata`), frontend dùng Vitest đúng như spec.

## Kỹ năng

- Raw body capture trong NestJS/Express (body parser per-route, vì verify HMAC phải tính trên bytes gốc)
- HMAC-SHA256 verify an toàn bằng `timingSafeEqual`, hiểu được vì sao so sánh string `==` là timing attack
- Rate limiting thủ công bằng sliding window trong PostgreSQL + HTTP 429/`Retry-After` header, chống self-extending ban
- Chống SSRF: DNS resolve rồi kiểm tra IP private/loopback/metadata trước khi server-side fetch
- Prisma schema design cho self-referencing (`replayOfId`), cascade delete, query theo retention window
- Cron job retention với `@nestjs/schedule` và log quan sát được
- Polling realtime 2s + JSON detail view trên React (không cần WebSocket phức tạp)
- Docker Compose + Caddy TLS để nhận POST public, GitHub Actions CI pipeline

## Câu chuyện phỏng vấn

Một service thanh toán bên thứ ba gửi webhook về server nội bộ nhưng dev không reproduce được bug chữ ký sai vì không giữ được raw body — quyết định của em là route `/ingest/*` dùng body parser riêng giữ nguyên bytes thay vì để JSON parse nuốt mất, vì HMAC phải tính trên đúng từng byte đã nhận. Bug khó nhất: replay ban đầu bị ghi thành record mới nên metric "requests received" tăng ảo mỗi lần bắn lại, em tách schema thành record gốc và record replay (`replayOfId` nullable) rồi sửa mọi count/query chạy qua 1 hàm duy nhất filter `replayOfId IS NULL`, viết regression test fail trước khi fix theo đúng bug-fix protocol. Load test 500 request/5 phút (ở mức vượt rate limit 60/phút): mọi request đều nhận response đúng (200 hoặc 429 kèm `Retry-After`), không request nào timeout hay treo. Retention cron dọn xong data cũ đúng 1 lần/ngày, và toàn bộ flow ingest → verify → replay chạy live trên VPS với URL thật để demo khi phỏng vấn.

## REALITY

3 tuần sát trần: phần dễ trượt nhất là deploy VPS + Caddy TLS và CI docker build — nếu lùi thì cắt search/filter trước, giữ nguyên verify/replay/rate-limit vì đó là phần signal phỏng vấn.

## Mở rộng sau (5 mục)

1. Replay hàng loạt: chọn nhiều record rồi replay song song, bảng so sánh response từng bản
2. Forwarding rule: tự động chuyển tiếp verified event sang URL thật của team thay vì replay thủ công
3. Verify scheme nâng cao: hỗ trợ timestamp ±5 phút chống replay attack (Stripe-style) và secret rotation có overlap 24h
4. Alert Slack/Discord khi tỷ lệ rejected vượt ngưỡng trong 5 phút
5. Diff view giữa raw body gốc và payload đã sửa trước khi replay
