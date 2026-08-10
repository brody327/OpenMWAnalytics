# Testing

Five layers, each chosen for what it can actually detect. The organising rule is the same one the
rest of the project runs on:

> **A check is only worth what it can detect.** Before trusting a green check, ask: *would this also
> pass if the thing were broken?* If yes, it is decoration.

That rule is why the suite looks the way it does — and why some obvious tests are deliberately
absent.

---

## The five layers

| Layer | What | Needs | Command |
| --- | --- | --- | --- |
| **Unit** | Pure logic — scoring, classification, validation, parsers | nothing | `npm test --workspace api` |
| **HTTP** | The real Express app over real HTTP: routing, middleware order, auth, rate limiting, idempotency | Postgres | included in the above |
| **Shipper** | At-least-once delivery, durable offset, relaunch detection | nothing | `npm test --workspace shipper` |
| **Component** | The `'use client'` slice: URL⇄form state, and the React-key check | nothing | `npm test --workspace dashboard` |
| **E2E** | Rendered pages against a running deployment | a live stack | `npm run test:e2e --workspace dashboard` |

**117 API · 14 shipper · 25 component · 45 E2E — 201 tests.** `npm test` at the root runs the
first four; E2E is separate because it needs something deployed.

⭐ **A viewport is an INPUT, and the suite had only ever been run at one value of it.** The header
set a 476px minimum width for the entire site — below that the theme toggle was off-screen and
every page scrolled sideways. Every desktop check stayed green throughout; it was reported by a
human on a phone. `e2e/responsive.spec.ts` now runs all five pages at 320/375/414/768.

⭐ **E2E grew 11 → 24 on 2026-08-10 for a reason worth stating: a class of bug exists that no
other layer can see.** A timestamp formatted without an explicit locale and time zone renders
differently on the server than in the browser — but only when those are different machines. `next
dev` and `next start` run both passes locally, in one zone, with one locale, so the strings always
agree and every local check is green. In production it failed hydration, which made React replace
`<html>`, which silently dropped the theme attribute set before paint. `e2e/theme.spec.ts` runs
each page in `Asia/Kolkata` + `de-DE` precisely so the two sides cannot agree by accident.

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

### 4. Component — the browser-side slice, and the check only a dev build can make

`npm test --workspace dashboard` (Vitest + jsdom + React Testing Library).

Most of this app is `async` Server Components, and jsdom has nothing useful to say about those —
see the Playwright note below. Four files earn a component test:

**`EventFilters`** holds no filter state. It reads filters from the URL and writes new ones back,
and the answer arrives as fresh props from the server. So its entire observable behaviour is *the
URL it hands the router*, and asserting on that is asserting on the component's actual job.

- ⭐⭐ **Changing a filter drops the `cursor`.** A cursor encodes a position within a specific
  ordering of a specific result set. Carried across a filter change it points into a result set
  that no longer exists — the page then returns a wrong slice, with no error, no empty state, and
  entirely plausible rows. Nothing else in the system would catch it.
- **Clearing a filter deletes the param** rather than setting it empty. `?type=` is not the same
  request as no `type`: the empty string still travels upstream, and the failure looks like
  "there is no data".
- Draft session-id commits **on submit, not per keystroke** — otherwise a 36-character uuid costs
  36 round-trips and 36 history entries, and Back needs 36 presses to undo one filter.

**`SearchBox`** — every test is a case where it must decide *not* to search. Hybrid retrieval is
the most expensive query in the platform (tsvector + HNSW probe + RRF fusion), so a needless
search is a wasted round of the costliest work the API does.

⚠️ **Honest note, found by mutation:** an empty box is blocked *twice* — the submit guard and the
disabled button — so the two "empty does not search" tests stay green if either layer alone is
removed. They pin the user-visible contract but cannot detect a single-layer regression. A third
test submits the form directly, past the button, to isolate the guard. This is written down
rather than left as a comfortable assumption.

**`GateList`** exists as a component *because of its test.* The `key=` was inline in
`app/gaps/page.tsx`, an `async` Server Component that cannot be rendered in a test — and a test
that re-implemented the `.map()` would assert on its own copy of the code. Extracting the list
puts the real `key={gateKey(g)}` somewhere a test can reach it.

Why it needs this layer at all: React only emits the duplicate-key warning in a **development**
build. Playwright drives `next start`, a production build, which strips it — so this check is
unavailable at the E2E layer by construction. It was a documented gap until Vitest existed here.

**`SkillCharts.collapseToChecks`** — added 2026-08-10, for the same reason `GateList` was: the
rule was buried in a render, so nothing could hold it.

`/stats/skills` `byCheck` is grained **(check_id, skill, stat_type)** — 205 rows over 21 checks —
while the margin chart claimed one bar per check. Twelve rows drew twelve bars under one axis
label.

⭐ **This one is the argument for the layer, because every other layer is blind to it.** Recharts
sets no React keys, so there is no console warning even in dev — the `GateList` trick above does
not apply. A category axis is not meaningfully assertable from Playwright. The only observation a
broken world cannot produce is *the shape of the collapsed array*, which requires the collapse to
be a function rather than a chain inside JSX.

Eight tests, each mutation-checked: reversing the margin comparison, summing `attempts` across
variants, and dropping the null-margin guard each turn a different subset red.

### 5. E2E — rendered pages, real stack

```bash
npm run test:e2e --workspace dashboard                    # against production
BASE_URL=http://localhost:3000 npx playwright test        # against a local build
```

**Why Playwright carries the pages, and RTL only the client slice.** Almost every page is an
`async` Server Component that fetches on the server and renders once. RTL has no good story for
those — you end up mocking the fetch layer until the test asserts your own mocks, which is a check
that cannot fail. For a mostly-SSR app the honest unit of verification is a rendered page.

The division is by what each tool can actually detect, not by preference: **jsdom for the things
that need a development React build or a simulated interaction** (layer 4), **a real browser
against a real render for everything else**.

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
| Gate React key | `key={gateKey(g)}` → `key={g.check_id}` | 1 test fails, the other 2 stay green |
| Cursor reset on filter change | delete the `params.delete('cursor')` line | 1 test fails |
| Delete-vs-empty param | `params.delete(key)` → `params.set(key, '')` | 2 tests fail |
| SearchBox submit guard | remove the trim/duplicate early return | 2 tests fail (see the caveat above) |
| E2E spec-file guard | drop the SMALLEST spec file from a real report (40 of 45 left) | fails — the total alone still passed |
| E2E spec-file guard | empty report / no report written | fails |
| Margin-chart grain (`collapseToChecks`) | reverse the margin comparison · sum `attempts` · drop the null guard | 1, 2 and 2 tests fail respectively |
| Theme survives load (`/events`) | render `data-theme` as a JSX prop again | fails **only against a deployment** — 6 msgs, all client-nav |
| Responsive header | revert to the single-row `flex-1 flex-wrap` nav | 16 of 21 fail at 320/375/414 |
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

The three gaps this section used to list — the client components, the React-key check, and E2E in
CI — are now layers 4 and 5 and the `smoke` job. What is left:

1. **A filter change is never verified end to end.** Layer 4 proves the component asks for the
   right URL; layer 5 proves pages render. Nothing clicks a filter in a real browser and confirms
   the *feed changes accordingly*, so a broken `/api/events` cursor contract would slip both.
2. **The `smoke` job runs after the rollout**, so it reports rather than prevents. Gating properly
   needs a staging environment, which this project does not have and does not need at one user.
3. **No coverage measurement anywhere.** Deliberate — a coverage number invites writing tests to
   raise it, which is how suites fill up with checks that cannot fail. The gap is recorded because
   "we chose not to" and "we forgot" should not look the same.
4. **`ConfrontationDashboard` is reached through a registry** (`modDashboards.ts`), so a mod whose
   key is missing renders nothing with no error. Untested, and easy to get wrong.

---

## CI

Two workflows, split by what each one deploys.

**`build-api.yml`** — API suite → image → rollout → verify → smoke. The suite runs on every push
to `main` that touches the API, **before** building the image, with a `pgvector/pgvector:pg16`
service container because `corpus/ingest.test.ts` and `http.test.ts` need a real database.

**`dashboard.yml`** — typecheck, Vitest and `next build` on dashboard changes. It is a separate
workflow rather than a wider path filter on the API one: widening that filter would build and
**deploy a new API image** for every dashboard tweak. Before this existed the dashboard had no CI
at all, because the API's path filter correctly ignored it.

⭐ **Both suites are guarded against passing vacuously.** `vitest run` over zero matched files
exits 0, and so does a Playwright run that collects no tests — so a renamed suffix or a broken
glob would read as green. Each job asserts a **minimum collected count** after running. That is
the same failure shape this pipeline has already been bitten by twice: a mutable tag that
triggered no rollout, and a path filter that queued no run. Nothing errored either time; the
Actions tab was simply empty.

⚠️ **That floor was a constant, it went stale, and then a total turned out to be the wrong shape.**
It was 8 against a current 11. By 2026-08-10 the suite was 45 across four files of unequal size
(responsive 21, theme 13, gaps 6, provenance 5) — a floor of 8 would have let the two largest
vanish together and still reported green. But raising it does not fix the property either: a floor
of 30 misses `provenance` disappearing (40 left), and a floor of 41 trips on five deleted tests.
The E2E guard now asserts **the file list** — every spec file present and non-empty — with the
total as a coarse backstop. ▶ Add the filename to `REQUIRED` when you add a spec file
(`09 §11.3`).

⚠️ **And the E2E suite does not run at all for a dashboard-only commit** (`09 §11.5`). The smoke
job lives in the path-filtered API workflow, so a `dashboard/`-only push reaches production via
Vercel having passed a build and the 25 jsdom tests — nothing more. Both production bugs found on
2026-08-10 went through that gap. Running it manually after a dashboard deploy is currently
load-bearing, not optional.

The E2E `smoke` job runs after the rollout and drives the deployed dashboard against the API that
was just shipped. `/version` proves the right *image* is serving; it cannot prove the thing is
*useful* — the correct build can still return a renamed field or a 500 on one route, and the
dashboard is the only consumer that exercises those response shapes.

That gate exists because automating the rollout removed one nobody had designed: previously a human
had to SSH in and restart the deployment, and would presumably not do that with a red suite.
Deleting the human step without adding a test step would have made the pipeline strictly more
dangerous than the footgun it replaced.

The deploy then ends in the check a stale pod cannot pass: `GET /version`, fetched through the
public ingress, must equal the commit that was just built.
