import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// GET /stats/confrontations
//
// The analytics read side for the ConfrontationAttempted event (design docs 03 / 07):
// "where do players get stuck in confrontations?" Everything is aggregated in SQL and
// only rates + counts cross the wire -- the client never receives raw event rows. This
// is the line between an event *store* and an analytics *API*.
//
// Two GROUP BYs over the (type, ts) index:
//   byTopic  -- attempts / passes / pass_rate per suspect+topic (the funnel)
//   byReason -- failure-reason distribution across all failed attempts
//
// JSONB notes: `data->>'passed'` extracts the stored boolean as text ('true'/'false');
// ::boolean::int makes it 1/0 so avg() is the pass rate. count(*) FILTER (WHERE ...) is
// a conditional aggregate -- one scan, multiple slices, no self-join.
export async function confrontations(_req: Request, res: Response): Promise<void> {
  const byTopic = await db.execute(sql`
    select
      -- Group on the STORED generated columns suspect/topic and read the passed column (all
      -- three materialized, see 06), not data->>'...'. Measured on PG16: a plain index on
      -- stored generated columns supports an INDEX ONLY SCAN (0 heap fetches), whereas an
      -- expression index over the same data->>'x' does not -- it falls back to a bitmap/heap
      -- scan even when heap-touching plans are forced off. Materializing the hot keys is what
      -- makes an index-only scan possible at all.
      --
      -- events_confrontation_cols_idx (suspect, topic, passed) carries every column this
      -- query reads, so it runs as a fully index-only GroupAggregate -- no heap visit for the
      -- JSONB payload. passed is a boolean generated column, so filter/avg use it directly.
      suspect,
      topic,
      count(*)::int                             as attempts,
      (count(*) filter (where passed))::int     as passes,
      round(avg(passed::int), 3)::float         as pass_rate
    from events
    where type = 'ConfrontationAttempted'
    group by suspect, topic
    order by attempts desc, suspect, topic
  `);

  // Reference the generated columns reason/passed, not data->>'...', so the planner can
  // use events_confrontation_reason_idx (passed, reason) for an index-only scan. The partial
  // predicate + leading passed mean the failed rows are found in the index and reason rides
  // along -- no heap visit for the JSONB payload.
  const byReason = await db.execute(sql`
    select
      reason,
      count(*)::int as count
    from events
    where type = 'ConfrontationAttempted' and not passed
    group by reason
    order by count desc
  `);

  res.json({ byTopic: byTopic.rows, byReason: byReason.rows });
}
