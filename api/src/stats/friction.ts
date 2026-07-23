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
// How far back to look for sessions the fold has not covered yet (the HYBRID READ, below).
//
// Bounded on purpose. A session is normally folded within `lateness` (10 min) + one cron tick
// (5 min), so 30 min is ~2x headroom. If the fold job has been dead longer than this, sessions
// older than the window are in NEITHER half and silently vanish -- so the endpoint reports
// `coverage.foldStaleSeconds` and consumers can say so out loud rather than render a hole.
// Env-tunable so it can track the fold cadence without a redeploy -- and so tests can widen it
// to force the live path over historical data.
const LIVE_WINDOW = process.env.OMWA_FRICTION_LIVE_WINDOW ?? '30 minutes';

export async function friction(_req: Request, res: Response): Promise<void> {
  // --- THE HYBRID READ -------------------------------------------------------------------
  //
  // The rollup made this endpoint ~78x faster and introduced a freshness REGRESSION: it only
  // covers SETTLED, FOLDED sessions, so the session you just played -- the one a mod developer
  // actually wants to look at -- was missing for 10-15 minutes. That is a bad trade for a tool
  // whose main use is "I just played, what did that look like?".
  //
  // So each query below is answered in two halves and combined:
  //
  //   folded sessions   -> read from the rollup           (precomputed, instant)
  //   everything else   -> the original window query      (live, but over a handful of sessions)
  //
  // The split key is `friction_sessions_done`, NOT the watermark. Using the watermark would
  // leave a gap -- a session that has settled but not yet been folded would be excluded from
  // the live half AND absent from the rollup, so it would briefly DISAPPEAR. Splitting on
  // "folded / not folded" is exhaustive by construction: every session is in exactly one half.
  //
  // WHY THIS IS CORRECT: both queries partition by session_id, so restricting the live half to
  // a set of whole SESSIONS cannot change any other session's result. (Contrast the trap in the
  // original query: filtering to failures before the window WOULD change it, because that
  // filters ROWS WITHIN a partition. Filtering whole partitions is safe; filtering rows is not.)
  //
  // The fold is now purely an optimisation: correctness no longer depends on it having run.
  const unfolded = sql`
    select c.session_id
    from (
      select distinct session_id
      from events
      where received_at > now() - ${LIVE_WINDOW}::interval
    ) c
    left join friction_sessions_done d using (session_id)
    where d.session_id is null
  `;

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
  // The two halves are combined by UNION ALL and re-aggregated. This works *only* because the
  // stored parts are DECOMPOSABLE: sums and counts add across halves, and avg is derived once at
  // the end from the combined totals. Had we stored avg_gap_seconds directly, the two halves
  // could not be merged at all -- averaging two averages weights a 1-event session equally with
  // a 50-event one. The round-3 rule is what makes the hybrid read possible.
  const afterFailure = await db.execute(sql`
    with live_stream as (
      select
        session_id, seq, type, ts, data,
        lead(type) over w as next_type,
        lead(data) over w as next_data,
        lead(ts)   over w as next_ts
      from events
      where session_id in (${unfolded})
        and type not in ('Heartbeat', 'SpikeStarted')
      window w as (partition by session_id order by seq)
    ),
    live_fails as (
      select
        data->>'suspect' as suspect,
        data->>'topic'   as topic,
        case
          when next_type is null then 'session_end'
          when next_type = 'ConfrontationAttempted'
               and next_data->>'suspect' = data->>'suspect'
               and next_data->>'topic'   = data->>'topic'   then 'retried_same'
          when next_type = 'ConfrontationExited'
               and (next_data->>'completed')::boolean       then 'exited_solved'
          when next_type = 'ConfrontationExited'            then 'abandoned'
          when next_type = 'ConfrontationAttempted'         then 'switched_topic'
          when next_type = 'AreaEntered'                    then 'left_area'
          else 'other'
        end as next_action,
        extract(epoch from (next_ts - ts)) as gap_seconds
      from live_stream
      where type = 'ConfrontationAttempted'
        and not (data->>'passed')::boolean
    ),
    combined as (
      select suspect, topic, next_action, count, gap_count, sum_gap_seconds
      from friction_rollup
      union all
      select
        suspect, topic, next_action,
        count(*)::int, count(gap_seconds)::int, coalesce(sum(gap_seconds), 0)
      from live_fails
      group by suspect, topic, next_action
    )
    select
      suspect,
      topic,
      next_action,
      sum(count)::int as count,
      round((sum(sum_gap_seconds) / nullif(sum(gap_count), 0))::numeric, 1)::float
        as avg_gap_seconds
    from combined
    group by suspect, topic, next_action
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
  // Hybrid here is even simpler than afterFailure: because the rollup kept PER-SESSION grain
  // (round 4, Option B), the live half produces rows of exactly the same shape, so the two just
  // stack with UNION ALL and the existing aggregation runs over the union unchanged. Under
  // Option A -- collapsed to (suspect, topic) -- `max` could still be merged, but the average
  // could not: avg_attempts_to_pass would need sum+count that a collapsed table never stored.
  const attemptsToPass = await db.execute(sql`
    with live_attempts as (
      select
        session_id,
        suspect,
        topic,
        passed,
        row_number() over (
          partition by session_id, suspect, topic
          order by seq
        ) as attempt_no
      from events
      where type = 'ConfrontationAttempted'
        and session_id in (${unfolded})
    ),
    per_session as (
      select session_id, suspect, topic, total_attempts, attempts_to_pass
      from friction_attempts_rollup
      union all
      select
        session_id, suspect, topic,
        count(*)::int                         as total_attempts,
        min(attempt_no) filter (where passed) as attempts_to_pass
      from live_attempts
      group by session_id, suspect, topic
    )
    select
      suspect,
      topic,
      count(*)::int                                        as sessions,
      count(attempts_to_pass)::int                         as solved_sessions,
      sum(total_attempts)::int                             as total_attempts,
      round(avg(attempts_to_pass)::numeric, 2)::float      as avg_attempts_to_pass,
      max(total_attempts)::int                             as max_attempts_in_a_session
    from per_session
    group by suspect, topic
    order by solved_sessions asc, total_attempts desc, suspect, topic
  `);

  // Coverage metadata, so a stalled fold is VISIBLE rather than a silent hole. If the fold has
  // not run for longer than LIVE_WINDOW, sessions older than the window are in neither half.
  // fold_stale_seconds comes from the fold's LIVENESS heartbeat, not from the newest done-guard
  // row. The done-guard only advances when a session is actually folded, so during any quiet
  // period it grows without bound and a healthy pipeline reports hours of staleness (observed in
  // production: cron completing every 5 min, folding 0 sessions, endpoint claiming 2.2 hours).
  // "Last succeeded" and "last found work" are different questions; health wants the first.
  // NULL = the fold has never run.
  const coverage = await db.execute(sql`
    select
      (select extract(epoch from (now() - last_run_at))::int from friction_fold_state)
        as fold_stale_seconds,
      (select count(*) from (${unfolded}) u)::int as live_sessions
  `);

  res.json({
    afterFailure: afterFailure.rows,
    attemptsToPass: attemptsToPass.rows,
    // Additive key -- existing consumers ignore it.
    coverage: coverage.rows[0] ?? null,
  });
}
