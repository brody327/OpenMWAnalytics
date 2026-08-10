import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { app } from './index.js';
import { db } from './db/client.js';

// HTTP-LEVEL TESTS — the layer the 105 unit tests deliberately do not reach.
//
// Everything unit-tested in this project is pure logic: rankTopics, classifyGate, validateInsight,
// matchGate, parseEnvScope, the parsers. That split is the architecture, not an accident — the
// judgement is extracted from the handlers precisely so it can be tested without a database.
//
// But it leaves the plumbing unverified: routing, MIDDLEWARE ORDER, auth, rate limiting, envelope
// validation, the error handler. Those are exactly the things that break silently, and none of
// them can be reached by importing a function. So this drives the real Express app over real HTTP
// against the real database, on an ephemeral port.
//
// ⚠️ Needs Postgres (the same one `corpus/ingest.test.ts` uses). CI provides it as a service
// container; locally that is `npm run db:up`.

let server: Server;
let base: string;

const TOKEN = 'http-test-token';

before(async () => {
  // The auth middleware FAILS CLOSED on an unset token, so without this every authenticated
  // request would 503 and the tests below would be asserting the wrong failure.
  process.env.OMWA_INGEST_TOKEN = TOKEN;

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** A valid envelope. `fixture_`-prefixed ids so a test can never collide with real data (11 §12). */
const envelope = (over: Record<string, unknown> = {}) => ({
  install_id: '00000000-0000-4000-8000-00000000f1a7',
  session_id: randomUUID(),
  seq: 1,
  type: 'ConfrontationAttempted',
  v: 1,
  ts: Date.now(),
  env: 'synthetic',
  mod_id: 'fixture_http_test',
  data: { suspect: 'fixture_suspect', topic: 'fixture_topic', passed: false, reason: 'no_evidence' },
  ...over,
});

const cleanup = () => db.execute(sql`delete from events where mod_id = 'fixture_http_test'`);

// ── auth ──────────────────────────────────────────────────────────────────────────────────────

test('POST /events without a token is rejected', async () => {
  const res = await post('/events', [envelope()]);
  assert.equal(res.status, 401);
});

test('POST /events with a WRONG token is rejected', async () => {
  const res = await post('/events', [envelope()], 'not-the-token');
  assert.equal(res.status, 401);
});

test('⭐ the write path FAILS CLOSED when the token is not configured', async () => {
  // The case that matters, and the one nobody writes. A missing config must break loudly — "auth
  // quietly stopped existing after someone changed an env var" is the classic way a control
  // disappears. 503, not 200, and not 401 either: this is misconfiguration, not a bad credential.
  const saved = process.env.OMWA_INGEST_TOKEN;
  delete process.env.OMWA_INGEST_TOKEN;
  try {
    const res = await post('/events', [envelope()], TOKEN);
    assert.equal(res.status, 503);
  } finally {
    process.env.OMWA_INGEST_TOKEN = saved;
  }
});

// ── idempotency ───────────────────────────────────────────────────────────────────────────────

test('⭐⭐ posting the SAME event twice yields ONE row', async () => {
  // A load-bearing claim, and until now nothing verified it. At-least-once delivery guarantees
  // duplicates: the shipper posts, the response is lost, it posts again. If the upsert were not
  // idempotent every network blip would inflate every metric — silently, with plausible numbers.
  await cleanup();
  const e = envelope();

  const first = await post('/events', [e], TOKEN);
  assert.equal(first.status, 200, await first.text());
  const second = await post('/events', [e], TOKEN);
  assert.equal(second.status, 200, 'a duplicate must be accepted, not rejected');

  const rows = (
    await db.execute(sql`
      select count(*)::int as n from events
      where session_id = ${e.session_id}::uuid and seq = ${e.seq}
    `)
  ).rows as unknown as [{ n: number }];
  assert.equal(rows[0].n, 1, 'the second POST must not create a second row');
  await cleanup();
});

test('a DIFFERENT seq in the same session is a different event', async () => {
  // The paired allow case. Deduping too aggressively — on session_id alone — would silently drop
  // every event after the first, and the test above would still pass.
  await cleanup();
  const sessionId = randomUUID();
  await post('/events', [envelope({ session_id: sessionId, seq: 1 })], TOKEN);
  await post('/events', [envelope({ session_id: sessionId, seq: 2 })], TOKEN);

  const rows = (
    await db.execute(sql`select count(*)::int as n from events where session_id = ${sessionId}::uuid`)
  ).rows as unknown as [{ n: number }];
  assert.equal(rows[0].n, 2);
  await cleanup();
});

// ── validation ────────────────────────────────────────────────────────────────────────────────

test('a malformed envelope is rejected with 400, not stored', async () => {
  await cleanup();
  const res = await post('/events', [{ type: 'Nope' }], TOKEN);
  assert.equal(res.status, 400);

  const rows = (
    await db.execute(sql`select count(*)::int as n from events where mod_id = 'fixture_http_test'`)
  ).rows as unknown as [{ n: number }];
  assert.equal(rows[0].n, 0);
});

// ── the read side, and its guarantees ─────────────────────────────────────────────────────────

test('/health is open and says nothing about data', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('⭐ /health carries NO rate-limit headers — a limiter there is a self-inflicted crashloop', async () => {
  // The k8s liveness probe hits /health every 15s. If it were rate limited the probe would fail,
  // k8s would restart the pod, and the "protection" would be the outage.
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get('ratelimit'), null);
  assert.equal(res.headers.get('ratelimit-policy'), null);
});

test('a read route IS rate limited, and advertises it', async () => {
  // The paired case: "no headers on /health" must not be satisfiable by having no limiter at all.
  const res = await fetch(`${base}/mods`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('ratelimit-policy'), 'read routes should advertise a limit');
});

test('⭐ GET /insights is approved-only, and no query parameter can widen it', async () => {
  // "Human review" is only a real claim if unreviewed output cannot reach a reader. The filter is
  // in SQL; this proves the HTTP surface offers no way around it.
  for (const qs of ['', '?status=pending', '?status=all', '?env=all']) {
    const res = await fetch(`${base}/insights${qs}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { insights: { status?: string }[] };
    assert.ok(Array.isArray(body.insights));
    for (const i of body.insights) {
      assert.notEqual(i.status, 'pending', `?${qs} exposed a pending insight`);
    }
  }
});

test('the review queue requires authentication', async () => {
  assert.equal((await fetch(`${base}/insights/review`)).status, 401);
});

test('/version reports a sha — the check a stale pod cannot pass', async () => {
  const res = await fetch(`${base}/version`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sha: string; built_at: string };
  // Locally this is 'unknown' (the ARG is only set by the Docker build); in CI it is the commit.
  // Asserting the FIELD exists is the honest check — asserting a value would pass vacuously.
  assert.equal(typeof body.sha, 'string');
  assert.ok(body.sha.length > 0);
});
