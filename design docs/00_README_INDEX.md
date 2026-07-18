# OpenMW Analytics — Design Docs Index

The modular design bible for the OpenMW Analytics platform. These are the active
source documents; day-to-day work targets the relevant module. Every doc is
written in **teaching style** (Why / How / Tradeoffs) — this is a learning project.

## File map

| File | Purpose | Status |
| --- | --- | --- |
| `00_README_INDEX.md` | This index + source-of-truth rules. | living |
| `01_ARCHITECTURE_OVERVIEW.md` | The end-to-end pipeline, components, and what has been validated. | ✅ ingestion validated |
| `02_EVENT_ENVELOPE.md` | The event envelope contract: universal metadata vs. event-specific payload, time model, versioning, delivery/ordering guarantees. **The foundational contract.** | ✅ locked |
| `03_EVENT_REGISTRY.md` | Catalog of canonical event `type`s and their `data` shapes (the "tracking plan") — now the **public contract** third parties emit against. | 🟢 two events live (`AreaEntered`, third-party `ConfrontationAttempted`) |
| `04_SHIPPER_DESIGN.md` | The Node log-tailing shipper: offset tracking, truncation handling, batching, retries, at-least-once. | ✅ reliability pass done 2026-07-18 (durable offset, relaunch detection, at-least-once); doc written |
| `05_API_DESIGN.md` | Ingestion + query REST API (Node/TS): stack, endpoints, validation, versioning. | ✅ ingest built + tested |
| `06_DATA_MODEL.md` | Postgres schema, event storage strategy (JSONB vs columns), idempotent upsert, indexing. | ✅ implemented |
| `07_DASHBOARD.md` | Next.js dashboard + the Express query API it consumes. | 🟡 query endpoint built (`/stats/confrontations`); Next.js frontend next |
| `08_INSTRUMENTATION.md` | How mechanics become events: sandbox isolation, auto- vs manual-instrumentation, the `OMWA_Track` seam, and the "mod vs platform" decision. | ✅ SDK built (`OMWA_Track` + `track.lua`); auto path still open |
| `LEARNING_LOG.md` | Running log of concepts taught + quiz results, so we can revisit weak spots. | living |

## Source-of-truth rules

1. Ingestion mechanics / sandbox constraints → `01_ARCHITECTURE_OVERVIEW.md`.
2. The event contract (envelope shape, time, versioning, delivery) → `02_EVENT_ENVELOPE.md`.
3. Specific event names and payload shapes → `03_EVENT_REGISTRY.md` (must stay
   consistent with the envelope rules in `02`).
4. Record a decision where it belongs *first*, then reflect impacts elsewhere.
5. Do not update a design doc until a decision is actually made.

## Current status (2026-07-18)

The MVP vertical slice is closed **and hardened** end-to-end:

- ✅ **Ingestion channel validated** + **envelope contract locked** (`01`, `02`):
  log-based shipping + anonymous identity confirmed in the real game.
- ✅ **Data model** (`06`) + **ingest API** (`05`) built & tested: `POST /events`
  validates the envelope (Zod), converts `ts` at the boundary, upserts idempotently;
  any new event `type` stored as typed columns + JSONB with **zero DDL**.
- ✅ **Full loop verified live** (`04`): game → log → shipper → API → Postgres.
- ✅ **Two real events live** (`03`): `AreaEntered` (first-party) and
  `ConfrontationAttempted` — the first **third-party** event, emitted by the *separate*
  CCFF mod (`08`'s "mod → platform" case made real).
- ✅ **Public SDK built** (`08`): single **validated** `OMWA_Track` ingress + a
  require-able `track.lua` helper. CCFF is the first consumer; our own `AreaEntered`
  dogfoods the same path.
- ✅ **Shipper reliability** (`04`): at-least-once delivery — durable offset,
  post-then-checkpoint, first-line-fingerprint relaunch detection. No longer flaky.

### Next candidates
- ▶ **`07_DASHBOARD.md`** — the untouched **query half**. First question-answering
  view (e.g. confrontation pass-rate by suspect/topic; where players spend time).
- **`SkillProgression` skill event** (`03` + `08`) — proves the **passive/auto**
  instrumentation path (engine hook, no mod cooperation); today's work is all manual.
- `03` follow-ups — retire the `Spike*`/`Heartbeat` placeholders + reconcile
  `telemetry.lua`'s stale "spike" header once real events cover liveness.
- Explicit backoff / batch caps in the shipper (`04 §5`) — deferred until needed.
