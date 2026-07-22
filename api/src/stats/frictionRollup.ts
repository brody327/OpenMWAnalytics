import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// Incremental maintenance of friction_rollup (design docs 06 "Tuning round 3").
//
// /stats/friction.afterFailure is a LEAD window over the WHOLE (session_id, seq) stream:
// ~776 ms, ~62k buffers, and NO index can narrow it -- a window function depends on row
// ADJACENCY, not on any value an index can seek. So instead of narrowing the query, we
// precompute its answer once per session and read from a table.
//
// WHY THIS IS CORRECT (the whole design rests on it):
//   1. events is append-only + immutable; the window is PARTITIONED BY session_id.
//   2. Each game launch mints a fresh session_id, so once a session stops receiving events
//      its partition is frozen -- no future event can change any of its LEAD results.
//   3. "Stops receiving events" is unknowable for certain in an async pipeline (the shipper
//      delivers in delayed, retried batches), so we use a WATERMARK WITH ALLOWED LATENESS:
//      a session is SETTLED once its newest event was received > `lateness` ago.
//   4. Each settled session is folded in EXACTLY ONCE, guarded by friction_sessions_done.
// => friction_rollup == the full query's result, restricted to settled sessions. The
//    currently-active session is deliberately excluded (its buckets would be provisional).
//
// Only DECOMPOSABLE aggregates are stored (count, gap_count, sum_gap_seconds); avg is derived
// at read as sum/gap_count. You cannot average averages, and AVG ignores NULL gaps, so its
// denominator is the non-null gap_count, not count.
//
// BOTH of the endpoint's window queries are folded here, from one _settled set in one
// transaction: friction_rollup (afterFailure, LEAD) and friction_attempts_rollup
// (attemptsToPass, ROW_NUMBER). They use DIFFERENT grains on purpose -- see schema.ts.
//
// Returns the number of sessions folded this run (0 in steady state). Idempotent: running it
// twice in a row folds the second time's 0 new sessions and leaves the rollup unchanged.
export async function refreshFrictionRollup(lateness = '10 minutes'): Promise<number> {
  return db.transaction(async (tx) => {
    // 0. Serialize concurrent folds (two API replicas, or a slow run overlapping the next tick).
    //
    //    A transaction-scoped ADVISORY LOCK: an application-defined mutex Postgres holds for us,
    //    released automatically on commit OR rollback -- no unlock call, no leak on crash. The
    //    key is arbitrary but must be agreed by every caller; it locks nothing physical.
    //
    //    Concurrency is ALREADY correct without this, but by crashing (see step 3). This makes
    //    the second run wait, then find 0 settled sessions and do nothing -- quiet instead of a
    //    unique-violation stack trace plus a wasted fold.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('friction_rollup_fold'))`);

    // 1. The settled-and-not-yet-done set, captured in a temp table so the fold (2) and the
    //    idempotency guard (3) operate on the IDENTICAL set within this transaction.
    await tx.execute(sql`
      create temp table _settled on commit drop as
      with settled as (
        select session_id
        from events
        group by session_id
        having max(received_at) < now() - ${lateness}::interval
      )
      select s.session_id
      from settled s
      left join friction_sessions_done d using (session_id)
      where d.session_id is null
    `);

    // 2. Compute afterFailure buckets for JUST those sessions and ADD them into the rollup.
    //    The CASE ladder MUST stay in sync with stats/friction.ts (a sequence query is coupled
    //    to the set of event types in the stream). Stored parts are decomposable; on a repeat
    //    bucket the ON CONFLICT sums rather than replaces.
    await tx.execute(sql`
      insert into friction_rollup (suspect, topic, next_action, count, gap_count, sum_gap_seconds)
      with stream as (
        select
          session_id, seq, type, ts, data,
          lead(type) over w as next_type,
          lead(data) over w as next_data,
          lead(ts)   over w as next_ts
        from events
        where session_id in (select session_id from _settled)
          and type not in ('Heartbeat', 'SpikeStarted')
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
        suspect, topic, next_action,
        count(*)::int                 as count,
        count(gap_seconds)::int       as gap_count,
        coalesce(sum(gap_seconds), 0) as sum_gap_seconds
      from fails
      group by suspect, topic, next_action
      on conflict (suspect, topic, next_action) do update set
        count           = friction_rollup.count           + excluded.count,
        gap_count       = friction_rollup.gap_count       + excluded.gap_count,
        sum_gap_seconds = friction_rollup.sum_gap_seconds + excluded.sum_gap_seconds
    `);

    // 2b. attemptsToPass, folded from the SAME _settled set inside the SAME transaction, so the
    //     two rollups can never disagree about which sessions they cover (and one done-guard
    //     row covers both).
    //
    //     Grain is per-session, unlike (2) -- see schema.ts frictionAttemptsRollup. Consequence:
    //     the fold is a plain INSERT ... DO NOTHING, not additive arithmetic, because the natural
    //     key (session_id, suspect, topic) makes a repeat fold collide with itself.
    //
    //     Reads the STORED GENERATED COLUMNS (suspect/topic/passed) rather than data->>'...' as
    //     the live query in stats/friction.ts does. Same values by construction -- the columns are
    //     GENERATED ALWAYS from exactly those expressions -- but they're indexed and heap-cheap.
    await tx.execute(sql`
      insert into friction_attempts_rollup (session_id, suspect, topic, total_attempts, attempts_to_pass)
      with attempts as (
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
          and session_id in (select session_id from _settled)
      )
      select
        session_id,
        suspect,
        topic,
        count(*)::int                         as total_attempts,
        min(attempt_no) filter (where passed) as attempts_to_pass
      from attempts
      group by session_id, suspect, topic
      on conflict (session_id, suspect, topic) do nothing
    `);

    // 3. Mark those sessions done so a later run can never fold them again (exactly-once).
    //
    //    ⚠️ DO NOT ADD `on conflict do nothing` HERE. It looks like an obvious defensive tidy-up
    //    and it would silently corrupt friction_rollup.
    //
    //    Without the advisory lock in (0) -- e.g. if someone removes it, or runs the fold from
    //    two different code paths -- two concurrent folds BOTH add into friction_rollup at step
    //    (2), because `count + excluded.count` on an already-committed row cannot tell "already
    //    folded" from "fold me". The only thing that undoes that double-count is THIS insert
    //    raising a unique violation and rolling the whole (single) transaction back. Swallow the
    //    conflict and the doubling commits: every bucket permanently inflated, no error raised,
    //    numbers that still look plausible.
    //
    //    friction_attempts_rollup does NOT depend on this -- its natural key makes DO NOTHING
    //    correct there. Two rollups, two different reasons for concurrency safety.
    const done = await tx.execute(sql`
      insert into friction_sessions_done (session_id)
      select session_id from _settled
    `);

    return done.rowCount ?? 0;
  });
}
