import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  integer,
  smallint,
  text,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

// The physical form of the event envelope from `design docs/02` + `06`.
// Envelope fields are real columns (indexed/queried/joined); the type-specific
// payload lives in a single jsonb column. Append-only, immutable event log.
export const events = pgTable(
  'events',
  {
    // --- envelope: identity + ordering ---
    sessionId: uuid('session_id').notNull(),   // per-launch anonymous id
    seq: integer('seq').notNull(),             // per-session monotonic counter
    installId: uuid('install_id').notNull(),   // persistent anonymous id (denormalized)

    // --- envelope: classification + version ---
    type: text('type').notNull(),              // event discriminator, PascalCase
    v: smallint('v').notNull(),                // envelope schema version

    // --- time (convert-at-the-boundary: epoch-ms wire -> timestamptz UTC) ---
    ts: timestamp('ts', { withTimezone: true }).notNull(),                 // event time
    receivedAt: timestamp('received_at', { withTimezone: true })           // processing time
      .notNull()
      .defaultNow(),

    // --- ingest provenance (server-stamped, like received_at) ---
    // 'dev' = the mod author exercising paths; 'prod' = a real play session. Authoring
    // traffic is instrumentation-shaped, not behaviour-shaped: counting it as player
    // behaviour is how a dashboard confidently reports something nobody did.
    //
    // NOT part of the event envelope (02): the Lua emitter cannot know whose machine it is
    // on, and baking it in would ship as whatever value was left in the file. The SHIPPER
    // knows, and it is a property of the collection run rather than of an event -- hence a
    // per-batch header the API stamps here, exactly as it stamps received_at.
    //
    // Defaults to 'prod' so an unlabelled source is treated as real: a forgotten flag then
    // pollutes the dev set (visible, correctable) rather than silently inflating the
    // player set (invisible, permanent).
    env: text('env').notNull().default('prod'),

    // --- payload ---
    data: jsonb('data').notNull().default({}),

    // --- promoted hot keys (06 §2 anticipated this: "promote a hot payload field to a
    // real column or a generated column + index") ---
    //
    // WHY, precisely (measured on PG16): a plain index over a STORED generated column
    // supports a true INDEX ONLY SCAN (Heap Fetches: 0). An *expression* index over the
    // same `data->>'x'` does NOT -- the planner will not produce an index-only scan from it
    // even when heap-touching plans are forced off (enable_bitmapscan/seqscan = off); it
    // bitmap/heap-scans instead. Materializing the value into a real column is what unlocks
    // an index-only scan at all. A second win when a query GROUPs on these: the index can
    // supply sorted input, enabling a GroupAggregate rather than building a HashAggregate.
    //
    // GENERATED ALWAYS ... STORED (not a plain column) so the value cannot drift from
    // `data` -- Postgres recomputes it on write; nothing can set it inconsistently.
    suspect: text('suspect').generatedAlwaysAs(sql`data->>'suspect'`),
    topic: text('topic').generatedAlwaysAs(sql`data->>'topic'`),
    // ConfrontationAttempted read-side keys, promoted for the /stats/confrontations
    // aggregates (byReason groups on `reason` + filters on `passed`; byTopic filters on
    // `passed` for pass_rate). `passed` is cast to boolean here so the value -- not the
    // 'true'/'false' text -- is what gets stored and indexed.
    reason: text('reason').generatedAlwaysAs(sql`data->>'reason'`),
    passed: boolean('passed').generatedAlwaysAs(sql`(data->>'passed')::boolean`),
  },
  (t) => [
    // (session_id, seq) is BOTH the identity and the dedup key: a composite PK is
    // a uniqueness constraint, so ON CONFLICT DO NOTHING makes ingest idempotent.
    primaryKey({ columns: [t.sessionId, t.seq] }),
    // Bread-and-butter analytics shape: "count <type> per day".
    index('events_type_ts_idx').on(t.type, t.ts),
    // PARTIAL: indexes only ConfrontationAttempted rows (~13% of the table). Every index is
    // a tax on writes -- a partial one keeps that tax proportional to the rows a query
    // actually cares about. Carries the grouping keys (suspect, topic) AND `passed`, so
    // byTopic -- which reads `passed` for passes/pass_rate -- is fully index-only (no heap
    // visit for the JSONB payload). `passed` is last because it is not part of the group
    // key; leading with (suspect, topic) keeps the index ordered for the GROUP BY.
    index('events_confrontation_cols_idx')
      .on(t.suspect, t.topic, t.passed)
      .where(sql`type = 'ConfrontationAttempted'`),
    // byReason (failure-reason breakdown): filters `not passed` and groups on `reason`.
    // Leading `passed` lets the scan seek the failed rows; `reason` rides along so the
    // grouped count is index-only -- no heap visit for the JSONB payload. Same partial
    // predicate keeps it to ConfrontationAttempted rows only.
    index('events_confrontation_reason_idx')
      .on(t.passed, t.reason)
      .where(sql`type = 'ConfrontationAttempted'`),
    // Supports the HYBRID READ in stats/friction.ts: "which sessions have arrived recently and
    // have not been folded into the rollup yet". Processing time, not event time -- the question
    // is about what the pipeline has received, so `ts` (which the client supplies and can skew)
    // is the wrong clock. Without this the candidate scan is a full pass over the PK index
    // (~653 ms at 1M rows), which costs more than the query the rollup was built to replace.
    index('events_received_at_idx').on(t.receivedAt),
  ],
);

// --- /stats/friction incremental rollup (design docs 06 "Tuning round 3") ---
//
// friction.afterFailure is a LEAD window over the WHOLE (session_id, seq) stream -- ~776 ms,
// ~62k buffers, unfixable by any index (a window function depends on row ADJACENCY, which an
// index cannot narrow). But the events log is append-only + immutable and the window is
// partitioned by session_id, so a SETTLED session's result is frozen forever. We precompute
// each settled session once and fold it in here; reads hit this table instantly.
//
// Decomposable aggregates only: store `count` (all failure rows) and `sum_gap_seconds` +
// `gap_count` SEPARATELY -- avg is derived at read (sum/gap_count), because you cannot average
// averages, and AVG ignores NULL gaps (session_end has no gap) so its denominator is the
// non-null count, not `count`.
export const frictionRollup = pgTable(
  'friction_rollup',
  {
    suspect: text('suspect').notNull(),
    topic: text('topic').notNull(),
    nextAction: text('next_action').notNull(), // retried_same | abandoned | left_area | ...
    count: integer('count').notNull(), // all failures landing in this bucket
    gapCount: integer('gap_count').notNull(), // failures with a non-null gap (denominator for avg)
    sumGapSeconds: doublePrecision('sum_gap_seconds').notNull(), // sum of gaps; avg = sum/gap_count
  },
  (t) => [primaryKey({ columns: [t.suspect, t.topic, t.nextAction] })],
);

// --- /stats/friction attemptsToPass rollup (design docs 06 "Tuning round 3") ---
//
// The endpoint's other window query (ROW_NUMBER over attempts within session+suspect+topic,
// ~324 ms / ~31.5k buffers) -- same neighbour-dependence problem, same fix. But note the GRAIN
// is deliberately FINER than friction_rollup's, and that is the whole design decision:
//
//   friction_rollup       collapses the session dimension away  -> additive fold (count + count)
//   friction_attempts_rollup  keeps one row PER SESSION         -> plain insert, DO NOTHING
//
// Two things fall out of keeping the session grain:
//
//  1. IDEMPOTENT BY CONSTRUCTION. (session_id, suspect, topic) is a real natural key, so a
//     re-fold collides with itself and DO NOTHING absorbs it -- the same trick `events` ingest
//     uses. friction_rollup can't do this: adding into an existing bucket is indistinguishable
//     from the bucket already being right, hence its separate done-guard table.
//     (The watermark is still load-bearing -- see refreshFrictionRollup. An unsettled session
//     would insert a PROVISIONAL attempts_to_pass, and DO NOTHING would then cement it forever.)
//
//  2. NON-DECOMPOSABLE AGGREGATES STAY POSSIBLE. avg is decomposable (sum/count, both additive)
//     but median/percentiles/COUNT DISTINCT are not: median-of-medians != median, and no set of
//     stored summaries recovers it. They're computable here only because the per-session values
//     are still present. Rule: never collapse past the grain that retains an aggregate's inputs.
//     Also why `max_attempts_in_a_session` is RECOMPUTED at read rather than stored -- max is
//     associative but NOT invertible, so a stored max can never be repaired by subtraction the
//     way a sum can; its only repair is a full recompute from events.
export const frictionAttemptsRollup = pgTable(
  'friction_attempts_rollup',
  {
    sessionId: uuid('session_id').notNull(),
    // Denormalized from events, and NOT part of the key -- one session has exactly one install,
    // so it adds no uniqueness. It is here so a cross-SESSION question can be asked without
    // rejoining events: doc 10 Q1.7 ("do players who quit on a topic ever come back and beat
    // it?") groups these per-session rows by install_id at READ time.
    //
    // That works only because the aggregation is set-based (does this install have both an
    // unsolved and a solved session for this topic?) rather than an install_id-partitioned
    // WINDOW. A window partitioned by install_id would break the rollup's whole correctness
    // argument -- a new session could change a prior partition's answer, so no partition would
    // ever be frozen. Aggregating at read over rows that are individually frozen costs nothing.
    installId: uuid('install_id').notNull(),
    suspect: text('suspect').notNull(),
    topic: text('topic').notNull(),
    totalAttempts: integer('total_attempts').notNull(),
    // NULL = this session never passed this topic. Load-bearing: count(attempts_to_pass) at read
    // therefore counts only sessions that DID solve it, and solved=0 with attempts>0 is the
    // unpassable-content signal (doc 10 Q1.6). Storing 0 here would destroy that distinction.
    attemptsToPass: integer('attempts_to_pass'),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.suspect, t.topic] })],
);

// Liveness heartbeat for the fold job -- exactly one row, rewritten on every successful run.
//
// WHY IT EXISTS: /stats/friction reports how stale the rollup is, and the obvious source for
// that -- max(friction_sessions_done.rolled_at) -- is WRONG. That timestamp only advances when a
// session is actually folded, so during any quiet period (nobody playing) it grows without bound
// and a perfectly healthy pipeline reports hours of staleness. Caught in production: the CronJob
// was running every 5 minutes, completing, folding 0 sessions, and the endpoint claimed 2.2 hours.
//
// "When did the job last SUCCEED" and "when did the job last FIND WORK" are different questions;
// a health signal must ask the first. Written inside the fold's transaction, so it records only
// runs that actually committed.
//
// Single row (`id` is a constant-true primary key), so it cannot grow.
export const frictionFoldState = pgTable('friction_fold_state', {
  id: boolean('id').primaryKey().default(true),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }).notNull().defaultNow(),
  lastSessionsFolded: integer('last_sessions_folded').notNull().default(0),
});

// Idempotency guard: which sessions have already been folded into friction_rollup. Without
// this, a second job run re-adds already-settled sessions and inflates every bucket. This is
// ON CONFLICT DO NOTHING (ingest) one layer up -- "fold each settled session EXACTLY once".
export const frictionSessionsDone = pgTable('friction_sessions_done', {
  sessionId: uuid('session_id').primaryKey(),
  rolledAt: timestamp('rolled_at', { withTimezone: true }).notNull().defaultNow(),
});
