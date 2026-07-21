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
  },
  (t) => [
    // (session_id, seq) is BOTH the identity and the dedup key: a composite PK is
    // a uniqueness constraint, so ON CONFLICT DO NOTHING makes ingest idempotent.
    primaryKey({ columns: [t.sessionId, t.seq] }),
    // Bread-and-butter analytics shape: "count <type> per day".
    index('events_type_ts_idx').on(t.type, t.ts),
  ],
);
