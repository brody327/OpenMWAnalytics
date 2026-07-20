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

## 4. Serving it when the API is down

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

## 5. Deferred (YAGNI)

- **Time filters / ranges** on the endpoints — add when there's enough history to slice.
- **Materialized views / rollups** — a live `GROUP BY` is fine at dev volume; reach for a
  matview only when a query gets slow or fans out over millions of rows.
- **AreaEntered / liveness views** — additional `/stats/*` endpoints, same pattern.
- **Auth on the read endpoints** — `/stats/*` is deliberately public: it's aggregate,
  anonymous, and being readable is the point of a portfolio dashboard. ⚠️ **Note this is no
  longer true of the *write* path:** deployment moved `POST /events` from "unreachable on
  localhost" to "world-writable on the internet," so anyone can inject fabricated telemetry.
  That is a real open gap — see `09_DEPLOYMENT.md` §6.
