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
      -- Generated columns, not data->>'...'. An expression index can FILTER, ORDER and
      -- COUNT on an expression, but Postgres cannot RETURN an expression's value from an
      -- index-only scan -- so selecting data->>'suspect' forces a heap visit for every
      -- matched row. Promoting the hot keys to stored generated columns makes an
      -- index-only scan possible: 29,670 buffers -> 116, ~90ms -> ~7ms. See 06.
      suspect,
      topic,
      count(*)::int                                            as attempts,
      (count(*) filter (where (data->>'passed')::boolean))::int as passes,
      round(avg((data->>'passed')::boolean::int), 3)::float    as pass_rate
    from events
    where type = 'ConfrontationAttempted'
    group by suspect, topic
    order by attempts desc, suspect, topic
  `);

  const byReason = await db.execute(sql`
    select
      data->>'reason'  as reason,
      count(*)::int    as count
    from events
    where type = 'ConfrontationAttempted' and not (data->>'passed')::boolean
    group by reason
    order by count desc
  `);

  res.json({ byTopic: byTopic.rows, byReason: byReason.rows });
}
