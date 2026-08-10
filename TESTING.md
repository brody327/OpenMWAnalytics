# Testing

Four layers, each chosen for what it can actually detect. The organising rule is the same one the
rest of the project runs on:

> **A check is only worth what it can detect.** Before trusting a green check, ask: *would this also
> pass if the thing were broken?* If yes, it is decoration.

That rule is why the suite looks the way it does — and why some obvious tests are deliberately
absent.

---

## The four layers

| Layer | What | Needs | Command |
| --- | --- | --- | --- |
| **Unit** | Pure logic — scoring, classification, validation, parsers | nothing | `npm test --workspace api` |
| **HTTP** | The real Express app over real HTTP: routing, middleware order, auth, rate limiting, idempotency | Postgres | included in the above |
| **Shipper** | At-least-once delivery, durable offset, relaunch detection | nothing | `npm test --workspace shipper` |
| **E2E** | Rendered pages against a running deployment | a live stack | `npm run test:e2e --workspace dashboard` |

**117 API tests. 14 shipper tests. 11 E2E tests.**

### 1. Unit — the judgement, extracted on purpose

Everything unit-tested is a pure function: `rankTopics`, `classifyGate`, `validateInsight`,
`matchGate`, `parseEnvScope`, `parseEsmDump`, the chunker.

That is the architecture, not an accident. **Handlers deliberately delegate their decision to a
pure function** so the interesting part can be tested with no database, no network and no model.
`stats/ranking.ts` is the clearest example: the scoring heuristic is a DB-free export, and the
handler is a thin wrapper around a query that feeds it.

```bash
npm test --workspace api          # all of it
npm run --workspace api db:up     # Postgres, for the DB-backed subset
```

### 2. HTTP — the plumbing the unit tests cannot reach

`api/src/http.test.ts` boots the real app on an ephemeral port and drives it over `fetch`.

This exists because extracting the judgement leaves the *plumbing* unverified — routing, middleware
**order**, auth, rate limiting, envelope validation, the error handler. None of it is reachable by
importing a function, and all of it fails silently.

`index.ts` exports `app` and only calls `listen()` when it is the process entrypoint. Binding a
port at import time would make the app untestable: the test would start a real server on 4000,
collide with a dev instance, and leave a handle open that keeps the runner alive.

What it pins, and why each one is worth a line:

- **Idempotent upsert** — posting the same event twice yields **one** row. At-least-once delivery
  guarantees duplicates; if the upsert were not idempotent, every network blip would inflate every
  metric silently, with plausible numbers.
- **The paired allow case** — a *different* `seq` in the same session is two rows. Without it,
  "dedupe works" is satisfiable by dropping everything after the first event.
- **Auth fails closed** — an unset token gives **503**, not 200 and not 401. A missing config must
  break loudly; "auth quietly stopped existing after someone changed an env var" is the classic way
  a control disappears.
- **`/health` carries no rate-limit headers** — the k8s liveness probe hits it every 15s, so a
  limiter there fails the probe, restarts the pod, and the protection becomes the outage. Paired
  with a check that a read route *is* limited, so "no headers" cannot be satisfied by having no
  limiter at all.
- **`/insights` is approved-only** — asserted against `?status=pending`, `?status=all`, `?env=all`.
  "Human review" is only a real claim if no query parameter can widen the filter.

### 3. Shipper — the guarantees, exercised by breaking things

`shipper/ship.test.mjs`. This is the most specific claim in the project — *at-least-once via
post-then-checkpoint, a durable offset, relaunch detection by first-line fingerprint* — and every
part of it is a statement about what happens when something goes **wrong**. None of it can be
confirmed by watching the shipper work on a good day.

⭐ **`post()` is not stubbed; `globalThis.fetch` is.** The real post-then-checkpoint path runs,
including the 2xx check that decides whether the offset moves. Faking `post` would test the fake.

- **A failed POST leaves the offset put** — and the next poll re-sends the same events. Both halves,
  because "the offset stayed" is worthless if the retry never happens.
- **A half-written trailing line is not consumed** — tailing a file the game is actively writing
  *will* catch a line mid-flush. Consuming it would parse half a JSON object and advance past the
  rest, losing the event with only a warning. Paired with: once the line completes, it ships.
- **A relaunch reships from the top even when the new file is LARGER.** This is why the design
  fingerprints the first line rather than checking `size < offset`: a new session can pass the old
  offset before the first poll, and size alone would silently skip the start of every session.
- **A truncation resets too** — same banner, fewer bytes, which only the size check can catch.
- **`loadState` resumes from the checkpoint**, not EOF. Starting at EOF is correct only on a first
  run with no checkpoint.

Two small changes made the file testable: `OMWA_LOG` / `OMWA_STATE_FILE` overrides (so a test
never touches the developer's real log or checkpoint), and guarding the startup block so importing
the module does not begin polling and leave timers open.

### 4. E2E — rendered pages, real stack

```bash
npm run test:e2e --workspace dashboard                    # against production
BASE_URL=http://localhost:3000 npx playwright test        # against a local build
```

**Why Playwright and not Jest + React Testing Library.** Almost every page is an `async` Server
Component that fetches on the server and renders once. RTL has no good story for those — you end up
mocking the fetch layer until the test asserts your own mocks, which is a check that cannot fail.
Seven `'use client'` components are unit-testable and two are worth it, but that is a small slice.

For a mostly-SSR app the honest unit of verification is a rendered page.

**These assert invariants, not snapshots.** The manual checks run while building were
snapshot-shaped — *"exactly 6 gate cards"* — which breaks the moment someone plays the game. Every
assertion is a rule that holds whatever the data does:

- `/gaps` does **not** show the seeded-data banner; `/events` **does**. *(Both directions: without
  the second, deleting the banner entirely would still pass.)*
- On the landing page the finding renders **above** the banner — placement is the difference
  between a true label and a false one.
- Every gate card carries a reachability label. `UNKNOWN` is a value that must render.
- Rendered card count equals the count the page claims ("showing N of M").
- Any rendered insight carries the *Generated · reviewed* badge.
- The merchant caveat from the API is rendered verbatim.

⚠️ **The trade, stated:** these are **not hermetic**. They need something running, and a failure can
mean "the API is down" rather than "the code is wrong". Accepted deliberately — the alternative for
SSR pages is a mock-shaped test that passes whether or not the page works.

---

## Mutation checking — the practice that makes the above worth anything

A test that has never failed has never been shown to work. New tests are verified by **breaking the
thing they guard** and confirming they go red.

Done so far, both directions each time:

| Guard | Mutation | Result |
| --- | --- | --- |
| Citation `lower()` in the insight validator | remove the `toLowerCase()` | 4 tests fail |
| Number whitelist | neuter the condition | 2 tests fail |
| Banner absent from `/gaps` | inject `<SyntheticBanner />` into the page | E2E fails, `Received: 1` |
| Post-then-checkpoint | advance the offset regardless of POST success | 2 shipper tests fail |
| The `env` filter | — | verified by data: `real` 3 gates vs `all` 6,687 |

The reverse direction matters as much. After each mutation the change is reverted and the test must
pass again — otherwise "it fails" might just mean "it always fails".

⚠️ One real trap hit while doing this: after reverting the banner mutation the test *still* failed,
because `next start` was serving the previous build. The code was right and the artifact was stale
— the same class as a Kubernetes pod running an old image. Restart the server, not just the build.

---

## What is deliberately NOT tested

Being explicit, because an unexplained gap looks like an oversight:

| Not tested | Why |
| --- | --- |
| The three Recharts wrappers | Testing them tests Recharts |
| Server Components in jsdom | Covered by E2E against a real render; a mocked version would assert the mocks |
| `stats/confrontations`, `skills`, `friction` SQL | Aggregation over a DB fixture — real cost, low signal. The *shape* decisions are unit-tested |
| Jobs (`migrate`, `backfillModId`, `seedSynthetic`) | Operational scripts, verified by running them and inspecting results |

### ⚠️ Known gaps, ranked

1. **`EventFilters` and `SearchBox`** — real client-side logic (URL state ↔ form state,
   submit-only semantics) with no coverage.
2. **The React-key half of the gate-grain bug.** The E2E test asserts rendered cards are unique on
   `(check_id, stat, stat_kind, threshold)`, which catches duplicated *cards* — but reverting
   `key={gateKey(g)}` to `key={g.check_id}` still renders distinct DOM, and React strips
   duplicate-key warnings from production builds. Catching that needs a dev-server run asserting on
   console output. Recorded rather than quietly overclaimed.
3. **E2E is not in CI.** It needs a browser download and hits production. The natural home is a
   post-deploy smoke step after the existing `/version` assertion.

---

## CI

`.github/workflows/build-api.yml` runs the API suite on every push to `main` that touches the API,
**before** building the image — with a `pgvector/pgvector:pg16` service container, because
`corpus/ingest.test.ts` and `http.test.ts` need a real database.

That gate exists because automating the rollout removed one nobody had designed: previously a human
had to SSH in and restart the deployment, and would presumably not do that with a red suite.
Deleting the human step without adding a test step would have made the pipeline strictly more
dangerous than the footgun it replaced.

The deploy then ends in the check a stale pod cannot pass: `GET /version`, fetched through the
public ingress, must equal the commit that was just built.
