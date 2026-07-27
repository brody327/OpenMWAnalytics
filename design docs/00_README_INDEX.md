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
| `05_API_DESIGN.md` | Ingestion + query REST API (Node/TS): stack, endpoints, validation, versioning. | ✅ ingest built + tested; read side adds `GET /events` (keyset) + `GET /mods` 2026-07-23 |
| `06_DATA_MODEL.md` | Postgres schema, event storage strategy (JSONB vs columns), idempotent upsert, indexing. | ✅ implemented |
| `07_DASHBOARD.md` | Next.js dashboard + the Express query API it consumes; offline degradation. | 🟢 **live at `omwanalytics.com`**; + event explorer, nav, drill-down (2026-07-23) + **stuck-ranking view** `GET /stats/ranking` (§7, 2026-07-24) — both **not yet deployed** |
| `08_INSTRUMENTATION.md` | How mechanics become events: sandbox isolation, auto- vs manual-instrumentation, the `OMWA_Track` seam, and the "mod vs platform" decision. | ⚠️ SDK is now a FACTORY (`require(...)(modId)`, breaking, 2026-07-23) — **not yet verified in-game**; auto path still open |
| `09_DEPLOYMENT.md` | Hosting the cloud half: AWS EC2 + k3s + RDS + GHCR/Actions; Ingress/TLS; the local/cloud deploy boundary. | 🟢 **live**; + migrations run as an initContainer and a CronJob folds the rollups (2026-07-22) |
| `10_ANALYTICS_QUESTIONS.md` | **What the dashboard is for**: the mod-developer question inventory (4 modules) that governs which events `03` may add. | 🟡 new 2026-07-20 |
| `11_SEARCH_AND_RETRIEVAL.md` | Phase 4b: hybrid (lexical + vector) search over the game corpus, and its joins to telemetry. Grain, embeddings, schema, ingest, `tsvector`, RRF fusion. | 🟢 **steps 1–6 BUILT 2026-07-26** (`api/src/corpus/`, 48 tests); corpus REALLY embedded 2026-07-26; step 7 `ef_search` curve measured (§10a); step 8 open |
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

### Session update (2026-07-23)

**Postgres tuning is DONE and shipped** (`06` rounds 1–5): both confrontation aggregates are
index-only (~7x), both `/stats/friction` window queries are incremental rollups folded by a
scheduled k8s CronJob (~78x), and a hybrid read gives back the freshness the rollups cost.
Schema migrations now run as an initContainer — added after shipping code without its schema
caused a **production 500** (`09 §7`).

**The platform is now multi-mod**: `mod_id` on every event (`02 §2a`), a `mods` registry, and an
event explorer at `/events` with keyset pagination and URL-based filters (`05`, `07 §6`).

▶ **Next, in order:**
1. **Verify the SDK factory in-game** — it sits on the emit path for *every* event and is
   **unverified**; if it is wrong, all telemetry stops silently.
2. Move `/` → `/mods/ccff` and add `/mods/[modId]`.
3. Build `/` as the platform home, with a slot for the AI insight layer.
4. The AI insight layer — which must inherit `10 §3.3`'s sample-size discipline, or it will
   confidently narrate a trend from four sessions.
5. Dashboard filters over the rollups — deferred **deliberately** until the UI showed which
   dimensions it asks for, because the rollup GRAIN determines which filters are possible at all.

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
- **Search / ranking / pgvector** — the AI-engineering thread (Phase 4). ✅ **4a done
  2026-07-24**: stuck-ranking heuristic (`GET /stats/ranking` + view, `07 §7`) — the "ranking
  brought to bear on how the tool works" angle, no new data. 🟢 **4b steps 1–6 BUILT 2026-07-26**
  — see **`11_SEARCH_AND_RETRIEVAL.md`**; parser, chunking, embedding providers and the ingest job
  live in `api/src/corpus/` with 48 tests. Steps 7–8 (index tuning + measurement; dashboard view +
  synthetic seeding) still open. Then 4c LLM insights.
  - ✅ **Really embedded 2026-07-26** (28,253 texts, 152 s, ~$0.026, `text-embedding-3-small@384`),
    and **step 7's `ef_search` curve is measured** (`11 §10a`, `npm run bench-recall`): recall@10
    89.3% at the default 40, **91.6% at 80 — the recommendation** — vs **~30× the cost** for exact
    KNN. ✅ **PROD POPULATED 2026-07-26** — migration 0005 applied via the initContainer, corpus ingested through an SSH tunnel (RDS is private); 34,785 records / 36,567 chunks live on RDS.
  - ⚠️ **This lifts the "blocked on volume" constraint below** — **36,567 chunks** × 384-dim
    vectors is the first genuinely large data the project has had, on a `db.t3.micro`. **MEASURED:
    `shared_buffers` = 185 MB (not the 256 MB assumed); HNSW index 56 MB = 30% of the pool; GIN
    `tsv` 6 MB.** Memory pressure, not disk, is the binding constraint.
  - ✅ **Now verified:** the RDS parameter group **permits** `CREATE EXTENSION vector`; **pgvector
    0.8.2** on RDS (0.8.5 local) ⇒ iterative index scans are available. The extension ships in
    migration `0005`.
  - ⚠️ **`maintenance_work_mem` = 64 MB**, smaller than the index ⇒ HNSW builds take the slow
    on-disk path. Deliberately untuned until measured; if raised, **session-scoped only** —
    autovacuum workers inherit a parameter-group value and would OOM a 1 GB box.
- **Synthetic seeding** (decided 2026-07-25, not built) — demo volume via the existing `env`
  column (`env='synthetic'` + a dashboard banner), **not** a truncate-and-restart. Volume is not
  validity: it makes the demo real, and it still does not justify collaborative filtering.
- `bestAny` (a passive check where *every* stat is below the awareness floor) is
  implemented but still unexercised in game.
- ✅ ~~`03` follow-ups — retire the `Spike*`/`Heartbeat` placeholders + reconcile
  `telemetry.lua`'s stale "spike" header~~ **done 2026-07-20** (they corrupted
  sequence analysis — see `03`).
- Explicit backoff / batch caps in the shipper (`04 §5`) — deferred until needed.
