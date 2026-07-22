# 06 — Data Model (Postgres)

**Status:** 🟡 in design. This doc turns the abstract envelope (`02`) into physical
rows. It answers: *what tables, what types, what keys, what indexes — and why.*

Prerequisite concept from `02`: envelope (universal fields) vs. payload (`data`,
type-specific). Here we map that split onto Postgres.

---

## 1. Guiding principle: an immutable event log

Events are **facts about the past** — "at time T, session S did X". Facts don't
change. So the events table is **append-only**: we `INSERT` (and dedup), we never
`UPDATE` or `DELETE` an event's meaning. Everything the dashboard shows —
counts, rates, funnels — is **derived** from this log by aggregation queries, not
stored as mutable state.

> **Why this matters:** an immutable log is the source of truth you can always
> recompute from. If we invent a new metric next month, we re-run a query over
> history — no data was thrown away or overwritten. This is the same instinct
> behind event sourcing and data warehousing: *store raw events, derive views.*

---

## 2. The core decision: columns for the envelope, JSONB for the payload

Four ways to store heterogeneous events. This is the decision your quiz Q3 probed.

| Approach | Idea | Verdict |
| --- | --- | --- |
| **Column per field** | One wide table; every possible field of every event type is its own column. | ❌ Column explosion, endless migrations, mostly-NULL rows. New event type = schema change. |
| **Table per event type** | `area_entered`, `skill_check_failed`, … each its own table. | ❌ Kills the generic platform. Cross-type questions ("funnel across 5 event types") become union/join nightmares. New type = new table + new pipeline branch. |
| **EAV** (entity-attribute-value) | A skinny `(event, key, value)` table; one row per field. | ❌ The classic anti-pattern. Every event reassembled via multiple self-joins; no types; unqueryable at scale. |
| **Columns + JSONB** | Envelope fields = real columns; payload = one `jsonb` column. | ✅ **Chosen.** |

**Why columns + JSONB wins:** the pipeline queries and indexes the **envelope
columns** (type, time, identity) without knowing what any event *means*; the
**variable** part lives in one flexible `jsonb` blob. New event type =
**zero DDL** — just a new registry entry and the mod emitting it. That is the
direct answer to Q3: adding `SkillCheckFailed` changes **nothing** in the schema.

> **Jargon:** `jsonb` is Postgres's *binary* JSON type — parsed, deduplicated keys,
> and **indexable** (unlike `json`, which is stored as text). Always `jsonb` for
> queryable payloads.

**The honest tradeoff:** JSONB gives up in-database schema enforcement — Postgres
won't stop a malformed `data`. We accept that and push validation to the **API**
(and document shapes in `03_EVENT_REGISTRY.md`). If a specific payload field
becomes hot (queried/filtered constantly), we can later **promote** it to a real
column or a generated column + index — without moving the other fields. Best of
both, on demand.

---

## 3. The v1 schema

```sql
CREATE TABLE events (
    session_id   uuid        NOT NULL,     -- envelope: per-launch identity
    seq          integer     NOT NULL,     -- envelope: per-session monotonic counter
    install_id   uuid        NOT NULL,     -- envelope: persistent identity (denormalized, see §6)
    type         text        NOT NULL,     -- envelope: event discriminator
    v            smallint    NOT NULL,     -- envelope: envelope schema version
    ts           timestamptz NOT NULL,     -- event time  (when it happened, game clock) — see §5
    received_at  timestamptz NOT NULL DEFAULT now(),  -- processing time (when we ingested)
    env          text        NOT NULL DEFAULT 'prod', -- ingest provenance: 'dev' | 'prod'
    data         jsonb       NOT NULL DEFAULT '{}',    -- payload: type-specific body

    PRIMARY KEY (session_id, seq)          -- natural key = dedup key (see §4)
);
```

### `env` — separating the author from real players (added 2026-07-20)

**`'dev'` = the mod author's machine. `'prod'` = a genuine third-party player.**

**The boundary is the SOURCE, not the intent** (corrected 2026-07-20 after the first
framing was pushed back on). The first version defined `dev` as "the author *testing*" —
repeating a check twenty times, deliberately failing a confrontation to see the branch — and
`prod` as the author playing normally. That is wrong, for two reasons:

1. **Author data is unrepresentative however carefully it is played.** You know the
   solution, you know which evidence matters, you know where the vents are. You cannot be a
   naive player of your own mystery. A "natural" authored playthrough is a marginally better
   proxy than deliberate spam — still a weak one, and it does not belong in the set that
   means *real*.
2. **Intent cannot be recorded reliably.** It would require judging your own mindset
   mid-session. Source is a property of the machine: set once, impossible to get wrong.

So while the author is the only user, **every** event is `'dev'`. The column carries no
information *today* — and is still worth having, because the moment a third party plays it
becomes the difference between a dataset you can trust and one you cannot, and it cannot be
added retroactively.

The original motivation still holds: authoring traffic is **instrumentation-shaped, not
behaviour-shaped**, and counting it as player behaviour is how a dashboard confidently
reports something nobody actually did — which happened here, when a deliberate probe was
read as a genuine player error.

**Why it is NOT in the event envelope (`02`):** the envelope is what the *emitter* asserts
about an event, and the Lua emitter cannot know whose machine it is running on — baking a
value in would ship as whatever was left in the file. The **shipper** knows, and what it
knows is a property of the *collection run*, not of any single event. So it is **ingest
metadata**, stamped server-side from a per-batch `X-OMWA-Env` header — the same category as
`received_at`, which the API already stamps.

**Why it defaults to `'prod'`:** the default is written for the *distributed* case — a
player's shipper needs no configuration to be labelled correctly. The **author's** machine
overrides it once, in `shipper/.env` (`OMWA_ENV=dev`), and every session from that machine
is then marked without further thought. An unrecognised header value also falls back to
`'prod'` rather than erroring: a mislabelled batch should still be collected.

⚠️ Both the token **and** `OMWA_ENV` are read from `shipper/.env`, not just the token — the
Scheduled Task runs with a bare environment, so anything sourced only from the process
environment silently reverts to its default at every logon. That would have quietly stamped
the author's own sessions `'prod'`.

**Not retrofittable.** Rows collected before this column existed cannot be classified after
the fact; all 1,146 pre-existing rows were authoring traffic and were marked `'dev'` in one
statement. That is the whole argument for adding the dimension *early* — the cost of
omitting it is paid permanently, in data you can never separate.

**Consumers do not filter on it yet**, because there is no player data to separate. When
real sessions arrive, `/stats/*` should default to `env = 'prod'` and expose dev deliberately.

Field rationale in brief: envelope fields become **columns** because we filter,
group, and join on them (time series, per-type, per-install). `data` stays a blob
because its shape varies. `NOT NULL` everywhere on the envelope — a telemetry event
missing its identity or type is corrupt, and we'd rather reject than store garbage.

---

## 4. Idempotent ingest (closing quiz Q2)

The primary key **is** the dedup key from `02` §4: `(session_id, seq)`. A composite
PK is a **uniqueness constraint** — Postgres physically refuses a second row with
the same pair. Ingest is an **upsert**:

```sql
INSERT INTO events (session_id, seq, install_id, type, v, ts, received_at, data)
VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
ON CONFLICT (session_id, seq) DO NOTHING;
```

Now the shipper re-sending a line after a crash is a **no-op** — the second insert
hits the conflict and does nothing. This is what makes **at-least-once delivery
safe**: the shipper guarantees *≥1*, the DB constraint collapses duplicates to
*exactly-one* stored. Delivery guarantee + idempotent write = the two halves.

> **Why not a surrogate key** (`id bigserial PRIMARY KEY`)? We could, then put a
> `UNIQUE (session_id, seq)` alongside. But events are append-only and we rarely
> reference one event by an opaque id, so the natural composite key carries its
> weight *and* expresses real identity. We revisit if we ever need stable
> single-row references (e.g. FKs pointing at individual events).

---

## 5. Time at the storage boundary

The wire carries `ts` as **epoch milliseconds** (an integer — language-neutral, no
timezone ambiguity, trivial for Lua/JS). At the **API boundary we convert** to
Postgres `timestamptz` and store **UTC**.

**Why convert instead of storing the raw bigint?**
- `timestamptz` unlocks Postgres's date machinery: `date_trunc('day', ts)`,
  interval math, range filters, `generate_series` for gap-filling charts.
- `timestamptz` is timezone-aware and normalizes to UTC on store, sidestepping the
  naive-`timestamp` trap (two events an hour apart across a DST change).
- We render to the viewer's timezone at the **dashboard** edge, never in storage.

This also **resolves open decision `02` §9(1):** wire = epoch **ms**; storage =
`timestamptz` (µs precision), so "ms vs s on the wire" stops mattering downstream —
we simply capture the best resolution the game gives and store it losslessly.

> **Pattern to remember:** *convert at the boundary.* Transport uses a neutral,
> dumb representation (epoch int); the moment data enters a system that has richer
> types, upgrade it. Same idea will apply to the dashboard boundary in reverse.

---

## 6. Normalization: one table now, derive the rest

Should `install_id` (and future session attributes like start/end time) live in
separate `installs` / `sessions` tables with foreign keys?

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Single `events` table** (chosen) | Simple; events are self-contained (robust under at-least-once & log truncation); no insert-order dependency between tables. | `install_id` repeats on every row (cheap redundancy). |
| **B. Normalized `installs`/`sessions`/`events`** | No repetition; natural home for session-level attributes. | A `sessions` row must exist before its events → ordering/foreign-key dependency, which fights our "every event is self-contained" robustness goal. |

**Decision:** single denormalized `events` table for MVP. The repetition is a few
bytes; the robustness (any event stands alone) is worth more. When we genuinely
need **session-level attributes** (duration, start/end, "where did they quit"),
we **derive** a `sessions` view — likely a materialized view — from the log rather
than maintaining a second write path. *Derive, don't duplicate the write.*

---

## 7. Indexing strategy — index for your queries, not by reflex

Every index speeds reads but **taxes every write** and costs storage. So we add
indexes to match real query patterns, not preemptively.

| Index | Serves | When |
| --- | --- | --- |
| `PRIMARY KEY (session_id, seq)` | dedup + "replay this session in order" | now (free with PK) |
| `(type, ts)` | "count `QuestCompleted` per day" — the bread-and-butter analytics shape | now |
| `(install_id)` | per-player rollups | when we build install-level views |
| **GIN** on `data` | containment queries into the payload (`data @> '{"cell":"Balmora"}'`) | **deferred** — only when a dashboard query actually filters inside `data` |

> **Why defer the GIN index:** it's the big, write-heavy one, and until a query
> filters on JSONB contents it earns nothing. "Do not optimize prematurely" =
> don't pay write cost for reads no one is doing yet.

---

## 8. Scale, deferred on purpose

Not MVP — noted so we know the growth path exists and we're not designing into a
corner:

- **Time partitioning:** declarative partitioning of `events` by `ts` (monthly)
  when volume gets large — keeps indexes small and makes retention a `DROP
  PARTITION`.
- **Rollups / continuous aggregates:** pre-computed daily counts for fast
  dashboards over long ranges (hand-rolled materialized views, or TimescaleDB if we
  ever justify the dependency).
- **Retention:** raw events age out; rollups persist.

None of this is built now. The single append-only table + upsert is the whole MVP.

---

## 9. Open decisions

1. **ORM & migrations tooling** — Drizzle (preferred in the brief) vs Prisma vs raw
   SQL. Affects how §3's schema is expressed and evolved. Belongs to `05_API_DESIGN.md`.
2. **`data` validation strictness at the API** — reject unknown event types, or
   accept-and-store-anything (generic)? Leaning: accept any `type`, but validate the
   envelope hard; optionally warn on unregistered types.
3. **Numeric types in `data`** — floats vs ints inside JSONB (JSON numbers are
   doubles). Note for the registry when payloads carry stats.

---

## 10. Check your understanding

Interactive re-quiz follows (targets the two prior gaps: idempotency and storage
mapping, plus JSONB reasoning). Results → `LEARNING_LOG.md`.

---

## Performance baseline (2026-07-20) — before any tuning

Postgres performance work needs volume before it means anything: over ~100 real rows every
plan is a sequential scan and correctly so. `api/scripts/generate-load.mjs` generates
realistic synthetic volume (`env='synthetic'`, **local database only**, refuses a non-local
`DATABASE_URL`).

**Why the distribution matters more than the row count.** Uniform random data teaches the
wrong lessons: index selectivity depends on cardinality and skew, so if every value appears
equally often then every index looks equally good, planner estimates are trivially right,
and the cases that actually matter — a partial index, a composite column *order*, a matview
that beats a live aggregate — never arise. The generator models sessions-per-install as a
power law, events-per-session log-normally, payload values Zipf, and the type mix measured
from real data.

**Dataset:** 1,000,000 synthetic events · 9,245 sessions · 2,000 installs · 180 days ·
seeded (`--seed 42`, reproducible) · written in **15.7 s** (~64k rows/s) via a single
`unnest()`-based parameterised INSERT per batch. Table: **355 MB total / 233 MB heap**.
Session sizes p50 **60**, p90 **239**, p99 **744**, max **4000**. Record-level skew
confirmed: 116k / 43k / 32k / 27k across the hot checks.

### Endpoint latency at 1M rows

| Endpoint | Time |
| --- | --- |
| `/stats/confrontations` | 0.31 s |
| `/stats/skills` | 1.10 s |
| `/stats/friction` | **1.42 s** |

### What the plans say (the tuning targets)

**`/stats/confrontations` — 119 ms in-database.** The `(type, ts)` index *is* used (Bitmap
Index Scan → 130k rows), but the aggregate groups on `data->>'suspect'` / `data->>'topic'`,
which the index cannot supply — so it pays a **Bitmap Heap Scan of 29,555 heap blocks**
(26,080 of them physical reads). The index finds the rows; the heap visit dominates.
Candidates: expression indexes on the extracted keys, a covering index (`INCLUDE`), a
partial index on the hot `type`, or a rollup.

**`/stats/friction` — the expensive one, and a different problem.** Its filter is
`type NOT IN ('Heartbeat','SpikeStarted')`, which matches nearly every row, so there is
nothing to be selective about: the planner takes a **Parallel Seq Scan over all 1M rows**,
then windows and filters afterwards. Note the ordering the window needs —
`PARTITION BY session_id ORDER BY seq` — is *exactly* the primary key order, which a plan
could exploit to avoid a sort. That gap between "the order exists" and "the planner used
it" is the interesting part.

⚠️ Synthetic rows never leave the local database, and `/stats/*` does not filter on `env`
yet — so **local dashboard numbers are currently synthetic**, while production remains
real. Do not read one as the other.

---

## Tuning round 1 — the confrontations aggregate (2026-07-21)

**Result: 29,670 buffers → 116. ~90 ms → ~7 ms warm. Endpoint 0.31 s → 0.15 s.**

### What we tried, and what each attempt taught

**1. Warm the cache before measuring anything.** First run 3,900 ms, second 111 ms, third
87 ms — same query, same plan. The first paid for physical reads; the rest hit
`shared_buffers`. **Tuning against a cold cache measures the disk, not the plan.** Every
number below is warm and repeated.

**2. Partial expression index** — `((data->>'suspect'), (data->>'topic')) WHERE type = …`.
Tiny (928 kB vs 62 MB for the full type index — the partial predicate paying off) and the
planner used it. **Almost no improvement.** Still a 29,555-block Bitmap Heap Scan.

**3. `VACUUM` — ruled out as the cause.** Index-only scans need the visibility map; after a
bulk load it can be empty. Checked: `relallvisible` was already **100%**. Not the blocker.

**4. Forcing the planner's hand** (`SET enable_bitmapscan = off`) — a plain Index Scan
costing **113,690 buffers**, four times *worse* than the bitmap plan. **The planner's choice
was correct.** Disabling a plan type to see the alternative is a diagnostic, not a fix.

**5. The actual cause, isolated by shrinking the query.** On the *same index*:

| Query | Plan |
| --- | --- |
| `count(*) WHERE type = …` | **Index Only Scan**, `Heap Fetches: 0`, 116 buffers |
| `SELECT data->>'suspect' … GROUP BY 1` | Bitmap Heap Scan, 29,670 buffers |

⭐ **Postgres can use an expression index to FILTER, ORDER and COUNT — but it cannot RETURN
an expression's value from an index-only scan.** The computed value is in the index; the
planner will not reconstruct output columns from expression entries. Need the value → fetch
the row. Our query *outputs* those expressions, so the index could never have helped.

> ⚠️ **Correction (2026-07-21, re-measured on PG16 — see "Tuning round 2" below).** The
> sharper, verified statement is: **an expression index does not support an index-only scan at
> all** — not even for `count(*)`. Forcing the planner (`enable_bitmapscan = off;
> enable_seqscan = off`) still produced a plain, heap-touching Index Scan, never an Index Only
> Scan. A plain index over a **stored generated column** *does* get an index-only scan (Heap
> Fetches: 0) for both counting and returning the value. Same conclusion — materialise the
> expression — cleaner mechanism. The "116 buffers" figure below was a count-only query; the
> real byTopic aggregate also reads `passed`, so it was never index-only until `passed` was
> promoted too (round 2).

**6. The fix — stored generated columns**, exactly as §2 anticipated ("promote a hot payload
field to a real column or a generated column + index"):

```sql
ALTER TABLE events
  ADD COLUMN suspect text GENERATED ALWAYS AS (data->>'suspect') STORED,
  ADD COLUMN topic   text GENERATED ALWAYS AS (data->>'topic')   STORED;
CREATE INDEX events_confrontation_cols_idx ON events (suspect, topic)
  WHERE type = 'ConfrontationAttempted';
```

`GENERATED ALWAYS … STORED` rather than a plain column so the value **cannot drift** from
`data` — Postgres recomputes it on write and nothing can set it inconsistently.

New plan: **Index Only Scan, `Heap Fetches: 0`, 116 buffers**, and `HashAggregate` becomes
`GroupAggregate` — the index returns rows pre-sorted by `(suspect, topic)`, so no 793 kB hash
table is built. The ordering came free with the index.

### Why the endpoint only doubled while the query got 13× faster

`/stats/confrontations` runs **two** queries and the response waits for both. `byReason`
still extracts `data->>'reason'` over every failed attempt. **A response is bounded by its
slowest part** — optimising one of two caps the achievable gain. The next round either
promotes `reason` too or rolls the whole endpoint into one precomputed result.

---

## Tuning round 2 — finish both queries (2026-07-21, later)

**Result: the endpoint moved ~7× (≈148 ms → ≈21 ms warm), because BOTH queries were made
index-only — not just one.** This is the concrete payoff of "bounded by its slowest part."

Two more hot keys promoted to stored generated columns: `reason` (text) and `passed`
(boolean — cast at generation, so the value not the `'true'/'false'` text is stored/indexed).
Two partial indexes, both `WHERE type = 'ConfrontationAttempted'`:

| Index | Serves | Why the column order |
| --- | --- | --- |
| `events_confrontation_reason_idx (passed, reason)` | `byReason` (`WHERE not passed GROUP BY reason`) | leading `passed` seeks the failed rows; `reason` rides along for the group |
| `events_confrontation_cols_idx (suspect, topic, passed)` | `byTopic` (adds `passed` for `passes`/`pass_rate`) | `(suspect, topic)` first keeps the stream ordered for GROUP BY; `passed` trails |

Reproduced, warm-to-warm, `EXPLAIN (ANALYZE, BUFFERS)`:

| Query | Before | After |
| --- | --- | --- |
| `byReason` | Bitmap Heap Scan, HashAggregate, **31,106 buffers, ~91 ms** | **Index Only Scan, GroupAggregate, 85 buffers, ~7 ms** |
| `byTopic`  | Parallel Bitmap Heap Scan, HashAggregate, **31,345 buffers, ~59 ms** | **Parallel Index Only Scan, GroupAggregate, 118 buffers, ~14 ms** |

Both went `Heap Fetches: 0` and `HashAggregate → GroupAggregate` (the index supplies sorted
input, so no hash table). ⚠️ **The read side must reference the generated columns** (`passed`,
`reason`), not `data->>'…'`, or the planner won't use these indexes — updated in
`confrontations.ts`.

⚠️ **VACUUM gotcha, observed live.** Adding a `STORED` column **rewrites the table**, which
resets the visibility map — so immediately after the push `byReason` was *still* a Bitmap Heap
Scan (the planner declines index-only while the VM is cold). `VACUUM ANALYZE events` flipped it
to the Index Only Scan above. (Contrast round 1 step 3, where `relallvisible` happened to be
100% already — a rewrite is exactly when it is not.)

**Design tradeoff, restated:** `events` is an analytics table — read-hot, write-tolerant (batched
telemetry ingest) — so materialising these keys is justified. A field that were write-hot and
read-rarely would not clear that bar; leave it in `data`. `/stats/friction` (filter matches ~99%
of rows — no index can help) remains the case for a precomputed **rollup**, not more columns.

### ⚠️ Migration cost, if this ever goes to RDS

`ADD COLUMN … GENERATED … STORED` **rewrites the table** and holds an `ACCESS EXCLUSIVE`
lock — 3.3 s here on 1M rows, i.e. 3.3 s of hard downtime for anything writing. On a live
production table the safe path is different: add a plain nullable column, backfill in
batches, add the index `CONCURRENTLY`, then swap reads. The local one-liner is a
development convenience, not a production migration plan.

### Cost side, stated honestly

Two extra stored columns widen every row, and `events_confrontation_cols_idx` is another
structure to maintain on every insert — **every index is a tax on writes**. The partial
predicate keeps that tax proportional: 928 kB covering 13% of rows, not 62 MB covering all
of them.

---

## Tuning round 3 — the friction rollup, when indexes cannot help (2026-07-21, later)

**Result: `/stats/friction.afterFailure` 776 ms / ~62k buffers -> ~0.3 ms / 9 buffers (~2,700x),
via an incremental precomputed rollup. The read is a Seq Scan over 239 rows -- correct, because
on a tiny table a seq scan wins (round-1 step 1, restated).**

### Why no index can help (the categorical difference)

`afterFailure` is a `LEAD` **window function** over the whole `(session_id, seq)` stream. The plan
reads all 1,000,092 rows through the PK into a `WindowAgg`, even though only ~97k are failures --
because each failure's answer lives in a DIFFERENT row (the next event). An index narrows
**row-local** work (filters, GROUP BY -- the answer is inside the row). It cannot narrow a
computation that depends on row **adjacency/ordering**: `LEAD`, `LAG`, `ROW_NUMBER`, running
totals. The `WHERE not passed` that made `byReason` index-only is still here, but it runs *after*
the window (pushing it down would make `LEAD` see "next failure", not "next event").

### Why precomputation is the right tool

`events` is append-only + immutable and the window is **partitioned by `session_id`**. Each launch
mints a fresh `session_id`, so once a session stops receiving events its partition is **frozen** --
no future event changes any of its `LEAD` results. The historical answer never changes;
recomputing it on every dashboard load is waste. Precompute per session, once.

### The three pieces (`stats/frictionRollup.ts`; tables in `schema.ts`)

```
friction_rollup          -- (suspect, topic, next_action) -> count, gap_count, sum_gap_seconds
friction_sessions_done   -- session_id guard: fold each settled session EXACTLY once
refreshFrictionRollup()  -- fold newly-settled sessions, in ONE transaction
```

**Two load-bearing rules:**

1. **Decomposable aggregates only.** Store `count`, `gap_count`, `sum_gap_seconds`; derive
   `avg = sum/gap_count` at read. You cannot average averages, and `AVG` ignores NULL gaps
   (`session_end` has none) so its denominator is `gap_count` (non-null), not `count`. Percentiles
   / `COUNT DISTINCT` do NOT decompose -- a rollup can't do them without approximation.
2. **Watermark with allowed lateness.** A session is *settled* once its newest event was received
   `> lateness` ago (default 10 min > worst-case shipper lag). The pipeline is **asynchronous**, so
   "no events yet" != "no more events ever" -- even an explicit SessionEnded event (a good future
   optimisation) is just another event under the same lag, so the time-based watermark is
   unavoidable, not a workaround. The rollup **deliberately excludes the currently-active session**
   (its buckets would be provisional).

**Correctness chain:** settled -> frozen partition -> final `LEAD` -> folded in exactly once (the
done-guard) -> `friction_rollup` == the full query restricted to settled sessions.

### Proven, not asserted

- **Correctness:** symmetric `EXCEPT` diff of rollup-vs-live = **0 / 0** (identical output).
- **Idempotency:** first run folded 9,255 sessions in 3.1 s; second run folded **0** in 103 ms,
  buckets unchanged. Without the done-guard the second run re-adds all 9,255 and doubles every count.
- **First run pays the full cost once** (3.1 s); steady state is O(new settled sessions).

---

## Tuning round 4 — `attemptsToPass`, and why GRAIN is the real decision (2026-07-22)

**Result: `/stats/friction.attemptsToPass` ~324 ms / ~31.5k buffers -> ~11.5 ms / 631 buffers
(~28x). With both queries rolled up, the ENDPOINT goes ~1,100 ms -> ~14 ms (~78x)** — the
"a response is bounded by its slowest part" lesson landing a second time: round 3 fixed one of the
two queries and the endpoint stayed pinned at ~330 ms until this one moved.

### The same problem, a different grain

`attemptsToPass` is a `ROW_NUMBER` window — identical neighbour-dependence, identical "no index can
help" argument as round 3. What is NOT identical is what we store. The original query has a
`per_session` CTE (one row per `session_id, suspect, topic`) that the final `SELECT` then collapses.
Either level can be the rollup:

| | **A — collapsed** `(suspect, topic)` | **B — per-session** `(session_id, suspect, topic)` ✅ chosen |
| --- | --- | --- |
| Rows stored | 35 | 72,255 |
| Read | direct select, ~0.3 ms | `GROUP BY`, ~11.5 ms |
| Fold | additive (`count + excluded.count`) | plain insert, `ON CONFLICT DO NOTHING` |
| Double-fold guard | needs `friction_sessions_done` | **free** — natural key collides with itself |
| median / p90 / histogram | **impossible, permanently** | computable at read |
| `max` | stored; repairable only by full recompute | recomputed from retained rows |

**Why B.** Three reasons, in ascending order of importance:

1. **Idempotent by construction.** `(session_id, suspect, topic)` is a real natural key, so a repeat
   fold collides and `DO NOTHING` absorbs it — the same mechanism `events` ingest uses. An additive
   fold cannot self-guard: "add 3 to this bucket" is indistinguishable from "this bucket is already
   right". (The watermark is still load-bearing — an unsettled session would insert a *provisional*
   `attempts_to_pass`, and `DO NOTHING` would then cement it forever.)
2. **`max` is associative but NOT invertible.** `sum`/`count` can be *subtracted*, so a
   wrongly-folded session can be repaired surgically in place. You cannot un-`max`: a stored max
   doesn't know what the runner-up was, so its only repair is a full recompute from `events` — the
   exact work the rollup exists to avoid. This is not hypothetical here: 1M synthetic
   (`env='synthetic'`) rows share the table and `/stats/*` does not filter `env`.
3. **Non-decomposable aggregates stay possible.** median-of-medians != median, and unlike `avg`
   there is no set of stored summaries that recovers it; same for percentiles and `COUNT DISTINCT`.
   They are computable under B only because the per-session values survive.

**The general rule this yields — an upgrade to round 3's rule 1:** "store decomposable aggregates"
is really a special case of **never collapse past the grain that retains an aggregate's inputs.**
Coarser is smaller and faster; finer answers questions you have not thought of yet. And the
asymmetry decides ties: a fine grain can always be collapsed later, a collapsed one can never be
un-collapsed.

**The cost, stated honestly:** B is 40x slower to read than A would be (11.5 ms vs ~0.3 ms) and
stores 2,000x more rows. On a 324 ms query that is a good trade; if the table grows 100x it is worth
revisiting.

### Read plan (and why it is correct)

`Seq Scan (72,255 rows, 631 buffers) -> HashAggregate -> Sort`, ~11.5 ms. **No index would help**:
the query has no `WHERE`, so it needs 100% of the rows, and an index scan over all of them is
strictly worse than physical order. Note the reason is **selectivity, not adjacency** — there is no
window function in the read query at all any more; that work moved to fold time.

### Implementation

`friction_attempts_rollup` (schema.ts) is folded inside `refreshFrictionRollup()` from the **same
`_settled` set in the same transaction** as `friction_rollup`, so the two can never disagree about
which sessions they cover and one done-guard row covers both. `attempts_to_pass` is **nullable —
NULL means "never solved in this session"**; `count(attempts_to_pass)` at read therefore counts only
solving sessions, and `solved=0 with attempts>0` remains the unpassable-content signal (doc 10 Q1.6).
Storing `0` would destroy that distinction.

### Proven, not asserted

- **`attemptsToPass` correctness:** symmetric `EXCEPT` rollup-vs-live = **0 / 0**.
- **Fold determinism (bonus):** the guard + both rollups were truncated and rebuilt from `events`
  from scratch; `friction_rollup` came back **0 / 0** against its previously-verified state. So
  "recompute from source" is always available as a repair.
- **Idempotency:** re-run folded **0** sessions; all row counts and totals unchanged.
- Full backfill of both rollups: 9,255 sessions in **1.46 s**, one transaction.

### Deferred

1. ~~**Scheduling** `refreshFrictionRollup()`.~~ **DONE 2026-07-22** -> see "Scheduling the fold"
   below.
2. **Enhancement:** emit a `SessionEnded` event to settle clean exits sooner (still needs the
   watermark for crashes/alt-F4 and shipper lateness).
3. ~~**Analytics question (doc 10):** cross-session comeback.~~ **RESOLVED 2026-07-22 -> doc 10
   Q1.7.** Measured **set-based** (an install has both an unsolved and a solved session for a
   topic), NOT as an `install_id`-partitioned window. The ordered version would break the rollup
   correctness argument above -- partition by `install_id` and a new session can change a prior
   partition's answer, so no partition is ever frozen and the incremental fold is invalid. The
   set-based version aggregates **at read time over `friction_attempts_rollup`**, whose rows are
   per-session and individually frozen, so it costs the rollup nothing. It is answerable only
   because round 4 declined to collapse the session dimension. **`install_id` added to
   `friction_attempts_rollup` + back-folded 2026-07-22** (values unchanged, `EXCEPT` 0/0, 0
   mismatches vs `events`); the query is proven, only the dashboard view remains.

---

## Scheduling the fold (2026-07-22)

A precomputed rollup is only as good as whatever keeps it current. `k8s/cronjob-friction-rollup.yaml`
runs `node dist/jobs/refreshFriction.js` **every 5 minutes**, using the same image as the API.

### Why a CronJob, not `setInterval` and not `pg_cron`

| | `setInterval` in the API | `pg_cron` in RDS | **k8s CronJob** ✅ |
| --- | --- | --- | --- |
| Runs the existing TypeScript fold | ✅ | ❌ reimplement in plpgsql | ✅ same image |
| Survives an API deploy | ❌ restarts with the pod | ✅ | ✅ |
| With N API replicas | **N schedulers** | 1 | 1 |
| Failure visibility | a log line | `cron.job_run_details` | `kubectl get jobs` + backoff |

The decisive argument against `pg_cron` is **not** the RDS parameter-group reboot. The fold's
`CASE` ladder has a documented sync requirement with `stats/friction.ts`; porting it to plpgsql
moves that logic where `tsc`, CI and code review cannot see it, and makes migrations the deploy
path. **Logic in two languages is a worse problem than scheduling in two places.**

### Cadence is constrained by the watermark, not free choice

End-to-end staleness = **allowed lateness (10 min) + up to one interval**. A session that goes
quiet at 12:00 settles at 12:10 and appears by ~12:15. Running faster than the watermark buys
nothing — nothing can settle sooner than it allows.

⚠️ **Freshness regression, stated honestly.** Before the rollup, `/stats/friction` read `events`
live, so a session showed up *immediately*. It now lags ~10–15 min and the **currently-active
session is excluded by design**. For a mod-developer tool whose main use is "I just played, what
did that look like?", that is a real downgrade traded for the 78x. The proper fix is a **hybrid
read** — serve settled sessions from the rollup and `UNION` the live query restricted to the few
unsettled ones — not a faster cron. Deferred, but this is the reason not to slow the cadence down.

### Concurrency: two rollups, two different reasons for safety

`frictionRollup.ts` takes a **transaction-scoped advisory lock** (`pg_advisory_xact_lock`) —
an application-defined mutex released automatically on commit *or* rollback. It locks nothing
physical; the key just has to be agreed by every caller.

It is a *tidiness* fix, not a correctness one, and the distinction matters:

- **`friction_attempts_rollup` is safe on its own merits** — natural key + `ON CONFLICT DO NOTHING`.
- **`friction_rollup` is not.** Two concurrent folds BOTH add into it (`count + excluded.count`
  on an already-committed row cannot tell "already folded" from "fold me"). What undoes the
  double-count is the **done-guard insert raising a unique violation and rolling the whole
  single transaction back**.

⚠️ **Therefore the missing `ON CONFLICT` on the done-guard insert is load-bearing, not an
oversight.** Adding `DO NOTHING` there looks like a defensive tidy-up and would silently corrupt
the rollup: the doubling would commit, every bucket permanently inflated, no error raised, numbers
that still look plausible. There is a `⚠️ DO NOT ADD` comment in the code saying so.

The advisory lock's contribution is to make the second run **wait and then do nothing** rather
than crash — quiet instead of a unique-violation stack trace plus a wasted fold.

**Proven:** three concurrent folds against a truncated rollup — one folded 9,255 sessions, the
other two blocked for its duration then folded 0; symmetric `EXCEPT` vs. the pre-truncate state
= **0 / 0**, no errors.

### The runner lives in `src/`, not `scripts/` — deliberately

The Dockerfile's runtime stage copies **only `dist/`**. The original `scripts/refresh-friction.mjs`
was therefore absent from the image, and the CronJob would have died with `MODULE_NOT_FOUND` on
every tick — caught by reading the Dockerfile rather than trusting the manifest. It is now
`src/jobs/refreshFriction.ts`, compiled into `dist/`, so local dev and the cluster run the
identical artifact and the entrypoint is type-checked. It exits non-zero on failure so the Job is
marked FAILED and surfaces in `kubectl get jobs` instead of hiding in a pod log.

---

## Tuning round 5 — the hybrid read: paying back the freshness regression (2026-07-22)

Rounds 3–4 bought ~78x by reading precomputed tables — and quietly broke the thing the dashboard
is *for*. The rollup covers only settled, folded sessions, so the session you just played was
invisible for 10–15 minutes. For a mod-developer tool whose main use is *"I just played, what did
that look like?"*, that is a bad trade.

**The fix: answer each query in two halves and combine.**

```
folded sessions  ->  friction_rollup / friction_attempts_rollup   (precomputed, instant)
everything else  ->  the original window query                    (live, a handful of sessions)
```

### The split key is the done-guard, not the watermark

Splitting on *settled vs unsettled* leaves a **gap**: a session that has settled but has not yet
been folded is excluded from the live half AND absent from the rollup, so it briefly
**disappears** — worse than being stale, because the number silently shrinks. Splitting on
*folded vs not folded* is exhaustive by construction: every session is in exactly one half.

A useful consequence: **the fold is now purely an optimisation.** Correctness no longer depends
on it having run — a dead cron makes the endpoint slower, not wrong.

### Why filtering the live half is safe here (and was a trap before)

Both queries `PARTITION BY session_id`, so restricting the live half to a set of whole **sessions**
cannot change any other session's result. Contrast the original trap: filtering to failures before
the window *would* change it, because that filters **rows within** a partition. **Filtering whole
partitions is safe; filtering rows is not.**

### The decomposable-aggregate rule is what makes it possible

The halves are merged with `UNION ALL` and re-aggregated — `sum`s and `count`s add across halves,
and `avg` is derived once at the end from the combined totals. Had we stored `avg_gap_seconds`
directly, **the halves could not be merged at all.** Round 3's rule turned out to be load-bearing
for a feature it was not written for.

Likewise the per-session grain (round 4): `attemptsToPass`'s live half produces rows of exactly
the rollup's shape, so the two just stack and the existing aggregation runs over the union
unchanged. Under a collapsed Option A rollup, `max` would still merge but `avg_attempts_to_pass`
could not — the sum+count it needs would never have been stored.

### Cost, and the index it needed

The naive "which sessions are unfolded?" (`select distinct session_id from events` anti-joined
against the guard) cost **653 ms** — Postgres has no skip-scan, so it walks all 1M PK index
entries, more than the query the rollup replaced. Bounding the candidate set by **processing
time** (`received_at`, not client-supplied `ts`) plus `events_received_at_idx` fixes it.

`LIVE_WINDOW` (default 30 min, env-tunable) is ~2x the normal fold latency (10 min watermark +
5 min cron). ⚠️ If the fold is dead longer than that, sessions older than the window fall into
neither half — so the response carries `coverage.fold_stale_seconds` and `coverage.live_sessions`,
making a stalled fold **visible instead of a silent hole**.

**Endpoint: ~14 ms -> ~19 ms**, and now always current. Paying 5 ms to stop lying about the last
15 minutes is the right trade.

### Proven in all three modes (identical output, not "looks right")

| Mode | live sessions | result |
| --- | --- | --- |
| 100% folded | 0 | baseline |
| 100% live (rollups truncated) | 9,255 | **identical to baseline** |
| **mixed** (9,255 folded + 1 fresh session) | 1 | **identical to a full live recompute** |

The mixed case is the one that matters — it is the only one where a double-count or a dropped
session could hide, and it is the state production is always in.
