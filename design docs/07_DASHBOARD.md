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
