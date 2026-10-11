/* HookLab live smoke v3 — full contract sweep against the real API.
 * Expectations are read from docs/design/02-api-contract.md §1.4/§6/§9.1. */
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const crypto = require('crypto');
const { execFileSync } = require('child_process');

async function req(method, path, { token, headers = {}, body, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    if (!h['content-type']) h['content-type'] = 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    if (!h['content-type']) h['content-type'] = 'application/json';
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  let j = null;
  try { j = await res.json(); } catch {}
  return { status: res.status, body: j, headers: res.headers, retryAfter: res.headers.get('retry-after') };
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ FAIL ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

const sign = (secret, raw) => `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex')}`;

// Cloudflare's edge replaces an origin 5xx body with its own error page
// (16-byte "error code: NNN", server: cloudflare) while passing the status
// through. So a 5xx answer over the tunnel arrives status-correct but
// body-less. Only detect that specific substitution — a null body from any
// other source is still a real failure.
function isEdgeSubstituted(r) {
  const server = (r.headers.get('server') || '').toLowerCase();
  return server === 'cloudflare' && r.body === null;
}

async function register(tag) {
  const r = await req('POST', '/api/auth/register', { body: { email: `smoke-${tag}-${Date.now()}@hooklab.test`, password: 'correct-horse-Battery-7' } });
  if (r.status !== 201) throw new Error('register failed ' + r.status);
  return r.body.accessToken;
}

async function newSub(token, wsId, tag, destinationUrl) {
  const r = await req('POST', `/api/workspaces/${wsId}/subscribers`, { token, body: { name: `sub-${tag}`, destinationUrl } });
  if (r.status !== 201) throw new Error('subscriber create failed ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body.data;
}

// Direct DB access for the one probe the API cannot produce: a malformed
// legacy credential row (the DTO gate rejects garbage, so only SQL can plant
// it). Container is hooklab's own compose Postgres — no other stack touched.
function psql(sql) {
  return execFileSync('docker', ['exec', process.env.PG_CONTAINER || "hooklab-postgres-1", 'psql', '-U', 'hooklab', '-d', 'hooklab', '-tAc', sql], { encoding: 'utf8' }).trim();
}

(async () => {
  const tag = String(Date.now()).slice(-7);
  const token = await register('main');
  const ws = await req('POST', '/api/workspaces', { token, body: { name: `ws-${tag}` } });
  const wsId = ws.body.data.id;

  console.log('\n== sub A: verified + rejected ingest, search, detail, replay ok ==');
  const subA = await newSub(token, wsId, 'A', 'https://example.com/hook');
  check('create returns secret/ingestToken/signatureHeader/endpointUrl', !!(subA.secret && subA.ingestToken && subA.signatureHeader && subA.endpointUrl), Object.keys(subA));

  const rid = crypto.randomUUID();
  const p1 = JSON.stringify({ type: 'order.shipped', orderId: `ord-${tag}` });
  let r = await req('POST', `/ingest/${subA.ingestToken}`, { raw: p1, headers: { [subA.signatureHeader]: sign(subA.secret, p1), 'x-request-id': rid } });
  check('ingest #1 200 verified', r.status === 200 && r.body.data.status === 'verified', r.status);
  const rec1 = r.body.data.recordId;

  const p2 = JSON.stringify({ type: 'payment.captured', amount: 10 });
  r = await req('POST', `/ingest/${subA.ingestToken}`, { raw: p2, headers: { [subA.signatureHeader]: sign(subA.secret, p2) } });
  check('ingest #2 200 verified', r.status === 200, r.status);

  r = await req('POST', `/ingest/${subA.ingestToken}`, { raw: p1, headers: { [subA.signatureHeader]: `sha256=${'ab'.repeat(32)}` } });
  check('bad sig 401 + details.reason=invalid_signature', r.status === 401 && r.body.error.details && r.body.error.details.reason === 'invalid_signature', r.body);

  r = await req('POST', `/ingest/${subA.ingestToken}`, { raw: p1 });
  check('missing sig 401 + details.reason=missing_signature', r.status === 401 && r.body.error.details && r.body.error.details.reason === 'missing_signature', r.body);

  r = await req('GET', `/api/subscribers/${subA.id}/stats`, { token });
  const sA = r.body.data;
  check('stats A: received 4 / verified 2 / rejected 2 / replays 0', sA.received === 4 && sA.verified === 2 && sA.rejected === 2 && sA.replays === 0, sA);

  r = await req('GET', `/api/subscribers/${subA.id}/records`, { token });
  check('list newest-first', r.status === 200 && Array.isArray(r.body.data) && r.body.data[0].id > r.body.data[r.body.data.length - 1].id, r.status);
  if (r.body.meta) check('list meta.hasMore boolean', typeof r.body.meta.hasMore === 'boolean', r.body.meta);

  r = await req('GET', `/api/subscribers/${subA.id}/records?q=order`, { token });
  check('q=order (eventType substring) -> 3 rows (2 rejected also carry eventType)', r.status === 200 && r.body.data.length === 3, r.body.data.map(x => x.eventType));

  r = await req('GET', `/api/subscribers/${subA.id}/records?q=${rid}`, { token });
  check('q=<x-request-id> (exact match) -> 1 row (x-request-id only on the verified one)', r.status === 200 && r.body.data.length === 1 && r.body.data[0].id === rec1, r.body.data.map(x => x.id));

  r = await req('GET', `/api/subscribers/${subA.id}/records?status=rejected`, { token });
  check('status=rejected -> 2 rows', r.status === 200 && r.body.data.length === 2 && r.body.data.every(x => x.status === 'rejected'), r.body.data.map(x => x.status));

  r = await req('GET', `/api/subscribers/${subA.id}/records?q=nomatchxyz`, { token });
  check('q=nomatch -> 0 rows (empty state source)', r.status === 200 && r.body.data.length === 0, r.body.data.length);

  r = await req('GET', `/api/workspaces/${wsId}/records?q=${subA.ingestToken.slice(0, 8)}`, { token });
  check('workspace token-prefix search -> >=4 rows from sub A', r.status === 200 && r.body.data.length >= 4, r.body.data.length);

  r = await req('GET', `/api/records/${rec1}`, { token });
  const det = r.body.data;
  check('detail: rawBody exact, headers captured (x-request-id), status verified', det.rawBody === p1 && det.headers['x-request-id'] === rid && det.status === 'verified', { raw: det.rawBody === p1, hr: det.headers && det.headers['x-request-id'], st: det.status });

  r = await req('POST', `/api/records/${rec1}/replay`, { token, body: { body: { type: 'order.shipped', orderId: `ord-${tag}` } } });
  const repOk = r.status === 200 && r.body.data.outcome === 'ok';
  check('replay to example.com -> 200 outcome ok', repOk, r.body);
  if (repOk) {
    check('  upstream status recorded', typeof r.body.data.response.status === 'number', r.body.data.response);
    const child = await req('GET', `/api/records/${r.body.data.replayRecordId}`, { token });
    check('  child row links replayOfId', child.status === 200 && child.body.data.replayOfId === rec1, child.body.data && { id: child.body.data.id, of: child.body.data.replayOfId });
  }
  r = await req('GET', `/api/subscribers/${subA.id}/stats`, { token });
  check('after replay: received still 4, replays 1', r.body.data.received === 4 && r.body.data.replays === 1, r.body.data);

  console.log('\n== sub B: replay timeout (dead IP) ==');
  const subB = await newSub(token, wsId, 'B', 'http://93.184.216.34/hook');
  const pb = JSON.stringify({ type: 'slow.ping' });
  r = await req('POST', `/ingest/${subB.ingestToken}`, { raw: pb, headers: { [subB.signatureHeader]: sign(subB.secret, pb) } });
  const recB = r.body.data.recordId;
  const t0 = Date.now();
  r = await req('POST', `/api/records/${recB}/replay`, { token, body: { body: { type: 'slow.ping' } } });
  const tookMs = Date.now() - t0;
  // Loopback/the tunnel pass the origin JSON through; the Cloudflare edge
  // substitutes a 5xx body with its own page, so a cf-substituted null body
  // still proves the 504 reached the browser. Guard the deref either way.
  const timeoutShape = r.body && r.body.error && r.body.error.code === 'replay_timeout' && typeof r.body.error.details.replayRecordId === 'number';
  const edgeOpaque = r.status === 504 && isEdgeSubstituted(r);
  check('timeout -> 504 replay_timeout + details.replayRecordId', r.status === 504 && (timeoutShape || edgeOpaque), { status: r.status, body: r.body });
  check(`  honored ~10s deadline (took ${Math.round(tookMs / 1000)}s)`, tookMs > 9000 && tookMs < 20000, tookMs);
  const stB = await req('GET', `/api/subscribers/${subB.id}/stats`, { token });
  check('timeout child counted in replays, received=1', stB.body.data.replays === 1 && stB.body.data.received === 1, stB.body.data);

  console.log('\n== sub C: SSRF block + revoke ==');
  const subC = await newSub(token, wsId, 'C', 'http://127.0.0.1:9999/x');
  const pc = JSON.stringify({ type: 'ssrf.probe' });
  r = await req('POST', `/ingest/${subC.ingestToken}`, { raw: pc, headers: { [subC.signatureHeader]: sign(subC.secret, pc) } });
  const recC = r.body.data.recordId;
  r = await req('POST', `/api/records/${recC}/replay`, { token, body: { body: { type: 'ssrf.probe' } } });
  check('replay loopback -> 400 replay_target_blocked + blockedIp', r.status === 400 && r.body.error.code === 'replay_target_blocked' && r.body.error.details.blockedIp === '127.0.0.1', r.body);
  const stC = await req('GET', `/api/subscribers/${subC.id}/stats`, { token });
  check('blocked replay wrote no child row', stC.body.data.replays === 0, stC.body.data);

  r = await req('POST', `/api/subscribers/${subC.id}/revoke`, { token });
  check('revoke 200 + revokedAt', r.status === 200 && r.body.data.revokedAt, r.status);
  const revBefore = (await req('GET', `/api/subscribers/${subC.id}/stats`, { token })).body.data.received;
  r = await req('POST', `/ingest/${subC.ingestToken}`, { raw: pc, headers: { [subC.signatureHeader]: sign(subC.secret, pc) } });
  check('ingest after revoke 410 subscriber_revoked', r.status === 410 && r.body.error.code === 'subscriber_revoked', r.status);
  const revAfter = (await req('GET', `/api/subscribers/${subC.id}/stats`, { token })).body.data.received;
  check('revoked ingest wrote NO record', revAfter === revBefore, { revBefore, revAfter });

  console.log('\n== sub D: rate limit boundary (60/min) ==');
  const subD = await newSub(token, wsId, 'D', 'https://example.com/hook');
  let ok = 0, limited = 0, first429At = -1, retryAfterSeen = null, rlCode = null;
  for (let i = 0; i < 65; i++) {
    const b = JSON.stringify({ type: 'burst', i });
    r = await req('POST', `/ingest/${subD.ingestToken}`, { raw: b, headers: { [subD.signatureHeader]: sign(subD.secret, b) } });
    if (r.status === 200) { ok++; if (first429At === -1 && false) {} }
    else if (r.status === 429) { limited++; if (first429At === -1) { first429At = i + 1; retryAfterSeen = r.retryAfter; rlCode = r.body.error.code; } }
  }
  check('exactly 60 ingested, rest 429', ok === 60 && limited === 5 && first429At === 61, { ok, limited, first429At });
  check('429 carries Retry-After + code rate_limited', retryAfterSeen !== null && rlCode === 'rate_limited', { retryAfterSeen, rlCode });
  const stD = await req('GET', `/api/subscribers/${subD.id}/stats`, { token });
  check('rate-limited rows stored rejected/rate_limited', stD.body.data.reasonBreakdown.rate_limited === 5, stD.body.data.reasonBreakdown);

  console.log('\n== sub E: 413 body too large ==');
  const subE = await newSub(token, wsId, 'E', 'https://example.com/hook');
  const big = 'a'.repeat(1100000);
  r = await req('POST', `/ingest/${subE.ingestToken}`, { raw: big, headers: { [subE.signatureHeader]: sign(subE.secret, big) } });
  check('1.1MB body -> 413 body_too_large', r.status === 413 && r.body.error.code === 'body_too_large', r.status);
  const stE = await req('GET', `/api/subscribers/${subE.id}/stats`, { token });
  check('413 row stored rejected/body_too_large', stE.body.data.reasonBreakdown.body_too_large === 1, stE.body.data.reasonBreakdown);

  console.log('\n== rotate (owner) ==');
  r = await req('POST', `/api/subscribers/${subA.id}/rotate`, { token });
  const rot = r.body.data;
  check('rotate 200 {secret, secretHint, rotatedAt, note}', r.status === 200 && rot.secret && rot.secretHint.startsWith('…') && rot.rotatedAt && rot.note, r.status);
  check('  secretHint = last 4 of secret', rot.secretHint === '…' + rot.secret.slice(-4), { hint: rot.secretHint, secret: rot.secret.slice(-4) });
  r = await req('POST', `/ingest/${subA.ingestToken}`, { raw: p1, headers: { [subA.signatureHeader]: sign(subA.secret, p1) } });
  check('old secret dies immediately (401)', r.status === 401, r.status);
  r = await req('POST', `/ingest/${subA.ingestToken}`, { raw: p1, headers: { [subA.signatureHeader]: sign(rot.secret, p1) } });
  check('new secret verifies (200)', r.status === 200, r.status);

  console.log('\n== destination auth (02 §4): masking, PATCH keep/clear, validation, wire headers ==');
  const subF = await newSub(token, wsId, 'auth', 'https://httpbin.org/post');

  // -- create with a bearer credential; the secret must never come back out
  r = await req('PATCH', `/api/subscribers/${subF.id}`, { token, body: { destinationAuth: { type: 'bearer', token: 'tok_secret_ABCD' } } });
  check('PATCH bearer -> 200', r.status === 200, r.status);
  r = await req('GET', `/api/subscribers/${subF.id}`, { token });
  const authF = r.body.data.destination.auth;
  check('read-back masked: tokenHint only, never the token', authF && authF.type === 'bearer' && authF.tokenHint === '…ABCD' && !JSON.stringify(r.body).includes('tok_secret_ABCD'), authF);

  // -- editing a different field with destinationAuth ABSENT must keep the credential
  r = await req('PATCH', `/api/subscribers/${subF.id}`, { token, body: { name: `sub-auth-${tag}-renamed` } });
  check('PATCH name only -> 200', r.status === 200, r.status);
  r = await req('GET', `/api/subscribers/${subF.id}`, { token });
  check('absent destinationAuth keeps stored credential', r.body.data.destination.auth.type === 'bearer' && r.body.data.destination.auth.tokenHint === '…ABCD', r.body.data.destination.auth);

  // -- explicit {type:none} clears it
  r = await req('PATCH', `/api/subscribers/${subF.id}`, { token, body: { destinationAuth: { type: 'none' } } });
  check('PATCH explicit none -> 200', r.status === 200, r.status);
  r = await req('GET', `/api/subscribers/${subF.id}`, { token });
  check('credential cleared: auth.type === none', r.body.data.destination.auth.type === 'none', r.body.data.destination.auth);

  // -- an authenticated replay: httpbin echoes what it received
  r = await req('PATCH', `/api/subscribers/${subF.id}`, { token, body: { destinationAuth: { type: 'bearer', token: 'tok_live_9999' } } });
  check('PATCH bearer (live token) -> 200', r.status === 200, r.status);
  const pAuth = JSON.stringify({ type: 'auth.probe' });
  r = await req('POST', `/ingest/${subF.ingestToken}`, { raw: pAuth, headers: { [subF.signatureHeader]: sign(subF.secret, pAuth) } });
  const recAuth = r.body?.data?.recordId;
  check('ingest auth.probe verified', r.status === 200 && !!recAuth, r.status);
  r = await req('POST', `/api/records/${recAuth}/replay`, { token, body: { body: { type: 'auth.probe' } } });
  const repAuth = r.body?.data;
  check('replay -> httpbin 200 outcome ok', r.status === 200 && repAuth && repAuth.outcome === 'ok', r.body);
  if (repAuth && repAuth.response) {
    let echoed = null;
    try { echoed = JSON.parse(repAuth.response.body ?? 'null'); } catch {}
    // httpbin echoes the headers it received — the echoed KEY proves the
    // credential rode the request. The VALUE must read [redacted]: the emitted
    // credential is scrubbed out of the upstream body before it is stored or
    // returned (02 §4 "never serialized"), so the exact emitted string is
    // precisely what got replaced.
    const echoedAuth = echoed && echoed.headers
      ? Object.entries(echoed.headers).find(([k]) => k.toLowerCase() === 'authorization')
      : undefined;
    check('  Authorization sent (echoed key present), value scrubbed to [redacted]', echoedAuth && echoedAuth[1] === '[redacted]', echoed && echoed.headers);
    check('  no credential material in the returned body', !JSON.stringify(repAuth.response.body).includes('tok_live_9999'), repAuth.response.body);
  }
  r = await req('GET', `/api/records/${repAuth ? repAuth.replayRecordId : 0}`, { token });
  check('  replay child row links back + recorded upstream 200', r.status === 200 && r.body.data.replayOfId === recAuth && r.body.data.replayResponseStatus === 200, r.body.data);

  // -- validation gates (mirror of subscribers.constraints.ts)
  const badAuthBodies = [
    { type: 'basic', username: 'u' }, // half pair
    { type: 'apiKey', headerName: 'bad header', value: 'v' }, // structural header name
    { type: 'bearer', token: 'bad\tcrlf' }, // control character
    { type: 'bearer', token: 'x'.repeat(8000) }, // over 4096
    { type: 'bearer', token: 'tok-日本語' }, // above Latin-1: fetch cannot convert to a ByteString
    { type: 'none', token: 'extra' }, // 'none' must have no credential keys
  ];
  for (let i = 0; i < badAuthBodies.length; i++) {
    r = await req('PATCH', `/api/subscribers/${subF.id}`, { token, body: { destinationAuth: badAuthBodies[i] } });
    check(`reject destinationAuth[${i}] ${JSON.stringify(badAuthBodies[i]).slice(0, 40)} -> 400`, r.status === 400 && r.body.error.code === 'validation_error', { status: r.status, body: r.body });
  }

  // -- THE padded-credential case on the live wire: WHATWG fetch trims
  //    leading/trailing SP/HTAB before sending, so a padded credential used to
  //    reach httpbin in its trimmed spelling while redaction searched for the
  //    padded one — the echo carried the plaintext into the stored row. The
  //    emission now normalizes to the wire spelling up front, so the scrub
  //    still lands. (Trailing space is the leaking bearer variant.)
  r = await req('PATCH', `/api/subscribers/${subF.id}`, { token, body: { destinationAuth: { type: 'bearer', token: 'tok_pad_7777 ' } } });
  check('PATCH bearer w/ trailing space -> 200', r.status === 200, r.status);
  const pPad = JSON.stringify({ type: 'auth.pad' });
  r = await req('POST', `/ingest/${subF.ingestToken}`, { raw: pPad, headers: { [subF.signatureHeader]: sign(subF.secret, pPad) } });
  const recPad = r.body?.data?.recordId;
  r = await req('POST', `/api/records/${recPad}/replay`, { token, body: { body: { type: 'auth.pad' } } });
  const repPad = r.body?.data;
  check('replay (padded bearer) -> httpbin 200', r.status === 200 && repPad && repPad.outcome === 'ok', r.body);
  if (repPad && repPad.response) {
    let echoed = null;
    try { echoed = JSON.parse(repPad.response.body ?? 'null'); } catch {}
    const echoedAuth = echoed && echoed.headers
      ? Object.entries(echoed.headers).find(([k]) => k.toLowerCase() === 'authorization')
      : undefined;
    check('  padded credential still scrubbed to [redacted]', echoedAuth && echoedAuth[1] === '[redacted]', echoed && echoed.headers);
    check('  no credential material (padded or trimmed) in body', !JSON.stringify(repPad.response.body).includes('tok_pad_7777'), repPad.response.body);
  }
  r = await req('GET', `/api/records/${repPad ? repPad.replayRecordId : 0}`, { token });
  check('  stored echo row holds no credential material', r.status === 200 && !JSON.stringify(r.body).includes('tok_pad_7777'), r.body.data && r.body.data.response && r.body.data.response.body);

  // -- destinationHeaders values fetch cannot carry are a write-time 400, not
  //    a mislabeled 502 at replay (control byte / above Latin-1).
  const badHeaderMaps = [
    { 'X-Ok': 'a\u0001b' }, // C0 control other than HTAB
    { 'X-Ok': 'vĀ' }, // above Latin-1 (ByteString conversion throws)
  ];
  for (let i = 0; i < badHeaderMaps.length; i++) {
    r = await req('PATCH', `/api/subscribers/${subF.id}`, { token, body: { destinationHeaders: badHeaderMaps[i] } });
    check(`reject destinationHeaders[${i}] unrenderable value -> 400`, r.status === 400 && r.body.error.code === 'validation_error', { status: r.status, body: r.body });
  }
  // Interior HTAB stays legal (survives the wire untouched).
  r = await req('PATCH', `/api/subscribers/${subF.id}`, { token, body: { destinationHeaders: { 'X-Tab': 'a\tb' } } });
  check('accept destinationHeaders interior HTAB -> 200', r.status === 200, r.status);

  console.log('\n== sub F hardening: apiKey merge, create-echo masking, null-keep, garbage degrade, wire collision ==');
  const subG = await newSub(token, wsId, 'auth2', 'https://httpbin.org/post');

  // -- key ordering: credential set BEFORE a header of a different name; the
  //    credential must still ride along (regression guard for merge order).
  r = await req('PATCH', `/api/subscribers/${subG.id}`, {
    token,
    body: {
      destinationHeaders: { 'X-Trace': 'trace-1' },
      destinationAuth: { type: 'apiKey', headerName: 'X-Api-Key', value: 'key_live_1234' },
    },
  });
  check('PATCH apiKey + unrelated header -> 200', r.status === 200, r.status);
  const pG = JSON.stringify({ type: 'auth2.probe' });
  r = await req('POST', `/ingest/${subG.ingestToken}`, { raw: pG, headers: { [subG.signatureHeader]: sign(subG.secret, pG) } });
  const recG = r.body?.data?.recordId;
  r = await req('POST', `/api/records/${recG}/replay`, { token, body: { body: { type: 'auth2.probe' } } });
  const repG = r.body?.data;
  check('replay (apiKey) -> httpbin 200', r.status === 200 && repG && repG.outcome === 'ok', r.body);
  if (repG && repG.response) {
    let echoed = null;
    try { echoed = JSON.parse(repG.response.body ?? 'null'); } catch {}
    const find = (name) => echoed && echoed.headers
      ? Object.entries(echoed.headers).find(([k]) => k.toLowerCase() === name)
      : undefined;
    const keyHeader = find('x-api-key');
    const traceHeader = find('x-trace');
    // Key presence proves the credential rode the request; the value reads
    // [redacted] because the emitted value is scrubbed from the upstream body.
    check('  X-Api-Key sent once, value scrubbed to [redacted]', keyHeader && keyHeader[1] === '[redacted]', echoed && echoed.headers);
    check('  X-Trace passthrough header also present unredacted', traceHeader && traceHeader[1] === 'trace-1', echoed && echoed.headers);
  }

  // -- explicit JSON null on PATCH must KEEP the stored credential (02 §4)
  r = await req('PATCH', `/api/subscribers/${subG.id}`, { token, body: { destinationAuth: null } });
  check('PATCH destinationAuth: null -> 200', r.status === 200, r.status);
  r = await req('GET', `/api/subscribers/${subG.id}`, { token });
  check('explicit null keeps credential (apiKey …1234)', r.body.data.destination.auth.type === 'apiKey' && r.body.data.destination.auth.valueHint === '…1234', r.body.data.destination.auth);

  // -- create echoes the wire marker, never the secret value
  r = await req('POST', `/api/workspaces/${wsId}/subscribers`, {
    token,
    body: { name: `sub-create-echo-${tag}`, destinationUrl: 'https://example.com/hook', destinationAuth: { type: 'bearer', token: 'tok_create_zzzz' } },
  });
  const created = r.body?.data;
  check('create with bearer -> 201', r.status === 201, r.status);
  check('  create response auth masked (…zzzz), secret absent', created && created.destination.auth.type === 'bearer' && created.destination.auth.tokenHint === '…zzzz' && !JSON.stringify(r.body).includes('tok_create_zzzz'), created && created.destination.auth);

  // -- a malformed legacy row (planted via SQL: the DTO gate rejects garbage)
  //    degrades to no-credential on read, and a credential-less replay still
  //    succeeds — no crash, no header, no leak.
  const subH = await newSub(token, wsId, 'garbage', 'https://httpbin.org/post');
  psql(`UPDATE "Subscriber" SET "destinationAuth" = '"garbage-string"'::jsonb WHERE id = ${subH.id}`);
  r = await req('GET', `/api/subscribers/${subH.id}`, { token });
  check('SQL-planted string garbage -> auth.type none on read', r.status === 200 && r.body.data.destination.auth.type === 'none', r.body?.data?.destination?.auth);
  const pH = JSON.stringify({ type: 'garbage.probe' });
  r = await req('POST', `/ingest/${subH.ingestToken}`, { raw: pH, headers: { [subH.signatureHeader]: sign(subH.secret, pH) } });
  const recH = r.body?.data?.recordId;
  r = await req('POST', `/api/records/${recH}/replay`, { token, body: { body: { type: 'garbage.probe' } } });
  const repH = r.body?.data;
  check('replay with garbage credential -> still 200 ok (degraded, no crash)', r.status === 200 && repH && repH.outcome === 'ok', r.body);
  if (repH && repH.response) {
    let echoed = null;
    try { echoed = JSON.parse(repH.response.body ?? 'null'); } catch {}
    const authHeader = echoed && echoed.headers
      ? Object.entries(echoed.headers).find(([k]) => k.toLowerCase() === 'authorization')
      : undefined;
    check('  no Authorization header sent for degraded credential', authHeader === undefined, echoed && echoed.headers);
  }

  // -- THE case-variant collision on the live wire: destinationHeaders carries
  //    'Authorization' spelling while the bearer credential emits 'authorization'.
  //    The fold must leave exactly ONE field on the wire carrying the fresh value.
  const subI = await newSub(token, wsId, 'collide', 'https://httpbin.org/post');
  r = await req('PATCH', `/api/subscribers/${subI.id}`, {
    token,
    body: {
      destinationHeaders: { Authorization: 'Bearer stale-token' },
      destinationAuth: { type: 'bearer', token: 'fresh-token' },
    },
  });
  check('PATCH case-variant collision setup -> 200', r.status === 200, r.status);
  const pI = JSON.stringify({ type: 'collide.probe' });
  r = await req('POST', `/ingest/${subI.ingestToken}`, { raw: pI, headers: { [subI.signatureHeader]: sign(subI.secret, pI) } });
  const recI = r.body?.data?.recordId;
  r = await req('POST', `/api/records/${recI}/replay`, { token, body: { body: { type: 'collide.probe' } } });
  const repI = r.body?.data;
  check('replay (collision) -> httpbin 200', r.status === 200 && repI && repI.outcome === 'ok', r.body);
  if (repI && repI.response) {
    let echoed = null;
    try { echoed = JSON.parse(repI.response.body ?? 'null'); } catch {}
    const authEntries = echoed && echoed.headers
      ? Object.entries(echoed.headers).filter(([k]) => k.toLowerCase() === 'authorization')
      : [];
    check('  exactly ONE authorization field on the wire (no comma-join)', authEntries.length === 1, echoed && echoed.headers);
    // Exactly one field, and its value is the redaction marker — the single
    // outbound value this leg sent was 'Bearer fresh-token' (the stale
    // destinationHeaders entry lost the case-insensitive fold), so a lone
    // [redacted] proves both the dedup and the scrub.
    check('  the single field was the fresh credential (now scrubbed)', authEntries.length === 1 && authEntries[0][1] === '[redacted]', authEntries);
    check('  stale token never reached the wire', !JSON.stringify(repI.response.body).includes('stale-token'), repI.response.body);
  }

  console.log('\n== sub G: workspace subscriber list masks auth ==');
  r = await req('GET', `/api/workspaces/${wsId}/subscribers`, { token });
  const listed = Array.isArray(r.body?.data) ? r.body.data.find((s) => s.id === subF.id) : undefined;
  check('workspace list includes sub F with auth', r.status === 200 && !!listed, r.status);
  check('  list serializes auth masked, never the raw token', listed && listed.destination.auth.type === 'bearer' && /^…/.test(listed.destination.auth.tokenHint) && !JSON.stringify(r.body).includes('tok_pad_7777') && !JSON.stringify(r.body).includes('tok_live_9999'), listed && listed.destination.auth);

  console.log('\n== sub H: record detail omits the outbound credential entirely ==');
  r = await req('GET', `/api/records/${recAuth}`, { token });
  const detH = r.body?.data;
  check('record detail 200 + destination carries no auth key', r.status === 200 && detH.destination && !('auth' in detH.destination), detH && detH.destination);
  // Two-sided check: no credential material AND the marker is present in the
  // replay child's stored response body — proving the scrub ran rather than the
  // echo body simply being absent (02 §4 "never serialized").
  const childH = r.status === 200 && Array.isArray(detH.replays)
    ? detH.replays.find((c) => c.id === repAuth.replayRecordId)
    : undefined;
  check('  replay child stored body carries [redacted], not the token',
    !!childH && JSON.stringify(childH.response.body).includes('[redacted]') && !JSON.stringify(r.body).includes('tok_live_9999'),
    childH && childH.response.body);

  console.log('\n== IDOR: non-member gets 404, never 403/data ==');
  const token2 = await register('intruder');
  const paths = [
    ['GET', `/api/subscribers/${subA.id}`, undefined],
    ['GET', `/api/subscribers/${subA.id}/records`, undefined],
    ['GET', `/api/subscribers/${subA.id}/stats`, undefined],
    ['PATCH', `/api/subscribers/${subA.id}`, { name: 'pwned' }],
    ['POST', `/api/subscribers/${subA.id}/rotate`, undefined],
    ['POST', `/api/subscribers/${subA.id}/revoke`, undefined],
    ['DELETE', `/api/subscribers/${subA.id}`, undefined],
    ['GET', `/api/records/${rec1}`, undefined],
    ['POST', `/api/records/${rec1}/replay`, { body: { hack: 1 } }],
    ['GET', `/api/workspaces/${wsId}/records`, undefined],
    ['GET', `/api/workspaces/${wsId}/subscribers`, undefined],
    ['DELETE', `/api/workspaces/${wsId}`, undefined],
  ];
  for (const [m, p, b] of paths) {
    r = await req(m, p, { token: token2, body: b });
    check(`intruder ${m} ${p} -> 404`, r.status === 404, r.status);
  }
  r = await req('GET', `/api/subscribers/${subA.id}`, { token: token2 });
  check('no existence leak in body', r.status === 404 && r.body.error.code === 'not_found' && !JSON.stringify(r.body).includes(`sub-A`), { status: r.status, body: r.body });

  console.log('\n== cleanup & cascade ==');
  r = await req('DELETE', `/api/workspaces/${wsId}`, { token });
  check('owner deletes workspace -> 204', r.status === 204, r.status);
  r = await req('GET', `/api/subscribers/${subA.id}`, { token });
  check('cascade: subscriber gone -> 404', r.status === 404, r.status);
  r = await req('GET', `/api/records/${rec1}`, { token });
  check('cascade: records gone -> 404', r.status === 404, r.status);
  r = await req('GET', '/api/workspaces', { token });
  check('workspace list no longer contains it', r.status === 200 && !r.body.data.some(w => w.id === wsId), r.body.data);

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  if (failures.length) console.log('failed:', failures.join(' | '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH', e); process.exit(1); });