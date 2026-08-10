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
  check,
  vector,
  customType,
} from 'drizzle-orm/pg-core';

// drizzle has no built-in `tsvector`, so declare the raw type. We never read this column into
// JS -- it exists only for the GIN index and the @@ operator to work against -- so `string` is
// a placeholder, not a promise about its shape.
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

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

    // --- content domain: WHICH MOD is this event about? ---
    //
    // Semantics: the content domain the event describes, NOT the code that emitted it.
    // `AreaEntered` is emitted by our own player.lua but describes unmodded engine behaviour,
    // so it is 'base' -- there is no 'omwanalytics' mod, because we author no content.
    // 'base' is deliberately just another mod_id, not a special case: per-mod pages, filters
    // and any future tenancy rule then work uniformly with zero branching.
    //
    // WHY IT IS PER-EVENT AND NOT A PER-BATCH HEADER (unlike `env`): one openmw.log interleaves
    // events from every installed mod, so the shipper cannot know which mod a line came from.
    //
    // WHY IT IS DECLARED, NOT DERIVED (verified, not assumed): the log prefix is always
    // `Global[scripts/omwanalytics/telemetry.lua]` -- our emitter, since every mod funnels
    // through one global script -- and OpenMW's Lua sandbox allows only coroutine/math/string/
    // table/os, so there is no `debug` library and no way to introspect the caller. The mod
    // states its id once when it requires the SDK.
    //
    // TRUST: self-declared and unverified, exactly like `env`. A mod could claim any id.
    // Format is validated at the emitter, not authenticated.
    //
    // Defaults to 'unknown' so an unlabelled event is COLLECTED and visibly wrong rather than
    // rejected or silently attributed to something real.
    //
    // ⚠️ KNOWN SEAM: this is the *emitting* domain. `AreaEntered` fires inside cells that belong
    // to other mods ("Fastus Retreat" is CCFF content), so a 'base' row can describe a modded
    // location. Correct attribution needs a cell -> mod content manifest (doc 10); deferred.
    modId: text('mod_id').notNull().default('unknown'),

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
    // The event EXPLORER's feed order (newest first), and the index that makes KEYSET
    // pagination work. Its column order must match the ORDER BY exactly -- the whole point is
    // that the index can seek straight to a cursor position and then walk.
    //
    // Measured on 1M rows, both plans using THIS index:
    //   keyset  page N     -> 50 rows, ~0.14 ms   (seek to the cursor value, read 50)
    //   OFFSET  500000     -> 500,050 rows, ~218 ms (~1,500x) -- it must WALK past them
    // A B-tree has no rank/order statistic, so there is no such thing as seeking to the
    // 500,000th entry. An index cannot rescue OFFSET; only a different query shape can.
    //
    // (ts, session_id, seq) is also a TOTAL order -- ts alone ties constantly, and a
    // non-deterministic tie-break would make pages overlap or skip regardless of technique.
    index('events_feed_idx').on(
      sql`ts desc`, sql`session_id desc`, sql`seq desc`,
    ),
  ],
);

// Registry of mods seen by the platform. Auto-registered on first sight during ingest -- the
// same zero-DDL philosophy as event types: a new mod requires no migration and no config, it
// simply starts appearing. This is what gives /mods a real list and per-mod pages a title.
//
// It is a CACHE OF OBSERVED IDS, not an allow-list: nothing is rejected for being absent. That
// keeps ingest fast (no lookup on the write path beyond one upsert) and keeps the platform
// open, which is the point of a generic telemetry service. If it ever becomes an authorization
// boundary, that is the table to add a key/owner column to -- which is the whole reason the
// dimension exists now rather than later.
export const mods = pgTable('mods', {
  modId: text('mod_id').primaryKey(),
  // Human label for the UI. NULL until someone sets it -- we cannot invent a display name from
  // an id, and guessing one ("Ccff") would look broken in a heading.
  displayName: text('display_name'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

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

// Shipper liveness -- ONE ROW PER INSTALL, rewritten on every heartbeat. Never appended.
//
// WHY IT EXISTS: on 2026-07-20 the shipper died and telemetry was silently dark for six days
// (`04`). `/health` was green throughout and was right to be -- the API was fine, the pipeline
// was not. Nothing in the cloud could tell the difference between a dead shipper and a player
// who simply was not playing.
//
// ⚠️ THAT AMBIGUITY IS THE WHOLE DESIGN PROBLEM, and it is `frictionFoldState`'s lesson one
// layer up: max(events.received_at) only advances when someone PLAYS, so during any quiet
// period it grows without bound and a healthy pipeline looks broken. An alert built on it
// cries wolf every time the author takes a day off, gets muted, and then misses the real
// outage -- which is worse than no alert, because you believe you are covered.
//
// A heartbeat separates the two questions: "is the shipper ALIVE" (this table) from "is anyone
// PLAYING" (the events table). Only the first is an outage.
//
// ⚠️ WHY NOT AN EVENT: `03` retired the original `Heartbeat` type for exactly the reason a
// reviewer would raise here -- 1,049 heartbeats against 11 real events, which bloated storage
// AND corrupted sequence analysis (`LEAD()` reported "players respond to failure by idling").
// Keyed by install_id, this table holds one row per install FOREVER: bounded by how many people
// run the mod, not by how long they run it. It is also structurally invisible to every sequence
// query, because it is not in `events` at all. Ops liveness and product telemetry are different
// concerns and `03`'s complaint was precisely that they had been mixed.
export const shipperState = pgTable('shipper_state', {
  installId: uuid('install_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  // Lets "alive but stuck" be distinguished from "alive and idle": a shipper whose offset never
  // advances while it keeps checking in is a different failure from one with nothing to send.
  lastShippedSeq: integer('last_shipped_seq'),
  shipperVersion: text('shipper_version'),
});

// Idempotency guard: which sessions have already been folded into friction_rollup. Without
// this, a second job run re-adds already-settled sessions and inflates every bucket. This is
// ON CONFLICT DO NOTHING (ingest) one layer up -- "fold each settled session EXACTLY once".
export const frictionSessionsDone = pgTable('friction_sessions_done', {
  sessionId: uuid('session_id').primaryKey(),
  rolledAt: timestamp('rolled_at', { withTimezone: true }).notNull().defaultNow(),
});

// ===========================================================================================
// --- Search & retrieval over the GAME CORPUS (design docs 11) ---
//
// A second corpus alongside `events`: the game's own text (dialogue, books, cells, spells,
// items), extracted locally with esmtool and joined to telemetry. Everything above this line
// is behaviour the platform OBSERVED; everything below is content the game SHIPS.
// ===========================================================================================

// One row per game record -- the thing a search RETURNS (11 §4).
//
// Split from game_chunks because retrieval grain and display grain are different questions:
// we search fine (paragraph) and return coarse (record). The pattern is called PARENT-DOCUMENT
// RETRIEVAL, and this is the parent.
//
// It also exists because the indexed form is LOSSY: `to_tsvector` stems `Cosades` to `cosad`
// and cannot render it back. Anything shown to a human must come from `full_text`, never from
// a reconstruction of the index.
export const gameRecords = pgTable(
  'game_records',
  {
    // esmtool's own id (e.g. 'ccff_titania_injury_report'). A NATURAL key, deliberately: it is
    // what the plugin files use, what telemetry joins against (11 §3), and what makes ingest
    // re-runnable without a lookup table mapping surrogate ids back to game content.
    recordId: text('record_id').primaryKey(),
    source: text('source').notNull(),   // 'Morrowind.esm' | 'ccff.omwaddon' | ...
    type: text('type').notNull(),       // esmtool record type: INFO | BOOK | CELL | SPEL | ALCH | NPC_ ...
    name: text('name'),                 // display name; NULL for records that genuinely have none (many INFO rows)
    fullText: text('full_text').notNull(),
  },
  (t) => [
    // The corpus is browsed and filtered by type far more than by anything else ("show me the
    // books", "only ALCH"), and type is also the pre-filter for the selective recommendation
    // path in 11 §7 -- the one that deliberately does NOT use the vector index.
    index('game_records_type_idx').on(t.type, t.source),
  ],
);

// One row per embeddable unit -- the thing a search SCANS (11 §4).
//
// GRAIN, and it is the same rule as the friction rollup: store at the finest grain that retains
// the inputs, derive the coarse view. An embedding is a FIXED-SIZE array regardless of input
// length, so a whole-book vector is the average of everything the book discusses and sits close
// to none of it. That is collapsing past the grain, and it is unrecoverable without re-embedding.
//
// Only BOOKs are chunked (601 of them). INFO/CELL/SPEL/ALCH text is 1-3 sentences -- splitting
// it shreds meaning rather than sharpening it. Net ~34,000 chunks.
//
// Book-level results are a GROUP BY record_id with MAX(score) ("any paragraph about it counts")
// rather than AVG ("the book must be substantially about it"). That choice is revisitable at
// QUERY time without re-embedding anything, which is the entire payoff of the fine grain.
export const gameChunks = pgTable(
  'game_chunks',
  {
    chunkId: text('chunk_id').primaryKey(),  // `${recordId}#${ordinal}` -- derivable, so ingest never needs a sequence
    recordId: text('record_id')
      .notNull()
      .references(() => gameRecords.recordId, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),   // 0 for unchunked records; paragraph index within a book
    text: text('text').notNull(),

    // --- the semantic half ---
    //
    // 384 dims, NOT because 1536 costs more to embed (the whole corpus is ~$0.04 either way)
    // but because of RESIDENCY. Measured on the live RDS db.t3.micro 2026-07-26:
    // shared_buffers = 185 MB. At 1536 the raw column alone is ~209 MB -- 113% of the pool
    // before the index exists. At 384 it is ~52 MB.
    //
    // Residency is not a nice-to-have for HNSW specifically: the index is a proximity GRAPH
    // that is WALKED, so traversal is a serial pointer chase. Each hop's address is unknown
    // until the previous hop is read, so nothing can be prefetched and nothing can be
    // parallelised. On RDS every buffer miss is a network round trip to EBS. A btree that
    // misses costs 3-4 round trips; an HNSW walk that misses costs hundreds, in series.
    //
    // 384 is safe rather than lossy because the model is trained with MATRYOSHKA representation
    // learning -- the loss is applied at multiple prefix lengths, forcing information into the
    // leading dimensions -- so truncating 1536 -> 384 degrades gracefully. We get a strong model
    // at a small footprint, not a weak model. Truncating a model NOT trained this way would
    // produce vectors that still typecheck, still return cosine values, and mean nothing.
    //
    // NULLABLE: chunks are written before they are embedded, so a row with a NULL embedding is
    // "parsed, not yet vectorised" -- a visible, queryable state rather than a missing row.
    embedding: vector('embedding', { dimensions: 384 }),

    // --- the lexical half ---
    //
    // GENERATED, so it cannot drift from `text` and cannot be written inconsistently -- the same
    // argument as events.suspect/topic.
    //
    // The 'english' config is a hard-coded literal and MUST be. Postgres rejects the one-arg
    // to_tsvector() here because it reads default_text_search_config, a session GUC, which makes
    // it non-IMMUTABLE. That rejection is the engine enforcing the exact hazard this project
    // keeps meeting: index one way, query another, get silence instead of an error.
    //
    // 'english' over 'simple' was MEASURED (11 §9), not assumed: simple produced 75% more tokens
    // and the extras were 'the'/'of'/'were'. The feared damage to invented Dunmer names did not
    // occur -- balmora/dagoth/sadrith/mora are byte-identical under both.
    //
    // Stemming does not need to be CORRECT, only SYMMETRIC: 'Cosades' -> 'cosad' is fine because
    // the query stems identically.
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', text)`),

    // --- idempotency key (11 §8) ---
    //
    // Re-running ingest must not re-embed unchanged text, so we skip on a content hash -- the
    // same technique as migration baselining (09 §7): record the hash, never IF NOT EXISTS.
    //
    // ⚠️ THE TRAP, and it is why two more columns exist: a TEXT-ONLY hash silently permits a
    // model swap. Change the model, re-run, and unchanged text is skipped -- leaving vectors
    // from two different models in one column, where the distances between them are arbitrary.
    // No error. Results still return. Rankings quietly wrong. The query side is worse still:
    // the runtime query vector comes from whatever model is configured NOW, so a swap breaks
    // search even if not one row is re-embedded.
    //
    // The vector is a function of (text, model, dims), so the key must be all three. Skip only
    // when all three match; a model change then invalidates everything BY CONSTRUCTION, loudly,
    // for four cents. General rule: an idempotency key must cover every input the cached output
    // depends on -- not just the one that is obviously "the data".
    textHash: text('text_hash').notNull(),          // sha256 of `text`
    embeddingModel: text('embedding_model'),        // e.g. 'text-embedding-3-small'
    embeddingDims: smallint('embedding_dims'),      // dims AFTER truncation
  },
  (t) => [
    // The three embedding columns are written as one unit. Enforcing that here means a partial
    // write is impossible rather than merely unlikely -- there is no state where a vector exists
    // whose provenance is unknown, which is the state the trap above depends on.
    check(
      'game_chunks_embedding_provenance_ck',
      sql`(${t.embedding} IS NULL) = (${t.embeddingModel} IS NULL)
          AND (${t.embedding} IS NULL) = (${t.embeddingDims} IS NULL)`,
    ),
    // Parent-document rollup (GROUP BY record_id) and orphan cleanup during ingest.
    index('game_chunks_record_idx').on(t.recordId, t.ordinal),
    // GIN, not GiST: slower to build, faster to search -- the right side of that trade for a
    // corpus written once and read constantly. Expect a few MB, an ORDER OF MAGNITUDE cheaper
    // than the HNSW index below. The semantic half is the expensive half; worth knowing which
    // one you are paying for.
    index('game_chunks_tsv_idx').using('gin', t.tsv),
    // vector_cosine_ops because similarity here is ANGLE, not magnitude -- a long book chunk and
    // a short dialogue line about the same subject must match. (OpenAI returns unit-length
    // vectors, so cosine and L2 rank identically; we truncate to 384 and RE-NORMALIZE precisely
    // to keep that true.)
    //
    // ⚠️ This index exists to serve the HUMAN SEARCH BOX (11 §1 use case A) and nothing else.
    // The telemetry-driven recommendation path pre-filters to ~30 rows and scans them exactly:
    // over 30 candidates, exact KNN is both faster AND correct, so approximate indexing would be
    // strictly worse. Being able to say why the index is deliberately NOT on the flagship
    // feature's hot path is the point. If use case A were dropped, this index is dead weight.
    //
    // Build/tuning parameters (m, ef_construction, ef_search) are deliberately left at defaults
    // here: step 7 sweeps them against measured recall@10 and p95, and a guessed value baked
    // into a migration would be a magic number defended by nothing.
    index('game_chunks_embedding_hnsw_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
);

// One row per magic effect on a record -- ONE-TO-MANY (11 §6).
//
// This is 06's JSONB-vs-columns debate returning, and the answer is DIFFERENT this time.
// `events` is JSONB because any third-party mod may invent a payload shape at runtime; that
// argument does not apply here (MGEF is a fixed 137-entry set defined by the engine). But
// schema openness is not the blocker. CARDINALITY is:
//
//   A generated column is a function of ONE ROW producing ONE VALUE. Skooma has three effects.
//   `effects->0->>'skill'` can only ever mean "the first effect, whatever that is"; the other
//   two are simply absent. Widening to effect_1_*, effect_2_*, effect_3_* fails on the spell
//   with seven. There is no number of columns that is enough, because the number is not fixed.
//   This is an EXPRESSIBILITY ceiling, not a tuning problem -- no index reaches it.
//
// The iteration a one-to-many needs is ROWS. A child table is that loop.
//
// ⚠️ And it removes a silent wrong-answer bug. In JSONB, a range predicate over an array can be
// satisfied by DIFFERENT ELEMENTS than the containment test:
//
//   WHERE effects @> '[{"skill":"speechcraft"}]'            -- matched by element 1
//     AND (effects->0->>'magnitude')::int >= 10             -- matched by element 0
//
// Skooma (Strength +20, Speechcraft +1) matches "boosts Speechcraft by 10+". Correctness needs
// jsonb_path_exists, which GIN cannot index usefully. Here both predicates apply to the SAME
// ROW, so the false match is structurally impossible:
//
//   WHERE affected = 'speechcraft' AND magnitude_min >= 10
//
// Note the inversion of the usual intuition: a new effect TYPE is a new ROW here, but new DDL
// in the generated-column design. The flexibility JSONB is normally chosen for is, in this
// shape, better served by normalizing.
export const recordEffects = pgTable(
  'record_effects',
  {
    recordId: text('record_id')
      .notNull()
      .references(() => gameRecords.recordId, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),         // effect order as the record declares it
    effectId: integer('effect_id').notNull(),      // MGEF index
    effectName: text('effect_name').notNull(),     // 'Fortify Skill', 'Restore Health', ...
    affected: text('affected'),                    // 'speechcraft' | 'strength' | NULL when the effect targets neither
    affectedKind: text('affected_kind'),           // 'skill' | 'attribute' | NULL -- disambiguates ids that collide across the two enums
    magnitudeMin: integer('magnitude_min'),
    magnitudeMax: integer('magnitude_max'),
    duration: integer('duration'),
    range: text('range'),                          // 'self' | 'touch' | 'target'
  },
  (t) => [
    primaryKey({ columns: [t.recordId, t.ordinal] }),
    // The pre-filter for 11 §7's use case B: "what could serve a Speechcraft check at magnitude
    // >= 10". Selective (~30 rows of ~34,000), which is exactly why that path skips the vector
    // index -- selectivity is the deciding variable, the same quantity as seq-scan-vs-index-scan.
    index('record_effects_affected_idx').on(t.affected, t.magnitudeMin),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// World placement survey (11 §13) -- WHERE items actually are.
//
// The corpus knows what items EXIST; nothing in it knows where they ARE. `10 Q3.6` rests entirely
// on the word *accessible*, and `/stats/sufficiency` therefore emits `reachable: 'UNKNOWN'` on
// every row. These two tables are what eventually lets it say something else.
//
// ⭐ WHY SURVEY THE RUNNING GAME rather than parse more .esm files: placement is not in esmtool's
// formatted dump at all, and the engine has ALREADY merged the load order -- reimplementing
// Morrowind's override semantics across a large load order is exactly the work we get for free.
//
// ⚠️ THE CONTAMINATION PROBLEM, AND WHY THE LOAD ORDER IS A COLUMN.
// Lua cannot report an object's PROVENANCE -- `recordId` carries no source file. A survey run on
// the author's normal setup (measured 2026-07-28: **683 content files**) would silently bake
// hundreds of personal mods' placements into a corpus meant to describe the shared base, and the
// result would join cleanly and read as fact. Same shape as the test-fixture bug: data from one
// context contaminating a dataset meant for another.
//
// ⭐ THE RESOLUTION: `core.contentFiles.list` (OpenMW 0.51) reports the COMPLETE SET of files that
// could have produced any object. Per-object provenance is then unnecessary -- if the set IS the
// controlled set, every object necessarily came from it. We constrain the universe instead of
// interrogating each inhabitant. Doc 11 §13 originally treated this as procedure ("run it against
// a controlled load order"); a procedure rots, a stored + enforced column does not.
export const worldSurveys = pgTable('world_surveys', {
  surveyId: text('survey_id').primaryKey(),
  // The full load order the survey ran under, in order. Stored even though ingest REFUSES a
  // contaminated manifest, because "what world does this table describe" must be answerable from
  // the database alone -- not from whoever remembers how it was produced.
  loadOrder: jsonb('load_order').notNull(),
  // Stable fingerprint of loadOrder. This is the STALENESS DETECTOR: the world changes when the
  // load order does, and a placement table that silently describes an old world is the same class
  // of bug as a chunk generated by superseded code (11 §12, and 2026-07-28's chunk drift).
  loadOrderHash: text('load_order_hash').notNull(),
  cellsScanned: integer('cells_scanned').notNull(),
  surveyedAt: timestamp('surveyed_at', { withTimezone: true }).notNull(),
});

// GRAIN -- `(area, item_record_id)`, never one row per object instance.
//
// The spike measured ~200,000 placements (≈10,600 loose potions + ≈42,000 ingredients + ≈155,000
// container items). One row per instance would be the retired `Heartbeat` mistake at 200x scale.
// The question is "where can this item be found", so the grain is a GROUP BY, collapsed in Lua
// before anything is written.
//
// ⭐ `area` MUST use `AreaEntered`'s convention (03): interior -> cell.name, exterior ->
// cell.region. This is the entire payoff -- telemetry says WHERE PLAYERS FAIL, placement says
// WHERE THE REMEDY IS, and they only join if both mean the same thing by "area". Raw cell ids
// would produce a table that is correct and useless.
export const itemPlacements = pgTable(
  'item_placements',
  {
    area: text('area').notNull(),
    isExterior: boolean('is_exterior').notNull(),
    // ⚠️ LOWERCASE -- Lua's `recordId` is documented to return lowercase, while corpus ids are
    // mixed-case (12 of 353 consumables, e.g. `ingred_Dae_cursed_emerald_01`). Every join to
    // `game_records` MUST go through `lower(record_id)` or those silently vanish -- no error, no
    // missing-row signal, just a quietly smaller answer. The hazard is created here and paid for
    // at the read side, so it is written down at both ends (03 ItemConsumed says the same).
    itemRecordId: text('item_record_id').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.area, t.itemRecordId] }),
    // "Where can I find X" -- the lookup that answers reachability for a specific remedy, which is
    // the direction Q3.6 asks in.
    index('item_placements_item_idx').on(t.itemRecordId),
  ],
);

// ---------------------------------------------------------------------------------------------
// Phase 4c: generated insights and their review state (design docs 12).
//
// WHY THIS IS A TABLE AND NOT A LIVE CALL.
//
// A generated insight is not a query result. Two things make it a stored artefact:
//
//  1. **Review is a state transition.** The "human review" claim means an insight is
//     `pending` until a person approves it, and only approved insights render publicly. That is a
//     status column by definition -- generating on read would mean serving unreviewed model output
//     as though it were reviewed, which is the whole thing the review step exists to prevent.
//  2. **The evidence has to be kept.** A reviewer judging "is this a correct inference?" needs the
//     exact payload the model saw, not today's re-run of the query. Telemetry accumulates and the
//     corpus gets re-ingested, so a later re-derivation would show a reviewer different evidence
//     from the one the claim was made against -- and they would be reviewing a different claim.
//
// ⚠️ This makes the row a DERIVED ARTEFACT with all that implies: change the prompt, the schema or
// the evidence query and every stored insight was produced by code that no longer exists. That is
// the same class as prod's stale `game_chunks` (11 §14) -- hence `prompt_version` below, which
// exists so the drift is queryable instead of invisible.
export const insights = pgTable(
  'insights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The gate this is about. Not a foreign key: gates are a GROUP BY over the event log, not a
    // table, so there is nothing to reference. An insight can outlive the failures that produced
    // it, which is correct -- the finding was true when it was made.
    // ⚠️ THE GATE GRAIN IS ALL FOUR OF THESE, not check_id. Measured 2026-08-09:
    // `ccff_j_mortar:force` alone is SIXTEEN gates -- security@25, security@30, alchemy@25,
    // shortblade@25, luck@25 ... -- and they do not share a verdict (security@60 is `no_remedy`
    // while acrobatics@25 is `remedy_exists`). Keying an insight on check_id alone attaches a
    // finding about one stat to a gate about another: plausible, actionable, and wrong, with no
    // error anywhere. `stat_kind` is in the key because skill and attribute names collide across
    // the two enums, which is the same reason the sufficiency join carries it.
    checkId: text('check_id').notNull(),
    stat: text('stat').notNull(),
    statKind: text('stat_kind').notNull(),
    threshold: integer('threshold').notNull(),

    // ── the generated content ──
    headline: text('headline').notNull(),
    signposting: text('signposting').notNull(),
    rationale: text('rationale').notNull(),
    recommendation: text('recommendation').notNull(),
    /** record_ids the rationale rests on -- all validated as present in `evidence` before insert. */
    citations: jsonb('citations').notNull(),

    // ── provenance: what produced it ──
    /** Resolved from the response, so a server-side fallback records the model that ACTUALLY ran. */
    model: text('model').notNull(),
    /** Bumped whenever the prompt or evidence shape changes. Makes derived-artefact drift a query. */
    promptVersion: integer('prompt_version').notNull(),
    /** The exact payload the model saw. The reviewer's oracle; see the header. */
    evidence: jsonb('evidence').notNull(),

    // ── review state ──
    /** pending | approved | rejected. Only `approved` is ever rendered to a non-reviewer. */
    status: text('status').notNull().default('pending'),
    reviewNote: text('review_note'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Enforced in the database, not just in the handler. `status` drives what the public dashboard
    // renders, so a typo'd value must not be storable -- a row reading 'aproved' would silently
    // fail the `= 'approved'` filter and vanish, which looks like the insight was never generated.
    check('insights_status_ck', sql`${t.status} in ('pending', 'approved', 'rejected')`),
    check(
      'insights_signposting_ck',
      sql`${t.signposting} in ('SIGNPOSTED', 'NOT_SIGNPOSTED', 'UNCLEAR')`,
    ),
    // The dashboard's read: approved insights for a gate, newest first. Leads with the full grain
    // so the index answers the lookup the UI actually performs.
    index('insights_gate_status_idx').on(
      t.checkId,
      t.stat,
      t.statKind,
      t.threshold,
      t.status,
      t.createdAt,
    ),
    // The review queue's read: everything still pending, oldest first.
    index('insights_status_created_idx').on(t.status, t.createdAt),
  ],
);
