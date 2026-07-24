import type { Request, Response } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';

// GET /events — the raw event feed behind the explorer (design docs 07).
//
// This is the OTHER read shape. /stats/* answers "is this mod played as designed" from
// precomputed aggregates; this answers "what exactly happened", row by row. It deliberately
// does NOT touch the rollups -- a rollup can only be filtered by dimensions in its grain,
// whereas the explorer must filter on anything, including arbitrary payload keys. Different
// question, different data path, different rules.
//
// Two decisions justify it (doc 10 rule 1 -- a view earns its place by naming a decision):
//   1. instrumentation debugging -- "did my new event fire, with what payload?", today done by
//      grepping openmw.log and hand-writing psql;
//   2. drill-down -- "12 sessions abandoned this topic, show me one".

// KEYSET (a.k.a. SEEK) PAGINATION, not OFFSET.
//
// Measured on 1M rows, both plans using events_feed_idx:
//   keyset            ->      50 rows, ~0.14 ms
//   LIMIT 50 OFFSET 500000 -> 500,050 rows, ~218 ms  (~1,500x, and linear in the offset)
// A B-tree cannot seek to the Nth entry -- it has no rank statistic -- so OFFSET must read and
// discard every row it skips.
//
// The CORRECTNESS argument matters more than the speed one. `events` is append-only and this
// feed is newest-first, so rows arrive at the TOP. OFFSET is anchored to a COUNT, and between
// two page fetches that count means something different: page 2 re-shows rows already seen
// (and can skip others). A cursor is anchored to a POSITION -- "strictly before this exact
// (ts, session_id, seq)" -- which new rows at the top cannot move.
//
// The cursor is that tuple, base64'd. It is opaque to the client BY DESIGN: encoding it stops
// callers from hand-crafting or arithmetic-ing cursors, which would couple them to the sort key
// and make it unchangeable later.
type Cursor = { ts: number; sessionId: string; seq: number };

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}|${c.sessionId}|${c.seq}`).toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const [ts, sessionId, seq] = Buffer.from(raw, 'base64url').toString().split('|');
    const parsed = { ts: Number(ts), sessionId: String(sessionId), seq: Number(seq) };
    // A malformed cursor is a CLIENT error, not a server one -- but returning page 1 instead
    // would silently restart an infinite scroll from the top, which reads as duplicated data.
    // Better to reject loudly; see the 400 below.
    if (!Number.isFinite(parsed.ts) || !Number.isFinite(parsed.seq) || !parsed.sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// Only these payload keys are filterable, and each is a real column (a stored generated column
// on events). An allow-list rather than arbitrary `data->>?` filtering: an unindexed JSONB
// predicate over 1M rows is a seq scan per request, and letting callers choose the predicate
// makes the endpoint's cost unbounded and unpredictable. Promote a key to a column when it
// earns it -- the same rule that made these four columns exist (doc 06).
const PAYLOAD_FILTERS = new Set(['suspect', 'topic', 'reason']);

function one(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : undefined;
}

export async function listEvents(req: Request, res: Response): Promise<void> {
  const q = req.query;

  const rawLimit = Number(one(q.limit) ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const rawCursor = one(q.cursor);
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) {
    res.status(400).json({ error: 'invalid cursor' });
    return;
  }

  // Every filter is an equality or a range on an indexed column, and each is optional. Built as
  // a list of SQL fragments so absent filters contribute nothing at all -- not `WHERE true AND
  // (x IS NULL OR ...)`, which would defeat index selection.
  const where: SQL[] = [];
  const modId = one(q.mod_id);
  const type = one(q.type);
  const env = one(q.env);
  const sessionId = one(q.session_id);
  const from = one(q.from);
  const to = one(q.to);

  if (modId) where.push(sql`mod_id = ${modId}`);
  if (type) where.push(sql`type = ${type}`);
  if (env) where.push(sql`env = ${env}`);
  if (sessionId) where.push(sql`session_id = ${sessionId}::uuid`);
  // from/to are epoch ms, matching the wire contract's `ts` (design docs 02 §3). Event time,
  // not received_at: the explorer answers "what happened when", not "what did we ingest when".
  if (from && Number.isFinite(Number(from))) {
    where.push(sql`ts >= to_timestamp(${Number(from)} / 1000.0)`);
  }
  if (to && Number.isFinite(Number(to))) {
    where.push(sql`ts <= to_timestamp(${Number(to)} / 1000.0)`);
  }
  for (const key of PAYLOAD_FILTERS) {
    const value = one(q[key]);
    if (value) where.push(sql.raw(`${key} = `).append(sql`${value}`));
  }

  // ROW-WISE comparison, not `ts < x OR (ts = x AND ...)`. Postgres compares the tuple
  // lexicographically and can drive events_feed_idx directly from it; the expanded OR form
  // usually cannot, and is easy to get subtly wrong at the boundaries.
  if (cursor) {
    where.push(
      sql`(ts, session_id, seq) < (to_timestamp(${cursor.ts} / 1000.0), ${cursor.sessionId}::uuid, ${cursor.seq})`,
    );
  }

  const whereSql = where.length
    ? sql.join([sql`where `, sql.join(where, sql` and `)])
    : sql``;

  // Fetch one MORE than asked. If it comes back, there is another page -- which avoids a
  // COUNT(*) over the filtered set entirely. An exact total is the expensive part of pagination
  // (it must visit every matching row), and an infinite-scroll feed does not need one.
  const rows = await db.execute(sql`
    select
      session_id, seq, install_id, type, v, mod_id, env,
      (extract(epoch from ts) * 1000)::bigint          as ts,
      (extract(epoch from received_at) * 1000)::bigint as received_at,
      data
    from events
    ${whereSql}
    -- QUALIFIED (events.ts), and it must stay that way. ORDER BY resolves a BARE name against
    -- the SELECT's output aliases FIRST, and this query aliases the epoch-ms expression as ts
    -- -- so a bare "order by ts" sorts by (extract(epoch from ts)*1000)::bigint, which no index
    -- covers. That silently replaced the index scan with a parallel seq scan + top-N sort:
    -- ~0.14 ms -> ~280 ms per page, with completely CORRECT results. WHERE never sees output
    -- aliases, so the cursor predicate was unaffected -- which is exactly why only a
    -- measurement caught it.
    order by events.ts desc, events.session_id desc, events.seq desc
    limit ${limit + 1}
  `);

  const page = rows.rows.slice(0, limit);
  const hasMore = rows.rows.length > limit;
  const last = page[page.length - 1] as { ts: string; session_id: string; seq: number } | undefined;

  res.json({
    events: page,
    // Null means "end of feed" -- an explicit terminator, so the client never has to infer
    // exhaustion from a short page (which is wrong the moment a page happens to land exactly
    // on the boundary).
    nextCursor:
      hasMore && last
        ? encodeCursor({ ts: Number(last.ts), sessionId: last.session_id, seq: last.seq })
        : null,
    limit,
  });
}

// GET /mods — the registry, with a live event count. Powers the mod switcher and /mods/[modId].
//
// The count is computed here rather than denormalised onto `mods`: it is a handful of rows over
// an indexed group-by, and a stored counter would need maintaining on every ingest for a number
// nobody reads on the hot path.
export async function listMods(_req: Request, res: Response): Promise<void> {
  const rows = await db.execute(sql`
    select
      m.mod_id,
      m.display_name,
      (extract(epoch from m.first_seen_at) * 1000)::bigint as first_seen_at,
      (extract(epoch from m.last_seen_at)  * 1000)::bigint as last_seen_at,
      coalesce(e.events, 0)::int                           as events,
      coalesce(e.sessions, 0)::int                         as sessions
    from mods m
    left join (
      select mod_id, count(*) as events, count(distinct session_id) as sessions
      from events group by mod_id
    ) e using (mod_id)
    order by events desc, m.mod_id
  `);
  res.json({ mods: rows.rows });
}
