import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// GET /stats/friction
//
// The *sequence* read side (design docs 10 §3.1, questions 1.3 / 1.4 / 1.6).
//
// Everything in confrontations.ts is a GROUP BY: it collapses rows into buckets and
// throws ordering away. That answers "how often did this fail" but not "was the
// failure OK" -- and a pass rate alone cannot tell good difficulty from bad
// difficulty. A boss you lose 5 times and beat is a *great* boss. What separates
// good friction from bad is what the player does NEXT: retry-and-succeed is working
// as intended; fail-then-wander-off is the alarm bell.
//
// So these queries keep every row and let each row see its neighbours -- window
// functions over the (session_id, seq) event stream, which is also the PK.
//
// Two traps encoded below, both load-bearing:
//
//  1. System events poison the window. A Heartbeat fires every 5s, so the row
//     following almost any failure is a heartbeat -- LEAD would report "players
//     respond to failure by idling," an instrumentation artifact. They are excluded
//     from the stream BEFORE the window is applied.
//
//  2. WHERE runs *before* window functions. Filtering to failures in the same query
//     level would make LEAD see only other failures -- "next event" would silently
//     become "next failure." Hence the CTE: compute LEAD over the full stream first,
//     filter to failures in the outer query.
export async function friction(_req: Request, res: Response): Promise<void> {
  // Q1.4 -- what happens after a failed attempt.
  //
  // Buckets map onto the post-failure reading table in doc 10 §3.1:
  //   retried_same   -> engaged with the same problem      (good friction)
  //   exited_solved  -> closed the panel, suspect finished (fine -- not friction)
  //   switched_topic -> moved to a different line of attack (soft avoidance)
  //   abandoned      -> explicitly closed the panel unfinished (bad friction)
  //   left_area      -> walked off without closing         (bad friction, inferred)
  //   session_end    -> no further activity this session   (worst signal)
  //
  // NOTE `abandoned`/`exited_solved` come from the explicit ConfrontationExited event and
  // SUPERSEDE the `left_area` inference for confrontations. Adding that event initially
  // *broke* this query -- LEAD saw an event type the CASE had no branch for, so real
  // abandonments silently fell into 'other' and were dropped from the chart. A sequence
  // query is coupled to the SET of event types in the stream: adding an event type is a
  // change to every consumer that reasons about "what happened next".
  //
  // NOTE session_end is *inferred*: there is no SessionEnded event, and a crash, an
  // alt-F4 and a clean quit are indistinguishable from the log. It really means
  // "last observed activity" (doc 10 §4, module 4 caveat).
  // Read from the precomputed friction_rollup, NOT the live LEAD window. The window scans the
  // whole (session_id, seq) stream (~776 ms, ~62k buffers) and no index can narrow it -- a
  // window function depends on row adjacency, not any seekable value. The rollup precomputes
  // this per settled session exactly once (see stats/frictionRollup.ts + design docs 06).
  //
  // avg is DERIVED here (sum/gap_count), not stored: you cannot average averages, and AVG
  // ignores NULL gaps, so its denominator is gap_count (non-null), not count. nullif guards
  // the session_end buckets (all gaps NULL -> avg NULL), matching the live query exactly.
  const afterFailure = await db.execute(sql`
    select
      suspect,
      topic,
      next_action,
      count,
      round((sum_gap_seconds / nullif(gap_count, 0))::numeric, 1)::float as avg_gap_seconds
    from friction_rollup
    order by count desc, suspect, topic
  `);

  // Q1.3 / Q1.6 -- how many attempts precede a success, and is anything unpassable.
  //
  // ROW_NUMBER() numbers each attempt within (session, suspect, topic); the first
  // row_number carrying passed=true is therefore "it took this many tries." That per-session
  // number is what the rollup stores, and it is NULL when a session never solved it -- which is
  // the point: count(attempts_to_pass) counts only the sessions that DID solve it, so solved=0
  // with attempts>0 is the unpassable-content signal (Q1.6).
  //
  // Read from friction_attempts_rollup, NOT the live ROW_NUMBER window (~324 ms, ~31.5k buffers,
  // and no index can narrow it -- a window function depends on row adjacency, not a seekable
  // value). The rollup stores the `per_session` CTE below, precomputed once per settled session;
  // the outer aggregation that used to run over a freshly-windowed 1M-row scan now runs over a
  // few thousand stored rows.
  //
  // Deliberately kept at PER-SESSION grain rather than collapsed to (suspect, topic): it makes
  // the fold idempotent by natural key, keeps `max` recomputed rather than stored (max is not
  // invertible, so a stored one can only ever be repaired by full recompute), and leaves the
  // distribution intact so a future median/p90 stays answerable -- none of which survive a
  // collapse. See schema.ts frictionAttemptsRollup for the full argument.
  const attemptsToPass = await db.execute(sql`
    select
      suspect,
      topic,
      count(*)::int                                        as sessions,
      count(attempts_to_pass)::int                         as solved_sessions,
      sum(total_attempts)::int                             as total_attempts,
      round(avg(attempts_to_pass)::numeric, 2)::float      as avg_attempts_to_pass,
      max(total_attempts)::int                             as max_attempts_in_a_session
    from friction_attempts_rollup
    group by suspect, topic
    order by solved_sessions asc, total_attempts desc, suspect, topic
  `);

  res.json({
    afterFailure: afterFailure.rows,
    attemptsToPass: attemptsToPass.rows,
  });
}
