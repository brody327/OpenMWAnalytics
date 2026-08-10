# 07 — Dashboard (the query side)

**Status:** 🟢 **deployed and public at [omwanalytics.com](https://omwanalytics.com)**
(2026-07-20), rendering real gameplay data. First view (2026-07-18):
`/stats/confrontations` query endpoint + a Next.js pass-rate dashboard (`dashboard/`).
Hosting/DNS/TLS detail lives in `09_DEPLOYMENT.md`; this doc owns the read-side design.

The dashboard is the **read half** of the platform — where the event log becomes
answers. `01`'s thesis is "actionable insight, not raw counts" (*"Puzzle 7 has a 71%
failure rate"*), and this is where that lands.

---

## 1. Architecture — clean consumer/producer split

```
Postgres ──SQL aggregates──▶ Express API (GET /stats/*) ──JSON──▶ Next.js (RSC fetch) ──▶ chart components
```

- **Express (`api/`) owns all data access + aggregation.** The read endpoints live
  next to ingest, sharing the pool and schema. This keeps a single source of truth for
  how the DB is queried.
- **Next.js is a pure consumer.** Chosen for target-job stack alignment. Its **server
  components fetch the Express `/stats/*` endpoints server-side** (no CORS, no secrets in
  the browser) and hand plain data to client chart components. We deliberately do **not**
  query Postgres from Next route handlers — that would split data access across two
  services and dissolve the boundary above.

Why not Next.js API routes for the data? We already have the API. Duplicating query logic
in Next would be two places to change one schema. RSC is the fetch boundary; Express is
the data boundary.

---

## 2. The query-layer principle (the actual learning here)

**Aggregate server-side; never ship raw rows.** The client asks a *question*
("pass-rate by topic") and receives an *answer* (`[{topic, attempts, pass_rate}]`), not
10k events to reduce in JS. That single rule is the line between an event **store** and
an analytics **API**:

- less data on the wire, work done where the index and the data live;
- the aggregation contract is versioned and testable independent of any UI;
- the client stays dumb — it renders, it doesn't compute metrics.

**SQL techniques in play (`/stats/confrontations`):**
- JSONB extraction in `GROUP BY`: `data->>'suspect'`, `data->>'topic'`.
- Rate from a boolean: `avg((data->>'passed')::boolean::int)` = pass-rate.
- Conditional aggregate: `count(*) FILTER (WHERE …)` — multiple slices in one scan, no
  self-join.
- Runs on the existing `(type, ts)` index; no new DDL.

---

## 3. First view — confrontation pass-rate

**Question:** *where do players get stuck in confrontations?*

`GET /stats/confrontations` → `{ byTopic, byReason }`:

| Field group | Shape | Answers |
| --- | --- | --- |
| `byTopic` | `{ suspect, topic, attempts, passes, pass_rate }[]` | which suspect/topic is hardest; how many attempts precede a break |
| `byReason` | `{ reason, count }[]` (fails only) | *why* players fail (wrong claim vs. missing evidence vs. …) |

Frontend: a pass-rate bar per topic + a failure-reason breakdown. (Chart work goes
through the `dataviz` skill for a consistent, accessible palette.)

---

## 4. Second view — friction (the sequence layer)

**Question:** *is this hard in the way I intended?* (`10` questions 1.3 / 1.4 / 1.6).
Built 2026-07-20 — **API + dashboard view both shipped.**

§3's view is a `GROUP BY`: it collapses rows and discards ordering. That answers "how
often did this fail" but **not whether the failure was OK** — a pass rate alone cannot
separate good difficulty from bad. This view keeps every row and lets each row see its
neighbours: **window functions over `(session_id, seq)`**, which is also the PK, so the
ordering is guaranteed and already indexed.

`GET /stats/friction` → `{ afterFailure, attemptsToPass }`:

| Field group | Shape | Answers |
| --- | --- | --- |
| `afterFailure` | `{ suspect, topic, next_action, count, avg_gap_seconds }[]` | 1.4 — `retried_same` / `exited_solved` / `switched_topic` / `abandoned` / `left_area` / `session_end` |
| `attemptsToPass` | `{ suspect, topic, sessions, solved_sessions, total_attempts, avg_attempts_to_pass, max_attempts_in_a_session }[]` | 1.3, and 1.6 via `solved_sessions = 0` |

**Two ordering traps, both load-bearing (this is the learning):**

1. **System events poison the window.** `Heartbeat` fires every 5s, so the row after
   almost any failure is a heartbeat — `LEAD` would report *"players respond to failure
   by idling."* An instrumentation artifact, not behavior. They are filtered out of the
   stream **before** the window applies. This is the concrete cost of the `Spike*` /
   `Heartbeat` placeholders and the argument for retiring them (`03`).
2. **`WHERE` runs *before* window functions.** Filtering to failures at the same query
   level would make `LEAD` see only *other failures* — "next event" silently becomes
   "next failure." Hence the CTE: window over the full stream first, filter second.

**Honest-reading notes:**
- `session_end` is **inferred** — there is no `SessionEnded` event and crash / alt-F4 /
  clean quit are indistinguishable from the log. It means *last observed activity*.
- `avg_attempts_to_pass` is `NULL` when nothing was ever solved — deliberately, so
  "unsolved" never renders as a number. `count(attempts_to_pass)` counts only sessions
  that did solve it.
- Verified 2026-07-20 against local Postgres (n=3 attempts): correct bucket assignment,
  correct NULL propagation. **SQL correctness verified; the sample is far too small to
  read as insight** — see `10 §3.3`.

### 4a. The friction UI

`AfterFailureChart` (stacked horizontal bar, one row per topic) + an
attempts-before-success table. Both live on the home page below the confrontation view.

**Colour: an ordinal ramp, not categorical hues — and the validator decided it.** The
four buckets are *ordered* by severity (engaged → stopped playing), so they are an
ordinal scale, not four neutral identities. The obvious first choice — the dataviz
status palette (good/warning/serious/critical) — was **rejected by running the
validator**: `warning ↔ serious` measure normal-vision ΔE 13.6, under the hard floor of
15, and those two sit adjacent in every stacked bar. A single-hue blue ramp (light
steps 250/400/550/700; dark 150/300/450/600) passes all four ordinal checks in both
modes. *The lesson is the habit: the colour question was computed, not eyeballed.*

**Honest-rendering decisions:**
- `avg_attempts_to_pass = null` renders as **"never solved"**, never as a number — `0`
  would read as "solved on the zeroth try", the exact opposite of the truth.
- `solved_sessions = 0` is called out in amber: the Q1.6 unpassable-content signal.
- The `other` bucket is **dropped from the chart** rather than folded into a named
  bucket (which would misattribute behaviour); it remains in the underlying data.
- `left_area` is labelled ambiguous in the UI — it cannot distinguish frustration from
  fetching evidence. `ConfrontationExited` now supersedes it for confrontations.

### 4c. ⚠️ Sequence queries are coupled to the SET of event types

**Found the hard way, 2026-07-20.** Shipping `ConfrontationExited` *broke this view* the
moment it started arriving: `LEAD()` returned an event type the `CASE` had no branch for,
so every real abandonment fell into `other` — and `other` was being **dropped** from the
chart. The signal the new event existed to make authoritative silently disappeared instead.

Two lessons, both general:

1. **Adding an event type is a change to every consumer that reasons about "what happened
   next."** A `GROUP BY` over one type is insulated from new types; a sequence query is
   not. Sequence consumers must be reviewed whenever the registry grows.
2. **Never silently drop an unmatched bucket.** The chart now folds anything the SQL emits
   but the UI does not name into a rendered neutral-grey **"Other / unclassified"** segment.
   A dropped bucket and "this never happens" look identical on screen — which is precisely
   how this stayed invisible until the row counts were checked by hand.

The bucket list grew to five ordinal steps (`retried_same` → `exited_solved` →
`switched_topic` → `abandoned` → `session_end`), so the ramp was **re-validated at five
steps** in both modes rather than assumed to still hold; Other sits outside the ramp in
neutral grey, since it has no place on a severity scale.

### 4b. Sample-size discipline (`10 §3.3`)

The population is one player who is also the mod's author, so a rate over a handful of
attempts is an anecdote. The page now enforces this rather than merely documenting it:
a `MIN_CONFIDENT_N` threshold (20) drives a **de-emphasised** stat tile (regular weight,
muted ink) plus an explicit `n = …`, and a plain-language "small sample" banner. Rates
are **de-emphasised, never hidden** — hiding them would be its own distortion.

Degradation: `/stats/friction` fetches concurrently with `/stats/confrontations`
(`Promise.all`) and degrades independently, so one endpoint being down cannot blank the
other. The snapshot script captures friction too, but is **not** allowed to fail on it —
a deployed API predating the endpoint is expected. A snapshot with no `friction` key
reports **"unavailable"** rather than rendering empty arrays as a real reading.

---

## 5. Serving it when the API is down

The API runs on a single EC2 box that is **stopped between sessions to control cost**, so
"upstream unreachable" is a *routine* state here, not an exception — and for a public URL,
an error page is the wrong answer to a routine state.

`getConfrontationStats()` therefore returns a `StatsResult`
(`{ stats, source, capturedAt, error }`) rather than throwing, and the page renders a
committed **last-known-good snapshot** with a plainly-worded notice and the capture date.
Three decisions make it honest rather than merely pretty:

- **The fetch is bounded** (`AbortSignal.timeout(4000)`). A *stopped* box drops packets
  instead of refusing connections, so an unbounded fetch **hangs** rather than failing —
  the timeout is what converts an indefinite wait into a handleable error.
- **The snapshot is captured *from* the live API** (`npm run snapshot`), never hand-written,
  so the fallback is data that was genuinely true at a known moment. The script refuses to
  overwrite a good snapshot with an empty response — an API that is up but empty would
  otherwise erase the fallback exactly when it will later be needed.
- **Stale data is always labelled.** A visitor is never allowed to mistake a snapshot for
  a live reading.

**Rejected: Next's `use cache` / ISR stale-while-revalidate.** It appears to solve this,
but a **cold cache after a deploy** has nothing stale to serve, and the default cache is
in-memory on serverless — implicit machinery whose failure mode is "sometimes works." An
explicit committed snapshot works on the first request after every deploy.

The route stays **dynamic** (`ƒ` in the build summary, via `cache: 'no-store'`) so a live
API is always queried per request; the snapshot is strictly a fallback, never a cache.

---

## 5b. Third view — skill margin (`GET /stats/skills`)

Built 2026-07-20 — **API + dashboard view both shipped.** Serves `10` Q1.2, Q3.1, Q3.3.

**Why a pass-rate is not enough here** — five real checks from one session, all failed:

```
strength    44 / 50  -> margin  -6   <- six points short. Tuning candidate.
marksman    10 / 40  -> margin -30   <- not a marksman. No tuning fixes this.
personality 29 / 50  -> margin -21
shortblade  15 / 35  -> margin -20
```

A pass-rate reports `0%` and stops. Margin says *what kind of work each failure implies* —
which is why `skill_value` and `threshold` are stored **raw** and margin is derived here.

| Field group | Answers |
| --- | --- |
| `byCheck` | attempts, honest pass-rate, fluke count, avg/closest/worst fail margin |
| `failureDistance` | **the actionable one** — unsolved (session, check) pairs bucketed `near_miss` / `moderate_gap` / `build_gap` |
| `byStat` | Q3.3 — which skills/attributes the mod actually gates on |
| `byRoute` | Q3.1 — archetype routes exercised |

**Two rules enforced in SQL, not left to the consumer:**

1. **`trigger = 'inspect'` on every friction metric.** A passive check was never opted into —
   the player didn't know it happened — so its failure carries no frustration signal. `byStat`
   deliberately *includes* passive rows, because "which stats does this mod test" is a
   design-coverage question, not a friction one.
2. **Difficulty reads `threshold_passed`, not `passed`.** A `weird_success_chance` fluke
   counted as a real pass would inflate the pass-rate of precisely the hardest checks.
   `fluke_passes` is surfaced separately.

**Band thresholds are a content-design judgement, not a technical one:** `near_miss` ≥ −10,
`moderate_gap` −11…−15, `build_gap` ≤ −16. Set by the author, **not** derived from data —
`near_miss` was widened from −5 to −10 (2026-07-20) so that a check missed by six points reads
as "so close, consider lowering the bar" rather than "wrong build". They live in one place
(`api/src/stats/skills.ts`) so every consumer agrees on what a near miss is.

⚠️ `moderate_gap` is now a narrow −11…−15 window; if it turns out to catch almost nothing in
real data, the honest move is **two bands, not three** — near-miss (tune it) vs. build-gap
(don't) — rather than a middle band nobody can act on.

### 5c. ⚠️ Not all attempts are equal — `failureDistance` grain

**Found in live data 2026-07-20.** The Jeanus lockbox's "trust to luck" action is *cheap and
retryable*, so one session spammed it 20 times — becoming **20 of 30** skill-check rows. A
per-attempt distribution therefore described *one action's repeatability*, not player
experience: every band except `build_gap` was empty and the average margin was dragged to −65.9.

`failureDistance` is therefore grained at **one row per (session_id, check_id)** — one player,
one check, one vote — which drops that same data to 3 rows / avg −40. Two deliberate
consequences:

- a (session, check) where **any** attempt eventually cleared the bar is **not a failure** and
  is excluded entirely (`having not bool_or(threshold_passed)`);
- the representative margin is `max(margin)` — **the closest the player got**. "How far short
  did they fall" is best answered by their best attempt, since a skill can rise mid-session.

`byCheck` deliberately keeps **raw attempt counts**: "tried the lottery 20 times" is itself a
real behavioural signal, just not a difficulty one.

**The general rule:** de-duplicate to the unit the *question* is about. A metric about players
must not let one cheap repeatable action outvote a costly one.

### 5d. The skills UI

Three band tiles (from the server-computed `failureDistance`) + a margin chart + a
"what the mod gates on" table.

- **Each band tile states the work it implies** — *"the bar may be a point or two too high"*
  vs. *"not built for this route; tuning will not help"*. The bucketing exists to route the
  author to a decision, so the tile says the decision rather than making them infer it.
- **The margin chart is deliberately a SINGLE series colour, not banded.** Colouring bars by
  band would re-implement the thresholds client-side and give one rule two sources of truth
  that can silently drift. Bands are computed server-side and shown as tiles; the chart shows
  raw distance. One rule, one place.
- **Bars extend left from a zero reference line** = "distance from passing". Only checks that
  have actually been failed appear: a check that has only ever passed has *no distance*, and a
  zero-length bar would imply a near miss that never happened.
- **Passive rows are shown but badged** in the coverage table — visible for design coverage
  (Q3.3), marked so they are never read as friction.
- Bands with no data render **"none recorded"**, not `0` — at this sample size the honest
  statement is that nothing was observed, not that the count is zero.

**SQL gotchas hit while building this**, both worth remembering: `ORDER BY` cannot reference
an output alias inside an *expression* (the `band` CASE needed its own CTE to become a real
column), and backticks around an identifier in a SQL comment silently terminate the
surrounding JS template literal.

---

## 6. Deferred (YAGNI)

- **Time filters / ranges** on the endpoints — add when there's enough history to slice.
- **Materialized views / rollups** — a live `GROUP BY` is fine at dev volume; reach for a
  matview only when a query gets slow or fans out over millions of rows.
- **AreaEntered / liveness views** — additional `/stats/*` endpoints, same pattern.
- **Auth on the read endpoints** — `/stats/*` is deliberately public: it's aggregate,
  anonymous, and being readable is the point of a portfolio dashboard. ⚠️ **Note this is no
  longer true of the *write* path:** deployment moved `POST /events` from "unreachable on
  localhost" to "world-writable on the internet," so anyone can inject fabricated telemetry.
  That is a real open gap — see `09_DEPLOYMENT.md` §6.

---

## §6 Event explorer (`/events`, 2026-07-23)

The dashboard's second read shape. `/stats/*` answers *"is this mod being played as designed"*
from precomputed rollups; the explorer answers *"what exactly happened"*, row by row.

**It deliberately does not touch the rollups.** A rollup can only be filtered by dimensions in
its grain; the explorer must filter on anything. Different question, different data path — which
is why the grain collision that governs dashboard filters simply does not apply here.

Justified by two decisions (doc 10 rule 1 — a view earns its place by naming one):
1. **instrumentation debugging** — "did my new event fire, with what payload?", previously done
   by grepping `openmw.log` and hand-writing psql;
2. **drill-down** — "12 sessions abandoned this topic; show me one."

### Filter state lives in the URL

Not a framework preference — a product decision, and then a mechanical one.

| | filters in the URL | filters in a store |
| --- | --- | --- |
| "look at this" | paste a link | screenshot, or "click X then Y" |
| bookmark a view | free | build a saved-views feature |
| **back button** | undoes a filter | leaves the page — reads as broken |
| reload | survives | resets |
| chart → filtered feed | plain `<a href>` | navigate, then push into the store, then reconcile |
| copies of the state | **one** | two, needing bidirectional sync |

The mechanical half: **a Server Component cannot hold state.** It runs once per request and is
gone, so its only input is the request — which makes the query string the page's props. If
filters lived in client state, the server would render a default view and the client would then
fetch the real one: a flash of wrong content plus a round-trip waterfall.

**What stays local:** uncommitted input (draft vs committed — a keystroke is not a shareable
view, and committing per character means a request and a history entry each), and which row is
expanded. Row *identity* could reasonably be shared — that is what a URL fragment is for — but
its expansion state is presentation.

⚠️ **A cursor encodes a position within a specific ordering of a specific result set.** Any
filter (or sort) change must therefore DROP the cursor, or it points into a result set that no
longer exists and silently returns a wrong slice with no error. Enforced in `EventFilters.tsx`
and by keying the feed on the serialised filters.

### Client/server split

```
page.tsx        Server Component   awaits searchParams, fetches page 1 + mod list concurrently
EventFilters    Client Component   reads the URL, WRITES the URL, holds no filter state
EventFeed       Client Component   accumulates pages, expands rows
/api/events     Route Handler      same-origin proxy so the browser can page without CORS
```

The Route Handler exists because `OMWA_API_BASE` is a server-only env var *on purpose* (the API
origin never ships to the browser) and Express sets no CORS headers. A thin BFF moves the call
to the correct side of the boundary rather than widening the API's public surface for one button.
It stays a pass-through: the moment it reshapes data, the server-rendered first page and the
client-fetched later pages become two implementations that must agree.

`useTransition` supplies `isPending` during the navigation. Every filter change is a server
round-trip, and without a pending state the UI simply freezes — which is what makes this pattern
feel slow when people meet it for the first time.

⚠️ **Not visually eyeballed** — no browser available; verified by SSR HTML (row counts per
filter, mod attribution, empty state) and `next build`.

### §6a Navigation and the drill-down (2026-07-23)

`NavBar` lives in the root layout, so it mounts once and survives navigation between pages. It is
a Client Component for exactly one reason — `usePathname()` marks the active link — which is the
rule in miniature: default to Server Components, opt in only where state, effects, handlers or
browser APIs are needed.

Each row of the attempts-to-pass table links into the explorer pre-filtered to that
suspect/topic. **This is the payback on putting filter state in the URL**, and the reason the
explorer was justified at all ("12 sessions abandoned this topic — show me one"): because the
explorer reads its filters from the URL, *constructing the URL is constructing the view*. It is
a plain `<Link>` with nothing wired up. With filters in a client store it would have to
navigate, seed the store, then reconcile whatever filters were already there.

Verified via SSR HTML: nav on both routes with exactly one `aria-current="page"`; 35 drill-down
links on `/`; following one returns 50 rows, all `ccff`, all `ConfrontationAttempted`.
⚠️ **Not visually eyeballed** — no browser available.

---

## 7. Ranking — "where players are most stuck" (`GET /stats/ranking`, 2026-07-24)

**Question:** *where should the author look first?* (`10` Q1.1). Built 2026-07-24 — **API +
dashboard view both shipped.** This is Phase 4a, and it is a different *kind* of view from
everything above: §3–§5 **report** the data faithfully; this one makes a **judgement** — it
ranks topics by how much they deserve attention, from an explicit scoring function.

### The scoring function (a heuristic, deliberately not a model)

```
stuck_score = shrunk_fail_rate × log(attempts)
shrunk_fail_rate = (fails + m·C) / (attempts + m)
```

Two terms, two jobs. **Shrinkage** (`shrunk_fail_rate`) decides *whether to trust the rate*: a
raw rate over a tiny sample is noise wearing a confident hat (1 attempt / 1 fail = "100%"), so
each rate is pulled toward the measured global fail rate `C` by an amount that fades as the
sample grows — an extreme rate must be *earned* with volume. `m` (the prior strength, in units
of attempts; env `OMWA_RANK_PRIOR_M`, default 10) is the crossover point where a topic's own
data and the global prior weigh equally. **`log(attempts)`** decides *how much the trusted rate
matters* — "look here first" is triage, so exposure counts; `log` (not raw attempts) so sheer
popularity can't bury a savage-but-moderately-played topic, and `log(1) = 0` makes a single
attempt score **exactly zero**. Both defences fire on noise at once: its rate is shrunk toward
average *and* its volume weight is ~0.

**Why a heuristic, not ML:** no labels (nothing has ever been tagged "stuck") and a population
of one (`10 §3.3`) — there is nothing honest for a model to learn. Every term is inspectable and
defensible, which is the point of leading Phase 4 with ranking rather than an LLM.

### The pure-function / handler split

`api/src/stats/ranking.ts` keeps the entire heuristic (`C`, shrinkage, `log`, sort) in a **pure
`rankTopics(rows, m)` function** — no DB, no I/O — and the handler is a thin wrapper that feeds it
rows. Two payoffs: the scoring *rule* is the portfolio-legible part and is **unit-tested on a
hand-computable 3-row fixture** (`ranking.test.ts`, Node's built-in runner, 5/5) whose headline
assertion is that **the topic with the highest raw failure rate ranks dead last**; and the ranker
is testable with no database. `C` is computed from the *same rows the handler already fetched* —
summing them **is** the global aggregate — so there is no second query.

**No new SQL, no new index.** The handler reuses the exact index-only `byTopic` GroupAggregate
`/stats/confrontations` already tuned (`events_confrontation_cols_idx` over the stored
`suspect`/`topic`/`passed` generated columns — see `06`). `GET /stats/ranking` →
`{ globalFailRate, priorStrength, ranked[] }`; each `ranked` row carries every ingredient
(`attempts`, `fails`, `raw_fail_rate`, `shrunk_fail_rate`, `volume_weight`, `stuck_score`) so the
UI can *explain* the order rather than show a bare number.

### The view (`RankingList.tsx`)

First section on `/mods/ccff`, above Confrontations — "look here first" goes first.

- **A pure Server Component — no Recharts, no `'use client'`.** It is ordered data with a
  proportional bar, which a Server Component + a CSS width does better than a charting library:
  zero JS shipped, and the drill-downs stay plain `<Link>`s (URL-as-state, like the friction
  table). You reach for Recharts for an interactive plot; a ranked list is not that.
- **A ranked list that exposes the ingredients, not a bar chart of the score.** The score is a
  *composite*; a bare bar would hide *why* a row ranks where it does. The row shows `n` and
  **raw → adjusted fail rate side by side** — shrinkage visibly at work (a thin extreme rate
  dragged back toward `C`; a well-supported row barely moves). Doc `10 §2` (every view ends in a
  decision) and `§3.3` (sample size beside every rate) in one layout.
- **The meter** encodes `stuck_score` *relative to the top row* (a scan, not an absolute scale);
  single-hue magnitude bar from the same validated blue ramp as `FrictionCharts` (page reads as
  one system), theme-aware via `dark:` — **no `matchMedia`**, because a Server Component has no
  client hooks and needs none for a CSS colour. Text stays in ink tokens, never the bar colour.
- **Degradation:** `getRankingStats()` fetches concurrently (`Promise.all`) with the same
  `live | snapshot | unavailable` contract as friction/skills; the snapshot script captures
  `/stats/ranking` too but is not allowed to fail on it (a deployed API may predate it).

### Verification state (2026-07-24)

API `tsc` + **5/5 tests**; dashboard `tsc` + `next build` clean (`/mods/[modId]` stays `ƒ`);
**SSR'd `/mods/ccff` against the live local API** — `globalFailRate 0.7486`, meters descending
`100% → 90.1% → 89.7% …`, `200`, no errors. ⚠️ **Two honest limits:** the local dataset is
synthetic and **all high-`n`, so raw ≈ adjusted there** — the shrinkage *gap* is proven by the
unit-test fixture, **not visible in this data**; and it was **not visually eyeballed** (no
browser), verified by SSR HTML only, like §6. **Not yet deployed**, and the number is not
meaningful until real players exist (`10 §3.3`).

---

## 8. Corpus search view (`/search`, 2026-07-27)

The first user-reachable surface over the pgvector corpus (`11`). Built decision-by-decision with
the learner making each call; the four decisions are recorded here because each one has a
defensible alternative that a reviewer would reasonably ask about.

**Files:** `app/lib/search.ts` (typed client, no snapshot fallback) · `app/search/page.tsx`
(Server Component, `searchParams`) · `app/search/SearchBox.tsx` (`'use client'`) ·
`app/search/SearchResults.tsx` (async Server Component — the part that suspends).

### The four decisions

| # | decision | rejected alternative | why |
| --- | --- | --- | --- |
| 1 | **Submit-only, URL holds `q`** | type-ahead with debounce | **filter vs query** — filtering narrows a set the client already holds; querying crosses the network to an OpenAI call + HNSW scan. A debounce long enough to protect that backend has already destroyed the type-ahead feel it exists to provide. |
| 2 | **`router.push` from a Client Component** | `<form method="get">` (zero JS) | a full document load is **additive** with the ~2.6 s embedding round-trip, not an alternative to it; and it forfeits the Suspense pending state. |
| 3 | **Scoped `<Suspense key={q}>` + `useTransition`** | `loading.tsx`; or keeping stale results visible | an *explicit* submit means the user is done with the old set, and post-submit stale results are **indistinguishable from a finished search** → reads as silent failure, invites re-submission. `loading.tsx` would also unmount the box that owns `isPending`. |
| 4 | **Accept the cold-query latency** | stream lexical first, then hybrid | staged streaming reorders results while the user is reading them — a worse version of the same problem decision 3 rejects. |

⚠️ **`key={q}` is load-bearing.** Without it, `?q=a` → `?q=b` leaves React updating the same
component in place, so the fallback never re-shows and the page sits on stale results.

### Measured (local, 2026-07-27)

| path | latency |
| --- | --- |
| novel query (cold) | **~2,640 ms** — OpenAI embedding dominates |
| repeat query | **9 ms** (`search.ts` query-vector cache, 500 entries) |
| Postgres half alone | **~3 ms** |

>99% of a first-time search is the embedding round-trip; Postgres does ~3 ms of real work. The
documented estimate in `11` was ~1,100 ms — one cold sample measured 2,638 ms, which includes TLS
setup and lazy provider construction. Flagged, not yet a corrected figure.

### Degradation, made visible rather than silent

`mode: 'lexical'` (embedding unavailable) renders an explicit **"word-match only — meaning search
unavailable"** badge. Results are still useful, but a user who cannot tell the semantic half is
missing cannot interpret what they are seeing. Upstream errors render an explicit banner — there
is deliberately **no snapshot fallback**, because a stale search result is not slightly-old data,
it is *an answer to a different question*.

`lexical_rank` / `vector_rank` are surfaced per hit as badges. This is RRF's payoff over a
weighted sum: `text #1 · meaning #62` is renderable, `0.0325` is not. Verified live — `Company
Guard` returns for *guards demanding bribes* with `lexical_rank: null, vector_rank: 1`, i.e. found
**only** by meaning.

✅ **Duplicate-text handling was already solved server-side**, not in the UI as the step-8 note
assumed: `search.ts` partitions by `text_hash` (`rn_text = 1`) alongside the parent rollup on
`record_id`. Verified — 185 chunks carry the literal text `Chest`; a search for `chest` returns one.

### Verified / not verified

✅ `tsc --noEmit`, `next build`, eslint, 52/52 API tests, SSR against the live local API.
✅ Interactive behaviour (pending state, skeleton re-suspend, Back restoring input text) confirmed
by the learner in a browser.
⚠️ **Prod:** see `09` — the live API pod predates `GET /search` and the deployment carries no
`OPENAI_API_KEY`.

## 9. Content gaps (`/gaps`, 2026-08-09)

The surface for Q3.6 and for Phase 4c's generated layer (`12`). A pure Server Component — it
fetches on the server, renders once, and ships no JavaScript.

Both fetches run concurrently, and **a failure of the insights half must not blank the page**: the
gate numbers are computed and trustworthy on their own, so the generated layer degrades to nothing
while the measurements still render.

### Rendering rules that are product decisions, not styling

1. **`reachable: UNKNOWN` RENDERS.** Not hidden, not greyed out, not collapsed into "no". Absence of
   data must never read as absence of placement.
2. **`NOT_PLACED` is labelled "Not found in the world", never "unreachable".** Merchants are
   deliberately outside the survey (`11 §13`), so a remedy that appears nowhere may still be
   purchasable. Collapsing that in the UI would be the exact overclaim `/stats/sufficiency` was
   built to avoid, arriving through the front end instead.
3. **Sample size sits next to every rate-like number** (`10 §3.3`) — `Failures` is the first stat on
   each card because every other number is only as good as it.
4. **The API's `reachability_note` is rendered verbatim.** A UI that dropped it would be making a
   claim the API did not.
5. **Truncation is stated outright** — "the worst 25 of 6,687 gates".
6. **A generated insight is badged.** It renders in the same font and the same confident register as
   the computed numbers beside it; the badge is the only thing telling a reader which is which. The
   cited `record_id`s are shown so the claim can be checked rather than trusted.
7. **"No reviewed insight for this gate yet"** is written out. A blank space would let a reader
   choose between "nothing was generated" and "the model found nothing" — different facts.

### ⚠️ No snapshot fallback

Stronger than `/search`'s reasoning. A stale gap analysis is not slightly-old data: it is a claim
about **what the game contains**, made against a corpus that may since have been re-ingested. "No
remedy exists for this gate" is exactly what a mod author would act on by writing content. When
upstream is down the page says so and shows nothing.

### ⭐⭐ The React key is the full gate grain

`key={gateKey(g)}` over `(check_id, stat, stat_kind, threshold)` — **not `check_id`**. One
`check_id` is up to sixteen gates (`12 §6`), so keying on it duplicated 11 of 25 keys *and* handed
the `security@25` insight to the `shortblade@25` card: a real-looking, actionable recommendation
about the wrong gate. Verified by SSR against the live API: **25 cards, 25 distinct grains, 14
distinct check_ids.**

## 10. The landing page (2026-08-09) — and why it does not lead with "AI"

`/` was a mod list: honest, and it buried everything. The obvious rebuild was a hero banner
announcing the LLM layer, since that is the newest part. **Deliberately not done.**

⭐ **The honest description of the model's role is modest** — one question out of six pipeline
steps, four of which are SQL. Leading with "AI" invites *"so what does the model actually do?"*,
and the true answer then reads as a let-down. Leading with the **finding** — a skill check nothing
in the loaded content can satisfy — and *then* showing a model earning a narrow, defensible keep is
the stronger claim, because it survives being asked about.

The target role's brief is explicit about *"balancing human and technology intelligence"*, which
reads as wariness of reaching for ML where a heuristic does. **Restraint about where a model
belongs is the thing worth demonstrating**, not enthusiasm for having used one.

Order, where each section justifies the next:

1. **The finding** — `luck 100`, 70-point p90 shortfall, no remedy in base + Tribunal + Bloodmoon +
   CCFF. Selected from live data, not hardcoded: if it stops being true the section disappears
   rather than asserting it.
2. **How it gets there** — the pull pipeline, six steps, ending at the corpus join.
3. **Where a language model earns its keep** — the approved insight, with the ratio stated plainly:
   four of six steps are queries; the model gets a fixed payload, no tools, one question.
4. **The registry** — the mod list, with the synthetic banner.

### ⚠️ Two things the page deliberately does

**The banner sits above the registry, not at the top.** It labels the volume figures, which include
seeded rows. At page top it would read as applying to the finding — and that section is computed
from real play only. Placement is the difference between a true label and a false one.

**No hardcoded corpus count.** The first draft read *"47,732 game records"*, the figure from the
design docs. Prod actually holds **47,747** — the corpus has been re-ingested since. A constant in
the copy sitting beside live-fetched numbers is derived-artefact drift in the presentation layer,
and it would be stale again after the next ingest. It now says the same thing qualitatively.
▶ If a count is wanted, fetch it; do not write it down.
