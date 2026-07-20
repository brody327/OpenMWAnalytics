// Backfill local Postgres events into a remote API (local dev DB -> RDS via the cloud API).
//
// WHY THIS IS SAFE TO RE-RUN: the ingest endpoint upserts with
// ON CONFLICT (session_id, seq) DO NOTHING, so re-sending an event is a no-op that reports
// itself as a duplicate. At-least-once delivery is the design (design docs 02 / 04) — this
// script leans on it rather than tracking its own state.
//
// WHY IT GOES THROUGH THE API rather than writing to RDS directly: the API owns validation,
// the epoch-ms -> timestamptz boundary conversion, and the idempotent upsert. Writing
// straight to the database would bypass the contract every other producer honours, and RDS
// is VPC-private anyway.
//
// DEFAULTS TO A DRY RUN. It only writes when you pass --run.
//
//   cd api
//   node scripts/backfill.mjs                 # preview: what would be sent
//   OMWA_API=https://api.omwanalytics.com/events \
//   OMWA_INGEST_TOKEN=<token> node scripts/backfill.mjs --run
//
// Env:
//   DATABASE_URL        source (local) Postgres — read from api/.env by default
//   OMWA_API            destination ingest URL (default: http://localhost:4000/events)
//   OMWA_INGEST_TOKEN   bearer token the destination requires

import 'dotenv/config';
import pg from 'pg';

const SOURCE = process.env.DATABASE_URL;
const API = process.env.OMWA_API ?? 'http://localhost:4000/events';
const TOKEN = process.env.OMWA_INGEST_TOKEN ?? '';
const RUN = process.argv.includes('--run');
const BATCH = 200;

// Retired placeholders (design docs 03). They answer no product question, and a 5s
// Heartbeat actively corrupts sequence analysis — LEAD() over the event stream would
// report "players respond to failure by idling". Copying ~1000 of them into the
// production database would import that problem, so they are dropped at the source.
const EXCLUDED = ['Heartbeat', 'SpikeStarted'];

if (!SOURCE) {
  console.error('[backfill] DATABASE_URL is not set (expected in api/.env)');
  process.exit(1);
}
if (RUN && !TOKEN) {
  console.error('[backfill] --run requires OMWA_INGEST_TOKEN (the destination will 401)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: SOURCE });
await client.connect();

const { rows } = await client.query(
  `select session_id, seq, install_id, type, v, ts, data
     from events
    where type <> all($1::text[])
    order by ts asc, session_id, seq`,
  [EXCLUDED],
);
await client.end();

// Wire shape: snake_case keys, ts back to epoch MILLISECONDS. The API converts at its own
// boundary, so this must hand back exactly what a shipper would have sent originally.
const events = rows.map((r) => ({
  v: r.v,
  type: r.type,
  seq: r.seq,
  install_id: r.install_id,
  session_id: r.session_id,
  ts: new Date(r.ts).getTime(),
  data: r.data ?? {},
}));

const byType = events.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
const sessions = new Set(events.map((e) => e.session_id)).size;

console.log(`[backfill] source   : ${SOURCE.replace(/(:)[^:@]+(@)/, '$1****$2')}`);
console.log(`[backfill] dest     : ${API}`);
console.log(`[backfill] excluded : ${EXCLUDED.join(', ')}`);
console.log(`[backfill] ${events.length} events across ${sessions} sessions`);
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`             ${String(n).padStart(5)}  ${t}`);
}

if (!events.length) {
  console.log('[backfill] nothing to send');
  process.exit(0);
}
if (!RUN) {
  console.log('\n[backfill] DRY RUN — no data sent. Re-run with --run to execute.');
  process.exit(0);
}

let sent = 0;
let inserted = 0;
let duplicates = 0;

for (let i = 0; i < events.length; i += BATCH) {
  const batch = events.slice(i, i + BATCH);
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
    },
    body: JSON.stringify(batch),
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Stop rather than plough on: a 401/503 means every later batch fails the same way,
    // and a 400 means the payload contract is wrong. Already-sent batches stay committed,
    // and re-running is a no-op for them, so stopping loses nothing.
    console.error(`[backfill] HTTP ${res.status} on batch at offset ${i}:`, body);
    console.error(`[backfill] stopped. ${inserted} inserted so far; safe to re-run.`);
    process.exit(1);
  }

  sent += batch.length;
  inserted += body.inserted ?? 0;
  duplicates += body.duplicates ?? 0;
  console.log(`[backfill] batch ${i / BATCH + 1}: sent ${batch.length} -> ${JSON.stringify(body)}`);
}

console.log(`\n[backfill] done. sent=${sent} inserted=${inserted} duplicates=${duplicates}`);
if (duplicates && !inserted) {
  console.log('[backfill] all duplicates — the destination already had this data.');
}
