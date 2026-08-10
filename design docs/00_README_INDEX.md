# OpenMW Analytics — Design Docs Index

The modular design bible for the OpenMW Analytics platform. These are the active
source documents; day-to-day work targets the relevant module. Every doc is
written in **teaching style** (Why / How / Tradeoffs) — this is a learning project.

## File map

| File | Purpose | Status |
| --- | --- | --- |
| `00_README_INDEX.md` | This index + source-of-truth rules. | living |
| `01_ARCHITECTURE_OVERVIEW.md` | The end-to-end pipeline, components, and what has been validated. | ✅ ingestion validated; + a SECOND ingestion path 2026-07-26 (local corpus -> RDS, §The pipeline) |
| `02_EVENT_ENVELOPE.md` | The event envelope contract: universal metadata vs. event-specific payload, time model, versioning, delivery/ordering guarantees. **The foundational contract.** | ✅ locked |
| `03_EVENT_REGISTRY.md` | Catalog of canonical event `type`s and their `data` shapes (the "tracking plan") — now the **public contract** third parties emit against. | 🟢 **6 verified live**. 2026-07-28 a play session proved `SkillCheckDisplayed`, `ItemConsumed` and the `base_value`/`stat_modifier`/`stat_damage` chain — all three had NEVER fired. ⚠️ the emitting CCFF code is still UNCOMMITTED. `Spike*`/`Heartbeat` retired |
| `04_SHIPPER_DESIGN.md` | The Node log-tailing shipper: offset tracking, truncation handling, batching, retries, at-least-once; operating it. | ✅ reliability pass done 2026-07-18 (durable offset, relaunch detection, at-least-once); §5 adds the first-run EOF trap + recovery. ⚠️ **SIX-DAY SILENT OUTAGE 2026-07-20→27** — logon-only trigger + exhausted retries; now self-healing (15-min repeat) **verified by killing it**, plus heartbeat + `/ops/freshness` with a **fired** alert |
| `05_API_DESIGN.md` | Ingestion + query REST API (Node/TS): stack, endpoints, validation, versioning. | ✅ ingest built + tested; read side adds `GET /events` (keyset) + `GET /mods` 2026-07-23, and **`GET /search`** 2026-07-26 — the first endpoint calling an EXTERNAL service; + **`/ops/freshness` & `/ops/heartbeat`** 2026-07-27 (deliberately NOT `/health`, which k8s probes); + **`GET /stats/sufficiency`** 2026-07-28 — Q3.6, the only `/stats` route that leaves the telemetry DB, **`reachable` now answered from the world survey**; + 2026-08-09 **`GET /version`** (the check a stale pod cannot pass), **4 `/insights` routes** (12), **rate limiting** on every write and read path, and `?limit` on `/stats/sufficiency` (it was returning **1.86 MB** of all 6,687 gates per request) |
| `06_DATA_MODEL.md` | Postgres schema, event storage strategy (JSONB vs columns), idempotent upsert, indexing. | ✅ implemented; + corpus tables & pgvector 2026-07-26 (measured index costs, TOAST, source-scoped orphan sweep); + `shipper_state` 2026-07-27 (migration `0006`); + **§env scope + committed seeder 2026-08-09** — findings exclude `env='synthetic'` in SQL (⚠️ NOT `env='prod'`, which would have blanked the dashboard), 180,003 seeded events, and the accepted decision that the friction rollup is permanently mixed |
| `07_DASHBOARD.md` | Next.js dashboard + the Express query API it consumes; offline degradation. | 🟢 **live at `omwanalytics.com`**; + event explorer, nav, drill-down (2026-07-23) + **stuck-ranking view** `GET /stats/ranking` (§7, 2026-07-24) + **corpus search view** `/search` (§8, 2026-07-27) — **search verified live in prod**; the older "not yet deployed" note is stale for the nav at least (observed in live HTML) but the ranking view was **not** re-checked this session. + **`/gaps` content-sufficiency view 2026-08-09** (§9) — verdict, gaps with n beside them, `reachable` rendered as UNKNOWN rather than hidden, the merchant caveat rendered verbatim, and the approved insight badged as generated; + **§10 the landing page 2026-08-09** — leads with the finding, not with "AI" |
| `08_INSTRUMENTATION.md` | How mechanics become events: sandbox isolation, auto- vs manual-instrumentation, the `OMWA_Track` seam, and the "mod vs platform" decision. | ⚠️ SDK is now a FACTORY (`require(...)(modId)`, breaking, 2026-07-23) — **not yet verified in-game**; auto path still open |
| `09_DEPLOYMENT.md` | Hosting the cloud half: AWS EC2 + k3s + RDS + GHCR/Actions; Ingress/TLS; the local/cloud deploy boundary. | 🟢 **live**; + migrations via initContainer + CronJob rollups (2026-07-22); §8 adds the corpus deploy — **manual, tunnelled, un-CI-able** (2026-07-26) |
| `10_ANALYTICS_QUESTIONS.md` | **What the dashboard is for**: the mod-developer question inventory (4 modules) that governs which events `03` may add. | 🟡 new 2026-07-20; **Q2.5 unblocked + Q3.5/Q3.6 added 2026-07-27**; **Q3.6 mechanical half BUILT + DEPLOYED 2026-07-28** (`/stats/sufficiency`); §7 records the scope boundary (`/search` correctly has no row). **Q3.6 READ SIDE SHIPPED 2026-08-09** — `/gaps`, plus the generated layer (12) |
| `11_SEARCH_AND_RETRIEVAL.md` | Phase 4b: hybrid (lexical + vector) search over the game corpus, and its joins to telemetry. Grain, embeddings, schema, ingest, `tsvector`, RRF fusion. | ✅ **4b COMPLETE 2026-07-27** — steps 1–8 built, merged, deployed; `/search` live and verified `mode:"hybrid"` in prod. §10a `ef_search` curve; **§10b: the stored 384 dims CANNOT demonstrate Matryoshka** (head≈mid≈tail). **§12: a test fixture was overwriting real records — `verify-corpus` added.** **§13: world placement survey designed (spiked).** **§14: ordered multi-plugin merge — base + Tribunal + Bloodmoon + CCFF, 45,542 records, local AND prod verified.** **§13: world placement survey BUILT, RUN + INGESTED 2026-07-28 — 6,797 placements, 957 areas, local AND prod**; corpus re-merged with `OAAB_Data.esm` (47,732 records, prod `verify-corpus` green). ▶ open: dims sweep, `m`/`ef_construction`, chunk-text verification |
| `12_AI_INSIGHTS.md` | **Phase 4c**: bounded LLM insights over the aggregate layer — the one question SQL cannot answer, the mechanical guards that decide whether generated text may be published, and the review state machine. | ✅ **LIVE 2026-08-09** — first insight generated against `claude-opus-5`, reviewed, approved and rendering publicly. §5 the two retrieval defects only running it found; §6 the gate grain (`check_id` is NOT a key); §7 the provider. ⚠️ the FIRST generation was honest and useless — one dev-marker passage in, `UNCLEAR` out, and the guards would not have caught a guess |
| `LEARNING_LOG.md` | Running log of concepts taught + quiz results, so we can revisit weak spots. | living |

## Source-of-truth rules

1. Ingestion mechanics / sandbox constraints → `01_ARCHITECTURE_OVERVIEW.md`.
2. The event contract (envelope shape, time, versioning, delivery) → `02_EVENT_ENVELOPE.md`.
3. Specific event names and payload shapes → `03_EVENT_REGISTRY.md` (must stay
   consistent with the envelope rules in `02`). **An event must cite a question in
   `10_ANALYTICS_QUESTIONS.md`** — questions justify events, not the reverse.
4. Record a decision where it belongs *first*, then reflect impacts elsewhere.
5. Do not update a design doc until a decision is actually made.

## Current status (2026-08-09) — PHASE 4 COMPLETE

**Every phase of the plan is built, deployed and verified from outside.**
[omwanalytics.com](https://omwanalytics.com) leads with a real finding; the loop runs
game → `openmw.log` → shipper → API → Postgres → dashboard, with a second pipeline joining
telemetry to the game's own data files.

| Shipped 2026-08-09 | |
| --- | --- |
| **4c — AI insights** (`12`) | bounded prompt, structured outputs, mechanical validation, review workflow. First insight generated, reviewed, approved, public |
| **CI auto-rollout** (`09 §10–11`) | tests → build → SSM/OIDC deploy → `GET /version` asserted through the ingress. No inbound port, no stored SSH key |
| **`/gaps`** (`07 §9`) | Q3.6's read side — the endpoint had been live and invisible since 07-28 |
| **Rate limiting** (`05`) | three tiers + `trust proxy 1`; `/health` deliberately exempt |
| **env scope + seeding** (`06`) | findings exclude seeded rows **in SQL**; 180,003 demo events behind a banner |
| **Landing page** (`07 §10`) | leads with the finding, not with "AI" |

### ⚠️ Résumé audit (2026-08-09) — 4 of 5 bullets fully true, one word is not

| # | Claim | |
| --- | --- | --- |
| 1 | generic ingest API, Zod, idempotent upsert, JSONB, zero migrations | ✅ |
| 2 | shipper at-least-once, authenticated, **rate-limited** | ✅ (rate limiting 08-09) |
| 3 | GHCR→Actions→k3s→RDS/TLS, certs, **uptime/error monitoring** | ✅ |
| 4 | scheduled rollups over session/**area**/skill-check, filterable dashboard | 🟡 **"area" is FALSE** |
| 5 | constrained **AI-insights**, bounded prompts + human review | ✅ (4c, 08-09) |

**`AreaEntered` is used only to classify a friction next-action as `left_area`.** There is no area
rollup, no area endpoint, no area view.

▶ **Recommendation: cut the word, do not build the feature.** The genuine area question is
Module 2 (*exposure* — what did players never discover?), which needs a content manifest the mod
does not emit, and is the one module with nothing answerable. Counting `AreaEntered` by area
without it is a chart with no question behind it, and `10 §6` forbids exactly that. Building it to
make a résumé word true is the "I added X because the JD said X" failure the plan itself warns is
transparent in an interview.

## Historical status (2026-07-20)

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
- ✅ ~~**Filter `/stats/*` to `env = 'prod'`**~~ **RESOLVED 2026-08-09 — but not as written**
  (`06 §env scope`). ⚠️ `env = 'prod'` would have **blanked the public dashboard**: all 145 real
  prod events carry `env = 'dev'` (real play from the author's machine). The distinction that
  matters is **real vs fabricated**, so the predicate is `env <> 'synthetic'`, and it is applied to
  the **findings** endpoint only — demo views keep their volume behind a banner.
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
