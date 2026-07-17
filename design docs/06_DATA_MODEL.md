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
    data         jsonb       NOT NULL DEFAULT '{}',    -- payload: type-specific body

    PRIMARY KEY (session_id, seq)          -- natural key = dedup key (see §4)
);
```

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
