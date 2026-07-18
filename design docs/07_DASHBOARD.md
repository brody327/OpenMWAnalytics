# 07 — Dashboard (the query side)

**Status:** 🟡 in progress. Query API endpoint built + verified (`/stats/confrontations`);
Next.js frontend next.

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

## 4. Deferred (YAGNI)

- **Time filters / ranges** on the endpoints — add when there's enough history to slice.
- **Materialized views / rollups** — a live `GROUP BY` is fine at dev volume; reach for a
  matview only when a query gets slow or fans out over millions of rows.
- **AreaEntered / liveness views** — additional `/stats/*` endpoints, same pattern.
- **Auth** — internal tool, single operator; not needed yet.
