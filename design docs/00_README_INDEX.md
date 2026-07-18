# OpenMW Analytics — Design Docs Index

The modular design bible for the OpenMW Analytics platform. These are the active
source documents; day-to-day work targets the relevant module. Every doc is
written in **teaching style** (Why / How / Tradeoffs) — this is a learning project.

## File map

| File | Purpose | Status |
| --- | --- | --- |
| `00_README_INDEX.md` | This index + source-of-truth rules. | living |
| `01_ARCHITECTURE_OVERVIEW.md` | The end-to-end pipeline, components, and what has been validated. | ✅ ingestion validated |
| `02_EVENT_ENVELOPE.md` | The event envelope contract: universal metadata vs. event-specific payload, time model, versioning, delivery/ordering guarantees. **The foundational contract.** | 🟡 in design |
| `03_EVENT_REGISTRY.md` | Catalog of canonical event `type`s and their `data` shapes (the "tracking plan"). | 🟢 first real event (`AreaEntered`) defined + verified live |
| `04_SHIPPER_DESIGN.md` | The Node log-tailing shipper: offset tracking, truncation handling, batching, retries, at-least-once. | ✅ reliability pass done 2026-07-18 (durable offset, relaunch detection, at-least-once); doc written |
| `05_API_DESIGN.md` | Ingestion + query REST API (Node/TS): stack, endpoints, validation, versioning. | ✅ ingest built + tested |
| `06_DATA_MODEL.md` | Postgres schema, event storage strategy (JSONB vs columns), idempotent upsert, indexing. | ✅ implemented |
| `07_DASHBOARD.md` | React/Next dashboard: the question-answering views. | ⬜ not started |
| `08_INSTRUMENTATION.md` | How mechanics become events: sandbox isolation, auto- vs manual-instrumentation, the `OMWA_Emit` seam, and the "mod vs platform" decision. | 🟡 model decided, SDK deferred |
| `LEARNING_LOG.md` | Running log of concepts taught + quiz results, so we can revisit weak spots. | living |

## Source-of-truth rules

1. Ingestion mechanics / sandbox constraints → `01_ARCHITECTURE_OVERVIEW.md`.
2. The event contract (envelope shape, time, versioning, delivery) → `02_EVENT_ENVELOPE.md`.
3. Specific event names and payload shapes → `03_EVENT_REGISTRY.md` (must stay
   consistent with the envelope rules in `02`).
4. Record a decision where it belongs *first*, then reflect impacts elsewhere.
5. Do not update a design doc until a decision is actually made.

## Current status (2026-07-14)

- ✅ **Ingestion channel validated** via the spike (`scripts/omwanalytics/`,
  `shipper/tail-spike.mjs`). Log-based shipping + anonymous identity confirmed in
  the real game.
- ✅ **Event envelope contract** locked (`02`).
- ✅ **Data model implemented** (`06`): Postgres `events` table live in Docker,
  `PRIMARY KEY (session_id, seq)`, `(type, ts)` index.
- ✅ **Ingest API built + tested** (`05`, `api/`): `POST /events` validates the
  envelope (Zod), converts `ts` at the boundary, and upserts idempotently.
  Verified: dedup returns `duplicates` count; a new event type stored with zero
  DDL; bad input → 400.
- ✅ **Full loop VERIFIED live (2026-07-15)** (`shipper/ship.mjs`,
  `scripts/omwanalytics/telemetry.lua`): a real OpenMW launch produced
  `SpikeStarted` + live `Heartbeat`s in Postgres via the shipper. Confirmed
  envelope→columns+jsonb mapping, epoch-ms→timestamptz boundary conversion, and a
  steady ~1.4s event-time vs processing-time lag. The MVP vertical slice
  (game→ingest→Postgres) is closed. See `LEARNING_LOG.md` (2026-07-15).

- 🧭 **Instrumentation model recorded** (`08`): OpenMW sandboxes scripts (no
  monkey-patching), so built-in mechanics are captured passively (engine
  handlers/interfaces) and custom mod logic must emit via the `OMWA_Emit` seam. Public
  SDK deferred until a real third-party consumer exists.

### Next candidates
- ▶ **`07_DASHBOARD.md`** — first question-answering view over `AreaEntered`
  ("where do players spend time?"). The other half of the MVP vertical slice.
- **`SkillProgression` skill event** (`03` + `08`) — proves the passive/auto
  instrumentation path with a real engine hook; no other mod needed.
- `03` follow-ups — retire the `Spike*`/`Heartbeat` placeholders once real events
  cover liveness; reconcile `telemetry.lua`'s stale "spike" header.
- `04_SHIPPER_DESIGN.md` — durable offset, retries — defer until reliability matters.
