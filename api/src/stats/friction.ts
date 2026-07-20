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
  const afterFailure = await db.execute(sql`
    with stream as (
      select
        session_id,
        seq,
        type,
        ts,
        data,
        lead(type) over w as next_type,
        lead(data) over w as next_data,
        lead(ts)   over w as next_ts
      from events
      where type not in ('Heartbeat', 'SpikeStarted')
      window w as (partition by session_id order by seq)
    ),
    fails as (
      select
        data->>'suspect' as suspect,
        data->>'topic'   as topic,
        case
          when next_type is null then 'session_end'
          when next_type = 'ConfrontationAttempted'
               and next_data->>'suspect' = data->>'suspect'
               and next_data->>'topic'   = data->>'topic'   then 'retried_same'
          -- ConfrontationExited is AUTHORITATIVE where left_area was only inferred:
          -- the player explicitly closed the panel. The completed flag separates "left
          -- because the suspect was finished" from "gave up". Ordered BEFORE the AreaEntered
          -- branch, since an exit is usually followed by movement anyway.
          when next_type = 'ConfrontationExited'
               and (next_data->>'completed')::boolean       then 'exited_solved'
          when next_type = 'ConfrontationExited'            then 'abandoned'
          when next_type = 'ConfrontationAttempted'         then 'switched_topic'
          when next_type = 'AreaEntered'                    then 'left_area'
          else 'other'
        end as next_action,
        extract(epoch from (next_ts - ts)) as gap_seconds
      from stream
      where type = 'ConfrontationAttempted'
        and not (data->>'passed')::boolean
    )
    select
      suspect,
      topic,
      next_action,
      count(*)::int                                    as count,
      round(avg(gap_seconds)::numeric, 1)::float       as avg_gap_seconds
    from fails
    group by suspect, topic, next_action
    order by count desc, suspect, topic
  `);

  // Q1.3 / Q1.6 -- how many attempts precede a success, and is anything unpassable.
  //
  // ROW_NUMBER() numbers each attempt within (session, suspect, topic); the first
  // row_number carrying passed=true is therefore "it took this many tries."
  // `min(...) FILTER (WHERE passed)` is NULL when a session never solved it -- which
  // is the point: count(attempts_to_pass) then counts only the sessions that DID
  // solve it, and solved=0 with attempts>0 is the unpassable-content signal (Q1.6).
  const attemptsToPass = await db.execute(sql`
    with attempts as (
      select
        session_id,
        data->>'suspect'                as suspect,
        data->>'topic'                  as topic,
        (data->>'passed')::boolean      as passed,
        row_number() over (
          partition by session_id, data->>'suspect', data->>'topic'
          order by seq
        )                               as attempt_no
      from events
      where type = 'ConfrontationAttempted'
    ),
    per_session as (
      select
        session_id,
        suspect,
        topic,
        count(*)::int                              as total_attempts,
        min(attempt_no) filter (where passed)      as attempts_to_pass
      from attempts
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

  res.json({
    afterFailure: afterFailure.rows,
    attemptsToPass: attemptsToPass.rows,
  });
}
