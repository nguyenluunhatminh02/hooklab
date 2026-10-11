#!/usr/bin/env node
// P9 load-test gate: 500 req / 5 min against POST ${TARGET}/ingest/${TOKEN}.
//
// Gate contract (BUILD_PLAN §7 P9):
//   - every response must be 200, or 429 carrying a valid integer Retry-After;
//     anything else (5xx, 401, timeout, connection error, 429 w/o Retry-After) FAILS
//   - zero request timeouts (counted separately)
//   - process.exitCode = 1 on any violation
//
// Required env:
//   TARGET            e.g. https://hooks.example.com (no trailing slash required)
//   TOKEN             subscriber ingest token
// Optional env:
//   SUBSCRIBER_SECRET  HMAC-SHA256 secret for X-Hub-Signature-256 (contract 02 §9:
//                      unsigned requests get 401 missing_signature, so the real
//                      gate run needs it; omit only against a signing-disabled dev backend)
//   LOADTEST_REQUESTS           default 500
//   LOADTEST_DURATION_MINUTES   default 5
//   LOADTEST_TIMEOUT_MS         per-request timeout, default 10000
//   LOADTEST_SIGNATURE_HEADER   default X-Hub-Signature-256 (subscriber may override)
//
// CLI fallback kept for convenience: node scripts/loadtest.mjs <token> [target]

import { createHmac } from 'node:crypto';

const [, , tokenArg, targetArg] = process.argv;

const TARGET = process.env.TARGET ?? targetArg;
const TOKEN = process.env.TOKEN ?? tokenArg;
const SUBSCRIBER_SECRET = process.env.SUBSCRIBER_SECRET;
const SIGNATURE_HEADER = process.env.LOADTEST_SIGNATURE_HEADER ?? 'X-Hub-Signature-256';

const TOTAL_REQUESTS = Number(process.env.LOADTEST_REQUESTS ?? 500);
const DURATION_MINUTES = Number(process.env.LOADTEST_DURATION_MINUTES ?? 5);
const TIMEOUT_MS = Number(process.env.LOADTEST_TIMEOUT_MS ?? 10_000);

if (!TARGET) {
  console.error('loadtest: TARGET is required (env TARGET or 2nd CLI arg), e.g. TARGET=https://hooks.example.com');
  process.exit(2);
}
if (!TOKEN) {
  console.error('loadtest: TOKEN is required (env TOKEN or 1st CLI arg) — the subscriber ingest token');
  process.exit(2);
}
for (const [name, value] of [
  ['LOADTEST_REQUESTS', TOTAL_REQUESTS],
  ['LOADTEST_DURATION_MINUTES', DURATION_MINUTES],
  ['LOADTEST_TIMEOUT_MS', TIMEOUT_MS],
]) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`loadtest: ${name} must be a positive number, got ${value}`);
    process.exit(2);
  }
}
if (!SUBSCRIBER_SECRET) {
  console.error(
    'loadtest: warning — SUBSCRIBER_SECRET not set; sending unsigned requests. ' +
      'Per API contract 02 §9 those return 401 missing_signature, which fails the gate.'
  );
}

const DURATION_MS = DURATION_MINUTES * 60 * 1000;
const INGEST_URL = `${TARGET.replace(/\/+$/, '')}/ingest/${TOKEN}`;

const statusCounts = new Map();
const violations = [];
const latencies = [];
const counts = {
  total: 0,
  ok200: 0,
  rateLimited429: 0,
  timeouts: 0,
  connectionErrors: 0,
};

function recordStatus(status) {
  statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
}

function violation(seq, status, reason, extra = {}) {
  violations.push({ seq, status, reason, ...extra });
}

function buildSignedRequest(seq) {
  const payload = JSON.stringify({ type: 'loadtest', seq, sentAt: Date.now() });
  if (!SUBSCRIBER_SECRET) {
    return { payload, headers: { 'content-type': 'application/json' } };
  }
  // HMAC over the exact bytes being sent — contract 02 §9 step 5 verifies
  // sha256=<hex> of the raw body with timingSafeEqual.
  const digest = createHmac('sha256', SUBSCRIBER_SECRET).update(payload).digest('hex');
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: `sha256=${digest}`,
    },
  };
}

async function sendOne(seq) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  counts.total += 1;

  try {
    const { payload, headers } = buildSignedRequest(seq);
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    });
    recordStatus(res.status);

    if (res.status === 200) {
      counts.ok200 += 1;
      return;
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      // Contract sends integer seconds (ceil); HTTP-date or junk fails the gate.
      if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) {
        counts.rateLimited429 += 1;
        return;
      }
      violation(seq, 429, '429 without valid integer Retry-After', { retryAfter });
      return;
    }

    violation(seq, res.status, res.status >= 500 ? '5xx response' : 'unexpected status');
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      counts.timeouts += 1;
      violation(seq, null, `request timeout after ${TIMEOUT_MS}ms`);
    } else {
      counts.connectionErrors += 1;
      violation(seq, null, 'connection error', { error: err?.message ?? String(err) });
    }
  } finally {
    clearTimeout(timer);
    latencies.push(Date.now() - startedAt);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const wallStart = Date.now();
const spacingMs = DURATION_MS / TOTAL_REQUESTS;

for (let seq = 0; seq < TOTAL_REQUESTS; seq += 1) {
  const dueAt = wallStart + seq * spacingMs;
  const waitMs = dueAt - Date.now();
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  await sendOne(seq);
}

latencies.sort((a, b) => a - b);

const summary = {
  config: {
    url: INGEST_URL,
    totalRequests: TOTAL_REQUESTS,
    durationMinutes: DURATION_MINUTES,
    perRequestTimeoutMs: TIMEOUT_MS,
    signed: Boolean(SUBSCRIBER_SECRET),
    signatureHeader: SUBSCRIBER_SECRET ? SIGNATURE_HEADER : null,
    wallClockMs: Date.now() - wallStart,
  },
  counts: {
    ...counts,
    violations: violations.length,
  },
  statusCounts: Object.fromEntries([...statusCounts.entries()].sort((a, b) => a[0] - b[0])),
  latencyMs: {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    min: latencies[0] ?? null,
    max: latencies[latencies.length - 1] ?? null,
  },
  violations,
  gate: violations.length === 0 ? 'PASS' : 'FAIL',
};

console.log(JSON.stringify(summary, null, 2));

process.exitCode = violations.length > 0 ? 1 : 0;
