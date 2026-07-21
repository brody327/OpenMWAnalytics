import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  integer,
  smallint,
  text,
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
    // WHY, precisely: an expression index on (data->>'suspect') CAN filter, order and
    // count -- but Postgres cannot RETURN an expression's value from an index-only scan.
    // A query that SELECTs the extracted key therefore falls back to a heap visit for
    // every matched row. Proven directly: count(*) on such an index got Heap Fetches: 0,
    // while selecting the same expression paid a 29,555-block Bitmap Heap Scan.
    //
    // Stored generated columns hold the value as a real column, so an index over them
    // supports a true index-only scan. Measured on 1M rows: 29,670 buffers -> 116,
    // ~90ms -> ~7ms, and the plan drops from HashAggregate to GroupAggregate because the
    // index supplies the ordering for free.
    //
    // GENERATED ALWAYS ... STORED (not a plain column) so the value cannot drift from
    // `data` -- Postgres recomputes it on write; nothing can set it inconsistently.
    suspect: text('suspect').generatedAlwaysAs(sql`data->>'suspect'`),
    topic: text('topic').generatedAlwaysAs(sql`data->>'topic'`),
  },
  (t) => [
    // (session_id, seq) is BOTH the identity and the dedup key: a composite PK is
    // a uniqueness constraint, so ON CONFLICT DO NOTHING makes ingest idempotent.
    primaryKey({ columns: [t.sessionId, t.seq] }),
    // Bread-and-butter analytics shape: "count <type> per day".
    index('events_type_ts_idx').on(t.type, t.ts),
    // PARTIAL + COVERING: indexes only ConfrontationAttempted rows (13% of the table, so
    // ~900kB against 62MB for the full type index), and carries both grouping keys so the
    // aggregate never touches the heap. Every index is a tax on writes -- a partial one
    // keeps that tax proportional to the rows a query actually cares about.
    index('events_confrontation_cols_idx')
      .on(t.suspect, t.topic)
      .where(sql`type = 'ConfrontationAttempted'`),
  ],
);
