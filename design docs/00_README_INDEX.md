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
| `03_EVENT_REGISTRY.md` | Catalog of canonical event `type`s and their `data` shapes (the "tracking plan") — now the **public contract** third parties emit against. | 🟢 2 live (`AreaEntered`, `ConfrontationAttempted`); 3 exposure events designed 2026-07-20; `Spike*`/`Heartbeat` retired |
| `04_SHIPPER_DESIGN.md` | The Node log-tailing shipper: offset tracking, truncation handling, batching, retries, at-least-once; operating it. | ✅ reliability pass done 2026-07-18 (durable offset, relaunch detection, at-least-once); §5 adds the first-run EOF trap + recovery |
| `05_API_DESIGN.md` | Ingestion + query REST API (Node/TS): stack, endpoints, validation, versioning. | ✅ ingest built + tested |
| `06_DATA_MODEL.md` | Postgres schema, event storage strategy (JSONB vs columns), idempotent upsert, indexing. | ✅ implemented |
| `07_DASHBOARD.md` | Next.js dashboard + the Express query API it consumes; offline degradation. | 🟢 **live at `omwanalytics.com`** with real data + snapshot fallback |
| `08_INSTRUMENTATION.md` | How mechanics become events: sandbox isolation, auto- vs manual-instrumentation, the `OMWA_Track` seam, and the "mod vs platform" decision. | ✅ SDK built (`OMWA_Track` + `track.lua`); auto path still open |
| `09_DEPLOYMENT.md` | Hosting the cloud half: AWS EC2 + k3s + RDS + GHCR/Actions; Ingress/TLS; the local/cloud deploy boundary. | 🟢 **live**: API `api.omwanalytics.com` + dashboard on Vercel; shipper repoint remains |
| `10_ANALYTICS_QUESTIONS.md` | **What the dashboard is for**: the mod-developer question inventory (4 modules) that governs which events `03` may add. | 🟡 new 2026-07-20 |
| `LEARNING_LOG.md` | Running log of concepts taught + quiz results, so we can revisit weak spots. | living |

## Source-of-truth rules

1. Ingestion mechanics / sandbox constraints → `01_ARCHITECTURE_OVERVIEW.md`.
2. The event contract (envelope shape, time, versioning, delivery) → `02_EVENT_ENVELOPE.md`.
3. Specific event names and payload shapes → `03_EVENT_REGISTRY.md` (must stay
   consistent with the envelope rules in `02`). **An event must cite a question in
   `10_ANALYTICS_QUESTIONS.md`** — questions justify events, not the reverse.
4. Record a decision where it belongs *first*, then reflect impacts elsewhere.
5. Do not update a design doc until a decision is actually made.

## Current status (2026-07-20)

**The platform is deployed and public**, running real gameplay data:
**[omwanalytics.com](https://omwanalytics.com)** (dashboard) over
**[api.omwanalytics.com](https://api.omwanalytics.com/health)** (API on k3s → RDS).
The full loop — game → `openmw.log` → shipper → cloud API → Postgres → dashboard —
has been exercised end to end with real `ConfrontationAttempted` events (`09`).

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

### Next candidates (end of 2026-07-20)

**The platform is fully live and real-time**: game → log → shipper → cloud API → RDS →
`omwanalytics.com` in ~1–3s, collection running automatically via a logon Scheduled Task,
ingest authenticated. Remaining threads:

- ✅ ~~**Ingest authentication**~~ **done 2026-07-20** (`05`): bearer token, fails closed,
  verified from the public internet. Threat model recorded — a client-side secret raises
  the bar, it does not guarantee anything.
- ▶ **Postgres performance tuning** (`06`) — the largest *core* JD skill still untouched.
  Blocked on **volume, not capability**: a `GROUP BY` over ~100 rows teaches nothing.
  Needs real play volume or deliberately generated load.
- ▶ **Exposure events + content manifest** (`10` Module 2) — the only module with
  *nothing* answerable. Counting what was never discovered requires the mod to declare
  what exists.
- ▶ **Rate limiting** (`05`) — auth stops anonymous writes, not a valid-token client
  flooding the endpoint. The honest next security gap.
- **Filter `/stats/*` to `env = 'prod'`** (`06`) — deliberately *not* done: every row today
  is the author's, so filtering would blank the dashboard. Do it when player data exists.
- **Milestone / progression events** (`10` Module 4) — completion funnel (4.2), pacing (4.3).
- **`SkillProgression` engine event** (`03` + `08`) — proves the **passive/auto**
  instrumentation path (engine hook, no mod cooperation); all current work is manual.
- **Search / ranking / pgvector** — the AI-engineering thread, unstarted. Needs data.
- `bestAny` (a passive check where *every* stat is below the awareness floor) is
  implemented but still unexercised in game.
- ✅ ~~`03` follow-ups — retire the `Spike*`/`Heartbeat` placeholders + reconcile
  `telemetry.lua`'s stale "spike" header~~ **done 2026-07-20** (they corrupted
  sequence analysis — see `03`).
- Explicit backoff / batch caps in the shipper (`04 §5`) — deferred until needed.
