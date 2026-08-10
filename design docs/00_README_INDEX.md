# OpenMW Analytics — Design Docs Index

The design bible for the OpenMW Analytics platform. These are the active source
documents; day-to-day work targets the relevant module.

Every doc is a **decision record** written Why / How / Tradeoffs: what was chosen, what
was rejected, and what measurement settled it. A decision with no discarded alternative
has not been made, only arrived at — so the alternatives are kept in writing, along with
the cases where running the thing contradicted the design.

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
| `07_DASHBOARD.md` | Next.js dashboard + the Express query API it consumes; offline degradation. | 🟢 **live at `omwanalytics.com`**; + event explorer, nav, drill-down (2026-07-23) + **stuck-ranking view** `GET /stats/ranking` (§7, 2026-07-24) + **corpus search view** `/search` (§8, 2026-07-27) — **search verified live in prod**; the older "not yet deployed" note is stale for the nav at least (observed in live HTML) but the ranking view was **not** re-checked this session. + **`/gaps` content-sufficiency view 2026-08-09** (§9) — verdict, gaps with n beside them, `reachable` rendered as UNKNOWN rather than hidden, the merchant caveat rendered verbatim, and the approved insight badged as generated; + **§10 the landing page 2026-08-09** — leads with the finding, not with "AI"; + **2026-08-10 §12 the visual refresh** (palette/type/theme live in `13`) and **§5b-i `byCheck` IS NOT GRAINED AT `check_id`** — 205 rows over 21 checks, so the margin chart drew twelve bars under one label. **Now verified on a real phone as well as a desktop**: the header had set a 476px minimum width for the whole site (`13 §9`) |
| `08_INSTRUMENTATION.md` | How mechanics become events: sandbox isolation, auto- vs manual-instrumentation, the `OMWA_Track` seam, and the "mod vs platform" decision. | ⚠️ SDK is now a FACTORY (`require(...)(modId)`, breaking, 2026-07-23) — **not yet verified in-game**; auto path still open |
| `09_DEPLOYMENT.md` | Hosting the cloud half: AWS EC2 + k3s + RDS + GHCR/Actions; Ingress/TLS; the local/cloud deploy boundary. | 🟢 **live**; + migrations via initContainer + CronJob rollups (2026-07-22); §8 adds the corpus deploy — **manual, tunnelled, un-CI-able** (2026-07-26) |
| `10_ANALYTICS_QUESTIONS.md` | **What the dashboard is for**: the mod-developer question inventory (4 modules) that governs which events `03` may add. | 🟡 new 2026-07-20; **Q2.5 unblocked + Q3.5/Q3.6 added 2026-07-27**; **Q3.6 mechanical half BUILT + DEPLOYED 2026-07-28** (`/stats/sufficiency`); §7 records the scope boundary (`/search` correctly has no row). **Q3.6 READ SIDE SHIPPED 2026-08-09** — `/gaps`, plus the generated layer (12) |
| `11_SEARCH_AND_RETRIEVAL.md` | Phase 4b: hybrid (lexical + vector) search over the game corpus, and its joins to telemetry. Grain, embeddings, schema, ingest, `tsvector`, RRF fusion. | ✅ **4b COMPLETE 2026-07-27** — steps 1–8 built, merged, deployed; `/search` live and verified `mode:"hybrid"` in prod. §10a `ef_search` curve; **§10b: the stored 384 dims CANNOT demonstrate Matryoshka** (head≈mid≈tail). **§12: a test fixture was overwriting real records — `verify-corpus` added.** **§13: world placement survey designed (spiked).** **§14: ordered multi-plugin merge — base + Tribunal + Bloodmoon + CCFF, 45,542 records, local AND prod verified.** **§13: world placement survey BUILT, RUN + INGESTED 2026-07-28 — 6,797 placements, 957 areas, local AND prod**; corpus re-merged with `OAAB_Data.esm` (47,732 records, prod `verify-corpus` green). ▶ open: dims sweep, `m`/`ef_construction`, chunk-text verification |
| `12_AI_INSIGHTS.md` | **Phase 4c**: bounded LLM insights over the aggregate layer — the one question SQL cannot answer, the mechanical guards that decide whether generated text may be published, and the review state machine. | ✅ **LIVE 2026-08-09** — first insight generated against `claude-opus-5`, reviewed, approved and rendering publicly. §5 the two retrieval defects only running it found; §6 the gate grain (`check_id` is NOT a key); §7 the provider. ⚠️ the FIRST generation was honest and useless — one dev-marker passage in, `UNCLEAR` out, and the guards would not have caught a guess |
| `13_UI_DESIGN_SYSTEM.md` | The *visual* half of the dashboard: OKLCH palette, type scale, the real light/dark toggle and where the theme actually lives, and the Morrowind-flavour scope. Companion to `07`. | ✅ **built 2026-08-10** — adopted from an external design handoff, with **8 recorded departures** (§7) and **one token corrected by measurement** (§2: `textFaint` was the only value in the palette failing WCAG AA, and it is the token carrying every `n = …` and `Cited records:` line). §5 the `data-theme` mechanism + why the inline boot script is load-bearing rather than an optimisation; §8 what was verified — including two of my own checks that were wrong before they were right |

## Source-of-truth rules

1. Ingestion mechanics / sandbox constraints → `01_ARCHITECTURE_OVERVIEW.md`.
2. The event contract (envelope shape, time, versioning, delivery) → `02_EVENT_ENVELOPE.md`.
3. Specific event names and payload shapes → `03_EVENT_REGISTRY.md` (must stay
   consistent with the envelope rules in `02`). **An event must cite a question in
   `10_ANALYTICS_QUESTIONS.md`** — questions justify events, not the reverse.
4. Record a decision where it belongs *first*, then reflect impacts elsewhere.
5. Do not update a design doc until a decision is actually made.

## Current status (2026-08-10) — PHASE 4 COMPLETE, TESTED, AND NOW REDESIGNED

| Shipped 2026-08-10 (second session) | |
| --- | --- |
| **Visual refresh across all five screens** (`13`, new) | Two full OKLCH palettes, a **real** light/dark toggle (the site only ever had `prefers-color-scheme`), Spectral for page titles, and the crescent+lens mark as a masked inline SVG. No page copy changed — 11 E2E assertions pin those strings |
| ⭐ **The theme lives in the DOM, not in React** (`13 §5`) | CSS, Recharts and a pre-hydration boot script all read `data-theme`; React subscribes rather than owns. The inline script is what beats first paint — without it a dark-mode user gets a white flash on every document load |
| ⚠️ **`useDarkMode` had to be repointed** (`13 §5`) | It read `matchMedia`. Left alone it would have failed silently in the quietest possible way: page themes correctly, all three chart files keep painting the **OS's** theme. Verified by asserting the axis colour equals the `--border` token after a toggle |
| ⭐ **One palette token was wrong, and it was measured** (`13 §2`) | A WCAG audit over the rendered pages found `textFaint` was the **only** token failing AA — and it is the token carrying every `n = …` sample-size and `Cited records:` line. The caveat was the hardest thing on the page to read |
| **Three departures the handoff itself invited** (`13 §7`) | No violet verdict badges (violet means *a machine wrote this*), no "pending review" count (`/insights` is approved-only in SQL — a `0` would be invented), no manual search-mode toggle |
| ⭐⭐ **TWO grain bugs the refresh exposed** (`07 §5b-i`, `§12`) | Both `check_id`-shaped, neither caused by the refresh. `byStat`'s React key dropped `stat_type` (12 of 18 rows collided → 6 console errors); `MarginChart` drew **205 bars under 21 labels** and was completely silent. The **third and fourth** appearances of "`check_id` is not a key" (`12 §6`) |
| ⚠️ **I reported "zero console warnings" and it was false** (`13 §8`) | The capture navigated with `page.goto` — a cold load, where React HYDRATES. `warnOnInvalidKey` lives on the RECONCILE path a `<Link>` click runs. So the check verified a strictly weaker claim than the one reported, and the bug lived in the gap. Fixed, then **established by mutation**: 6 messages on the client-nav pass, 0 on cold load |
| **Test suite 159 → 167** (`TESTING.md`) | `collapseToChecks` extracted from a render so the grain rule is testable at all — Recharts sets no keys, so dev-build console capture cannot see it, and a category axis is not assertable from Playwright |
| ⭐⭐⭐ **A TIMESTAMP BROKE THE THEME, IN PRODUCTION ONLY** (`13 §8`) | `/events` loaded dark then flipped to light. Three instruments to find it: a `setAttribute` trap said React wrote `light`; after fixing that the attribute vanished with **no** mutation logged; a `MutationObserver` + identity check showed `<html>` was being **REPLACED**. That is React discarding server HTML on a **failed hydration** (#418), caused by `toLocaleString(undefined, …)` in a Client Component — Vercel is UTC, the browser is not. Invisible locally by construction: `next dev`/`next start` render both passes on one machine |
| **E2E 11 → 24, and the new ones run `Asia/Kolkata` + `de-DE`** (`TESTING.md`) | Deliberately hostile: an en-US/UTC test agrees with the server *by accident* and passes while broken. Mutation-checked against the real failure — failed on `/events` against still-broken production, four other pages green |
| 📱 **The header set a 476px MINIMUM WIDTH for the whole site** (`13 §9`) | Reported on a phone; every desktop check was green. The toggle sat at `right: 476` at every viewport below it. Two-row mobile header with a **scrollable** tab strip (no hamburger — four words do not earn a focus trap), and chart Y-axes now measure their container instead of a fixed 190px. **E2E 24 → 45**, run at 320/375/414/768 |
| ⚠️ **The CI test-count floor had gone stale, and a total was the wrong shape** (`09 §11.3`) | 8 against a current 45 — the two largest spec files could have vanished together and still reported green. Raising it does not fix it either: 30 misses the smallest file disappearing (40 left), 41 trips on five deleted tests. The guard now asserts **the file list**, with the total as a backstop. Mutation-checked: dropping the smallest file fails, though the total alone passed |
| ▶ **OWED: a dashboard-only commit gets NO post-deploy verification** (`09 §11.5`) | The E2E smoke job lives in the path-filtered API workflow, so a `dashboard/`-only push deploys via Vercel having run a build and 25 jsdom tests, and nothing else. **Both production bugs this session went through that gap.** Not fixed — the naive fix races Vercel and would be worse than nothing |

## Historical status (2026-08-10) — PHASE 4 COMPLETE, AND NOW TESTED

**Every phase of the plan is built, deployed and verified from outside.**
[omwanalytics.com](https://omwanalytics.com) leads with a real finding; the loop runs
game → `openmw.log` → shipper → API → Postgres → dashboard, with a second pipeline joining
telemetry to the game's own data files.

A push to `main` reaches production in **~3.2 min** and ends in two checks a broken deploy cannot
pass: `/version` asserted through the public ingress, and an E2E run against the deployed site.

| Shipped 2026-08-10 | |
| --- | --- |
| **Test suite: 159 across five layers** (`TESTING.md`) | 117 API · 14 shipper · 17 component · 11 E2E. Every new guard **mutation-checked** — broken on purpose to confirm it goes red, then reverted |
| **Shipper reliability, finally verified** (`04 §4`) | The project's most specific claim was previously checked only by having run it. 14 tests, `fetch` stubbed rather than `post`, so the real post-then-checkpoint path executes |
| **Dashboard CI + post-deploy smoke** (`09 §11`) | The dashboard had *no* pipeline; `/version` proved the image, not that it was useful. ⭐ Both suites assert a **minimum collected test count** — a runner matching zero files exits 0 |
| **Three client-side defects** (`07 §11`) | Lint was red on `main`: a colour-scheme flash in three chart files (now `useSyncExternalStore`), a dead `useEffect` that forgot `loading`, and the React-key half of the gate-grain bug |
| **Lockfile was Windows+Linux only** (`09 §11.4`) | A fresh clone on macOS or ARM had no TypeScript compiler. `npm ci` reported success and installed nothing, because the binaries are *optional* deps |

| Shipped 2026-08-09 | |
| --- | --- |
| **4c — AI insights** (`12`) | bounded prompt, structured outputs, mechanical validation, review workflow. First insight generated, reviewed, approved, public |
| **CI auto-rollout** (`09 §10–11`) | tests → build → SSM/OIDC deploy → `GET /version` asserted through the ingress. No inbound port, no stored SSH key |
| **`/gaps`** (`07 §9`) | Q3.6's read side — the endpoint had been live and invisible since 07-28 |
| **Rate limiting** (`05`) | three tiers + `trust proxy 1`; `/health` deliberately exempt |
| **env scope + seeding** (`06`) | findings exclude seeded rows **in SQL**; 180,003 demo events behind a banner |
| **Landing page** (`07 §10`) | leads with the finding, not with "AI" |

### Deliberately not built: an area rollup

`AreaEntered` exists, but it is used for exactly one thing — classifying a friction next-action as
`left_area`. There is no area rollup, no area endpoint and no area view, and that is a decision
rather than a backlog item.

The genuine area question is Module 2 (*exposure* — what did players never discover?), and it needs
a content manifest the mod does not emit. It is the one module in `10` with nothing currently
answerable. Counting `AreaEntered` by area without that manifest produces a chart with no question
behind it, which `10 §6` forbids: **every view must cite the question it answers.**

The cheap version was available and was declined. Shipping it would have added a page, and
subtracted the only thing that makes the other pages trustworthy.

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
