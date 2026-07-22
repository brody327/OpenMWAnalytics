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

// Idempotency guard: which sessions have already been folded into friction_rollup. Without
// this, a second job run re-adds already-settled sessions and inflates every bucket. This is
// ON CONFLICT DO NOTHING (ingest) one layer up -- "fold each settled session EXACTLY once".
export const frictionSessionsDone = pgTable('friction_sessions_done', {
  sessionId: uuid('session_id').primaryKey(),
  rolledAt: timestamp('rolled_at', { withTimezone: true }).notNull().defaultNow(),
});
