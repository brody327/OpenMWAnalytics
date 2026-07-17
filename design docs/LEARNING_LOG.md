# Learning Log

A running record of concepts taught and quiz results, so we can revisit weak spots.
Newest first.

## 2026-07-15 — Instrumentation model (`08`) — design discussion

**Concepts covered:** OpenMW **sandbox isolation** (no cross-script access, no
monkey-patching) as the constraint that shapes everything; **auto- vs manual-
instrumentation** (observe from outside via engine hooks/interfaces, vs. the code
emits its own events); the coverage split — built-in mechanics (skills via
`SkillProgression`, combat, crimes, dialogue, activation) are passively observable,
custom mod logic (puzzles, bespoke minigames) is opaque and must emit; `OMWA_Emit`
recognized as the manual-instrumentation seam we already built; the **"mod vs
platform"** shift (only third-party custom logic forces tracking code into the
other mod → OMWA becomes an SDK). **Decision:** keep the seam, defer the public SDK
(YAGNI); next event should exercise the auto path (`SkillProgression`). Recorded in
`08_INSTRUMENTATION.md`.

## 2026-07-15 — First real event `AreaEntered` (`03`): ✅ VERIFIED live

Defined the first product event in a new event registry (`03`) and instrumented it,
touching **zero pipeline code** — the generic transport absorbed a new `type` as
`02` promised. Verified in-game: walking recorded real areas
(`Fastus Retreat, Main House, Top Floor`; `west gash region`; etc.).

**Concepts covered / confirmed:**
- **Event registry = tracking plan** — governed vocabulary over generic transport.
- **Event grain / cardinality** — chose "meaningful area" (region outside / named
  cell inside) over per-cell; live data showed one clean `west gash region` row
  instead of `{gridX,gridY}` noise. Grain is a deliberate signal-vs-volume decision.
- **Global vs local script context** — detection must be player-side (`self.cell`);
  identity + the single `seq` stream stay global. Player script *forwards* via
  `core.sendGlobalEvent('OMWA_Emit', …)`; global `eventHandlers` calls `emit()`.
  Confirmed by interleaved `seq` (AreaEntered at 2,24,27,35,38; gaps = Heartbeats +
  no-change polls on one shared counter).
- **"first-seen emits immediately"** — seq 1 `SpikeStarted`, seq 2 first
  `AreaEntered` (starting area, `lastKey`=nil).
- **Deferred display-name polish** validated: `cell.region` returns a lowercase id
  (`west gash region`); prettifying belongs to the dashboard, not the emitter.

MVP ingest half now carries a real product event end-to-end. Next: `07_DASHBOARD.md`
(visualize `AreaEntered`).

## 2026-07-15 — Live loop test: ✅ VERIFIED end-to-end

Ran Postgres + API + `ship.mjs` + a real OpenMW launch. Real events landed in
Postgres: `SpikeStarted` (`data` jsonb `{"note":"ingestion spike online"}`) + a
live-climbing stream of `Heartbeat`s. The full game→log→shipper→API→Postgres loop
works. Evidence captured:

- **Envelope→storage mapping confirmed:** envelope fields → typed columns
  (`session_id, seq, install_id, type, v, ts, received_at`); payload → `data` jsonb.
- **Boundary conversion worked:** wire `ts` epoch-ms (`1784126811000`) → stored
  `timestamptz` UTC (`2026-07-15 14:46:51+00`). (Whole-second granularity because
  `os.time()*1000`.)
- **Event-time vs processing-time made concrete:** `received_at - ts ≈ 1.4s`
  steady lag = shipper 1s poll + processing. Two-timestamp model (doc `02`) observed.
- **Start-at-EOF tradeoff observed in the wild:** one session (`3199fdf3…`) has
  Heartbeats starting at `seq 9` and **no `SpikeStarted`** — the shipper attached at
  EOF mid-session and missed seq 1–8. The clean session (`c4435159…`) caught
  `seq 1` because truncation-detection reset it to the top of the fresh log.
- **Observability lesson (real):** the shipper's `console.log("sent N")` never
  appeared in its redirected output file — Node **block-buffers stdout** to a
  pipe/file (vs. line-buffered to a TTY). The pipeline was working the whole time;
  **ground truth was the database, not the process's stdout.** Don't trust a single
  signal — verify at the sink.

Still deferred (not needed for MVP): durable offset across restarts, retry/backoff.

## 2026-07-14 — Loop-closing shipper + real emitter (built, NOT yet live-tested)

**What we built:** the pieces that close the full game→log→shipper→API→Postgres
loop, in code — but we stopped **before running it live in-game**, so nothing has
been observed end-to-end yet. Pending next session.

- `shipper/ship.mjs` — real shipper (replaces print-only `tail-spike.mjs`): tails
  `openmw.log`, extracts `OMWA1` lines, and **POSTs batches to `/events`**. Has
  offset tracking + truncation detection (log is overwritten each launch), starts
  at EOF (ships only what happens after it starts), one batch POST per 1s poll.
  Deliberately *not yet*: durable offset across restarts, retry/backoff on failure.
- `scripts/omwanalytics/telemetry.lua` — emitter upgraded to the **real wire
  contract**: `snake_case` keys (`install_id`, `session_id`), `v:1`, `seq`, `ts`
  epoch-ms — envelopes the API actually accepts. (Header comment still says
  "spike/throwaway" — stale vs. the body; still emits `SpikeStarted` + `Heartbeat`.)

**Pending live test (the next step):** run OpenMW + `ship.mjs` + API together and
confirm a real event row lands in Postgres. Only then mark the loop verified.

**Not yet written:** `03_EVENT_REGISTRY.md` (real first events), `04_SHIPPER_DESIGN.md`.

---

## 2026-07-14 — Ingest API built (`05`) — build milestone

**What we built & ran:** Postgres 16 in Docker; `events` table via Drizzle;
Express 5 `POST /events` with Zod envelope validation + idempotent
`ON CONFLICT (session_id, seq) DO NOTHING`. Live test proved: dedup
(`duplicates:1`), new event type stored with zero DDL (`SkillCheckFailed` → jsonb),
bad uuid → 400, `ts` epoch-ms → `timestamptz` UTC.

**Concepts covered:** parse-don't-validate (Zod validates + narrows types at once);
`.returning()` on an upsert to *observe* dedup; convert-at-the-boundary; Express 5
async error forwarding; `drizzle-kit push` vs generated migrations.

**Milestone quiz: 2 / 2.** ✅ (type-safety begins after `safeParse`; duplicate count
= PK conflict + counting inserted rows.)

---

## 2026-07-14 — Data Model (`06`)

**Concepts covered:** immutable append-only event log; columns+JSONB vs
column-per-field / table-per-type / EAV; `jsonb` (binary, indexable); idempotent
upsert via `PRIMARY KEY (session_id, seq)` + `ON CONFLICT DO NOTHING`; convert-at-
the-boundary (epoch-ms wire → `timestamptz` UTC); denormalized single table +
derive `sessions` later; index-for-your-queries (defer GIN).

**Re-quiz (targeting prior gaps): 3 / 3.** ✅

| Q | Topic | Result |
| --- | --- | --- |
| 1 | Re-send after crash → PK conflict → DO NOTHING | ✅ |
| 2 | New event type needs zero DDL (fields in jsonb) | ✅ |
| 3 | Defer GIN until a query filters inside `data` | ✅ |

**Both 2026-07-14 envelope-quiz gaps (idempotency, storage mapping) are now
closed.** Also resolved open decision `02` §9(1): wire epoch-ms, store `timestamptz`.

---

## 2026-07-14 — Event Envelope (`02`)

**Concepts covered:** envelope/payload split; event-time vs processing-time
(`ts` vs `received_at`); at-least-once delivery + idempotency; dedup key
`(session_id, seq)`; generic transport vs governed vocabulary (tracking plan);
envelope versioning (`v`); "consumers ignore unknown fields".

**Checkpoint quiz: 2 / 4.**

| Q | Topic | Result |
| --- | --- | --- |
| 1 | Group calendar analytics by event-time (`ts`) | ✅ |
| 2 | What prevents duplicate rows under at-least-once | ❌ chose "order by ts"; answer: unique `(session_id, seq)` + upsert |
| 3 | Cost of adding a new event type | ❌ chose "add a column"; answer: nothing in pipeline — registry + emit only |
| 4 | Why transport accepts any `type` | ✅ |

**Diagnosed gap:** both misses reduce to one root concept — **how the
envelope/payload maps onto physical Postgres storage** (envelope → columns +
unique constraint + upsert; payload → JSONB). Q2 is the idempotency/uniqueness
mechanism; Q3 is the JSONB-keeps-schema-stable consequence.

**Action:** prioritize `06_DATA_MODEL.md` (storage strategy: columns vs JSONB,
the unique constraint, upsert/idempotent ingest) to solidify this before moving on.
Re-quiz on idempotency + storage mapping next session.
