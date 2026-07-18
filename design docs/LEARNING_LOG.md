# Learning Log

A running record of concepts taught and quiz results, so we can revisit weak spots.
Newest first.

## 2026-07-18 (cont.) — Dashboard: query API + Next.js consumer (`07`)

Built the read side: `GET /stats/confrontations` (Express, aggregation SQL) + a
Next.js App Router dashboard consuming it. First view = confrontation pass-rate.
Verified: page SSRs live data (3 attempts, 0% pass, topic "name_at_scene").

**Concepts covered:**
- **Event store vs analytics API** — the query endpoint returns *answers*
  (`{topic, attempts, pass_rate}`), never raw rows; aggregation happens in SQL where
  the index + data live. JSONB extraction in GROUP BY, `avg(bool::int)` for a rate,
  `count(*) FILTER (WHERE …)` for slices in one scan.
- **Clean consumer/producer boundary** — Express owns data access; Next.js is a pure
  consumer. A **Server Component fetches the API server-side** (no CORS, nothing
  secret in the browser) and passes plain data to a `'use client'` Recharts component.
  We deliberately did NOT query Postgres from Next — that would split data access.
- **RSC as the fetch boundary; `'use client'` as the interactivity boundary** — charts
  (SVG + hooks) must be client; the page stays a server component.
- **Read the version's own docs, not memory** — this was Next.js **16** (newer than
  training); its `AGENTS.md` said read `node_modules/next/dist/docs/` first. Did so —
  confirmed fetch-is-uncached-by-default and current RSC/data patterns before coding.
- **Recharts + CSS vars gotcha** — `var()` doesn't resolve in SVG *presentation
  attributes*, so theme colors are detected in-component (matchMedia) and passed as
  concrete hexes from the dataviz skill's validated palette.

Frontend is the user's wheelhouse (senior Angular/TS), so teaching stayed on the query
layer. **No quiz** (frontend not the learning target). Stack = Next.js by user choice
(target-job alignment).

**Next:** richer confrontation data (passes, pattern-kind, more suspects) from play;
more `/stats/*` views (AreaEntered); the passive/auto `SkillProgression` event.

## 2026-07-18 (cont.) — Shipper reliability: at-least-once delivery (`04`)

Fixed the shipper gap that dropped session `ce7bd7c4` (and a worse latent bug).
Rewrote `ship.mjs`; wrote `04_SHIPPER_DESIGN.md`. Verified with a deterministic
mock-API + synthetic-log harness (all D1/D2/D3 checks pass) — logic proven without
touching Postgres.

**Concepts covered:**
- **Delivery semantics** — at-most-once vs at-least-once vs exactly-once. The old
  shipper advanced its offset *before* the POST → accidental at-most-once → silent
  loss when the API was down. Fix = **post-then-checkpoint** (advance only on 2xx).
- **At-least-once + idempotent sink = effectively-once** — retry is only safe because
  the API upserts on `(session_id, seq)`. *Idempotency upstream is what licenses retry
  downstream.* Re-sends are harmless no-ops; no exactly-once machinery needed.
- **Retry falls out of not-advancing** — leaving the offset put on failure *is* the
  retry; the poll loop re-reads next tick. No separate retry queue.
- **Durable checkpoint** — offset persisted to a sidecar via temp-file + atomic
  rename (a crash never leaves a half-written checkpoint); resume beats start-at-EOF.
- **File-identity, not size, detects rotation** — `openmw.log` is recreated each
  launch; `size < offset` misses a relaunch that grew past the old offset (the live
  bug). Fingerprint the first line (per-launch banner) → robust new-file detection.
- **The log is the durable buffer** — if the API is down, events wait in `openmw.log`;
  no separate on-disk spool / backpressure needed at this scale.

**No quiz this turn.** Candidate revisit later: contrast this pull/at-least-once model
with a push/ack model (e.g. why a broker would change the guarantees).

## 2026-07-18 — SDK extraction: public `OMWA_Track` ingress + `track.lua` (+ shipper gap surfaced)

Promoted the proven `OMWA_Emit` seam into a public SDK, *extracted from* the working
CCFF integration. Shipped: `track.lua` (require-able `track(type, data)` helper),
`telemetry.lua` single **validated** `OMWA_Track` ingress (retired `OMWA_Emit`),
`player.lua` dogfooded onto it, CCFF refactored to the guarded helper. Verified live:
`AreaEntered` (first-party) and `ConfrontationAttempted` (third-party) both land.

**Concepts covered:**
- **Event vs interface for a cross-context API** — OpenMW `interface`s are shared only
  *within* one script context (global↔global / player↔player). Instrumentation lives
  in local/player scripts; the collector is global. So the public transport *must* be
  a global event; the `require`-able helper is ergonomics wrapping that event, not the
  contract itself.
- **A `require`-based SDK reintroduces a load-time hard dependency** — the raw event
  degraded gracefully for free (unhandled = nothing). `require()` of an absent module
  *raises*, so a third party must **guard the require** (`pcall`) or an uninstalled
  analytics mod breaks *their* script load. Ergonomics and coupling trade off.
- **Single validated ingress + validate at the boundary you own** — one path
  (`OMWA_Track`) for first- and third-party alike; `telemetry.lua` re-validates
  (shape + ≤32 keys / ≤2048 bytes, drop-and-log, `seq` not consumed). The helper runs
  in the caller's untrusted context, so its checks are DX only.
- **Dogfooding** — routing our own `AreaEntered` through the public helper means we
  exercise the same path we ask third parties to use.

**Verify gotcha (the real lesson):** the live test's events reached `openmw.log` but
**not Postgres** — the *shipper* missed the whole session. A game **restart truncates
`openmw.log`**, and the shipper's non-durable byte offset + coarse `size < offset`
truncation heuristic dropped it. Recovered manually with a one-off `replay.mjs`
(54/54 inserted), which *proved the SDK output is DB-valid* and isolated the fault to
delivery state, not the SDK. **"I saw the log line" proves the emitter, never the
pipeline.** This is the `04_SHIPPER_DESIGN.md` reliability gap, now hit live → promoted
to the next task.

**Checkpoint quiz (prior turn): 3/3.** No new quiz this turn.

**Next:** shipper reliability (`04`) — durable offset across restarts (persist offset +
a file fingerprint), replay-on-truncation, retry/backoff. Turn `replay.mjs` into
automatic recovery.

## 2026-07-17 — First third-party event: CCFF → `ConfrontationAttempted` (manual instrumentation)

Instrumented a *separate* mod (CCFF's `confront_panel.lua`) to emit telemetry into
OMWA, and verified the row landing in Postgres live. First time an event was authored
by a mod *other than ours* — the doc-08 "mod → platform" graduation, made concrete.
The CCFF check is a **bespoke evidence-deduction contest, not an engine skill roll**
→ opaque to passive capture → must emit manually over the `OMWA_Emit` seam. One
guarded helper + 8 call sites (2 fact-jab, 6 pattern); zero API/DB change.

**Concepts covered:**
- **Auto vs manual instrumentation, and why the sandbox forces the choice** — OpenMW
  isolates every script, so a foreign mod's *custom* logic can't be observed from
  outside; it has to call *us*. Built-in mechanics (skills, combat) would go the
  passive/engine-hook route instead.
- **Emit-on-fail is not cardinality bloat when failure IS the question** — grain
  discipline kills *low-information* events, not *high-information* ones. Failed
  attempts are the difficulty/funnel signal; pass-only telemetry is blind to
  drop-off. "Volume" and "signal" are different axes.
- **Extract the SDK from a working integration, don't design it ahead of one** —
  deferring `track.lua` until a real consumer exists (YAGNI) means the eventual
  public contract generalizes from *observed* needs, not guesses. Minimal raw emit
  first; promote to contract second.
- **Validate at the trust boundary you own** — a semi-trusted third party can't be
  relied on to self-limit its payloads. Validation belongs at *our* emitter (the
  seam where every foreign event converges and identity/`seq` already live), not in
  the untrusted caller, and not (as the authoritative boundary) downstream in the
  shipper/DB. Defense-in-depth downstream is fine; ownership of the contract is not.
- **Fire-and-forget cross-mod coupling** — the emit is a guarded `pcall` inserted
  *alongside* CCFF's logic, never replacing a branch; if OMWA isn't installed the
  global event is simply unhandled. A telemetry call must never be able to break its host.

**Ops gotcha (verify):** the pipeline was silently DOWN — only `drizzle-kit studio`
was running; API + shipper were both dead, so the game logged into a void. Lesson:
"I see the log line" proves the *emitter*, not the *pipeline*. The shipper's
start-at-EOF design also means a fresh attempt is needed after (re)starting it — old
log lines aren't replayed.

**Checkpoint quiz: 3/3** — grain (fails carry the signal), SDK timing (extract from
a real caller), trust boundary (validate at our seam). All chosen over plausible
traps. No weak spots.

**Next:** the SDK extraction (doc 08 §5) — promote `OMWA_Emit` → stable `OMWA_Track`,
ship `scripts/omwanalytics/track.lua` (`track(type, data)`), registry-as-public-contract,
emitter-side payload validation; then refactor CCFF's 8 call sites through the helper
as the first real SDK consumer. Possibly pair with `packages/contract` (step 3).

## 2026-07-16 — Scalability restructure: git + monorepo workspace (steps 1–2)

Put the project under git + GitHub (`github.com/brody327/OpenMWAnalytics`) and
restructured into an npm-workspaces monorepo, isolating the OpenMW-loaded files
under `mod/` so the game sees only the mod, not the platform code. Verified
in-game: fresh launch loaded both scripts from `mod/` (no Lua/JS edits needed).

**Concepts covered:**
- **Repo topology vs deployment topology are independent axes** — "runs in a
  different place" does not imply "belongs in a different repo." Split the two
  questions before deciding.
- **The real coupling boundary** isn't website-vs-mod; it's *ship-to-players
  (frozen at install, un-updatable)* vs *operate-yourself (continuously
  deployable)*. The `OMWA1` wire envelope is the API between those two worlds.
- **Monorepo vs polyrepo as cost/benefit, not dogma** — polyrepo buys independent
  deploy + access control; with one committer that benefit is unspendable and the
  cost (cross-repo contract changes, version skew) is pure overhead. Defer the
  split until a real forcing function appears.
- **Portfolio signal** — building the *seams* (workspace boundaries, shared
  contract) while *skipping the ceremony* (polyrepo) is the senior/staff move; the
  reflex to over-split reads as junior.
- **`data=` is a pointer; paths resolve relative to the VFS root** — re-pointing
  `data=` at `mod/` kept `scripts/omwanalytics/...` valid with zero code edits.
  General principle: relative paths + a relocatable root = portable code.
- **git hygiene** — gitignore `.env` *before* it ever holds a real secret (history
  is permanent); `src refspec main does not match any` = no commits yet, not a
  GitHub problem (a branch is only real once it has a commit).

**Checkpoint quiz: 3/3** — repo-topology justification, wire-version compatibility
(frozen-client asymmetry), and VFS path resolution. All reasoned answers over the
plausible traps. No weak spots to revisit.

**Next:** step 3 — extract `packages/contract` (Zod + TS types) as the single
JS/TS source of truth for the envelope (Lua stays the one cross-language mirror);
then step 4 — internal `track.lua` helper. Optional: physically relocate the repo
out of the game data dir (user-driven).

## 2026-07-15 — Instrumentation model (`08`) — design discussion

**Concepts covered:** OpenMW **sandbox isolation** (no cross-script access, no
monkey-patching) as the constraint that shapes everything; **auto- vs manual-
instrumentation** (observe from outside via engine hooks/interfaces, vs. the code
emits its own events); the coverage split — built-in mechanics (skills via
`SkillProgression`, combat, crimes, dialogue, activation) are passively observable,
custom mod logic (puzzles, bespoke minigames) is opaque and must emit; `OMWA_Emit`
recognized as the manual-instrumentation seam we already built; the **"mod vs
platform"** shift (only third-party custom logic forces tracking code into the
other mod → OMWA becomes an SDK). **Decision:** keep the seam, defer the public SDK
(YAGNI); next event should exercise the auto path (`SkillProgression`). Recorded in
`08_INSTRUMENTATION.md`.

## 2026-07-15 — First real event `AreaEntered` (`03`): ✅ VERIFIED live

Defined the first product event in a new event registry (`03`) and instrumented it,
touching **zero pipeline code** — the generic transport absorbed a new `type` as
`02` promised. Verified in-game: walking recorded real areas
(`Fastus Retreat, Main House, Top Floor`; `west gash region`; etc.).

**Concepts covered / confirmed:**
- **Event registry = tracking plan** — governed vocabulary over generic transport.
- **Event grain / cardinality** — chose "meaningful area" (region outside / named
  cell inside) over per-cell; live data showed one clean `west gash region` row
  instead of `{gridX,gridY}` noise. Grain is a deliberate signal-vs-volume decision.
- **Global vs local script context** — detection must be player-side (`self.cell`);
  identity + the single `seq` stream stay global. Player script *forwards* via
  `core.sendGlobalEvent('OMWA_Emit', …)`; global `eventHandlers` calls `emit()`.
  Confirmed by interleaved `seq` (AreaEntered at 2,24,27,35,38; gaps = Heartbeats +
  no-change polls on one shared counter).
- **"first-seen emits immediately"** — seq 1 `SpikeStarted`, seq 2 first
  `AreaEntered` (starting area, `lastKey`=nil).
- **Deferred display-name polish** validated: `cell.region` returns a lowercase id
  (`west gash region`); prettifying belongs to the dashboard, not the emitter.

MVP ingest half now carries a real product event end-to-end. Next: `07_DASHBOARD.md`
(visualize `AreaEntered`).

## 2026-07-15 — Live loop test: ✅ VERIFIED end-to-end

Ran Postgres + API + `ship.mjs` + a real OpenMW launch. Real events landed in
Postgres: `SpikeStarted` (`data` jsonb `{"note":"ingestion spike online"}`) + a
live-climbing stream of `Heartbeat`s. The full game→log→shipper→API→Postgres loop
works. Evidence captured:

- **Envelope→storage mapping confirmed:** envelope fields → typed columns
  (`session_id, seq, install_id, type, v, ts, received_at`); payload → `data` jsonb.
- **Boundary conversion worked:** wire `ts` epoch-ms (`1784126811000`) → stored
  `timestamptz` UTC (`2026-07-15 14:46:51+00`). (Whole-second granularity because
  `os.time()*1000`.)
- **Event-time vs processing-time made concrete:** `received_at - ts ≈ 1.4s`
  steady lag = shipper 1s poll + processing. Two-timestamp model (doc `02`) observed.
- **Start-at-EOF tradeoff observed in the wild:** one session (`3199fdf3…`) has
  Heartbeats starting at `seq 9` and **no `SpikeStarted`** — the shipper attached at
  EOF mid-session and missed seq 1–8. The clean session (`c4435159…`) caught
  `seq 1` because truncation-detection reset it to the top of the fresh log.
- **Observability lesson (real):** the shipper's `console.log("sent N")` never
  appeared in its redirected output file — Node **block-buffers stdout** to a
  pipe/file (vs. line-buffered to a TTY). The pipeline was working the whole time;
  **ground truth was the database, not the process's stdout.** Don't trust a single
  signal — verify at the sink.

Still deferred (not needed for MVP): durable offset across restarts, retry/backoff.

## 2026-07-14 — Loop-closing shipper + real emitter (built, NOT yet live-tested)

**What we built:** the pieces that close the full game→log→shipper→API→Postgres
loop, in code — but we stopped **before running it live in-game**, so nothing has
been observed end-to-end yet. Pending next session.

- `shipper/ship.mjs` — real shipper (replaces print-only `tail-spike.mjs`): tails
  `openmw.log`, extracts `OMWA1` lines, and **POSTs batches to `/events`**. Has
  offset tracking + truncation detection (log is overwritten each launch), starts
  at EOF (ships only what happens after it starts), one batch POST per 1s poll.
  Deliberately *not yet*: durable offset across restarts, retry/backoff on failure.
- `scripts/omwanalytics/telemetry.lua` — emitter upgraded to the **real wire
  contract**: `snake_case` keys (`install_id`, `session_id`), `v:1`, `seq`, `ts`
  epoch-ms — envelopes the API actually accepts. (Header comment still says
  "spike/throwaway" — stale vs. the body; still emits `SpikeStarted` + `Heartbeat`.)

**Pending live test (the next step):** run OpenMW + `ship.mjs` + API together and
confirm a real event row lands in Postgres. Only then mark the loop verified.

**Not yet written:** `03_EVENT_REGISTRY.md` (real first events), `04_SHIPPER_DESIGN.md`.

---

## 2026-07-14 — Ingest API built (`05`) — build milestone

**What we built & ran:** Postgres 16 in Docker; `events` table via Drizzle;
Express 5 `POST /events` with Zod envelope validation + idempotent
`ON CONFLICT (session_id, seq) DO NOTHING`. Live test proved: dedup
(`duplicates:1`), new event type stored with zero DDL (`SkillCheckFailed` → jsonb),
bad uuid → 400, `ts` epoch-ms → `timestamptz` UTC.

**Concepts covered:** parse-don't-validate (Zod validates + narrows types at once);
`.returning()` on an upsert to *observe* dedup; convert-at-the-boundary; Express 5
async error forwarding; `drizzle-kit push` vs generated migrations.

**Milestone quiz: 2 / 2.** ✅ (type-safety begins after `safeParse`; duplicate count
= PK conflict + counting inserted rows.)

---

## 2026-07-14 — Data Model (`06`)

**Concepts covered:** immutable append-only event log; columns+JSONB vs
column-per-field / table-per-type / EAV; `jsonb` (binary, indexable); idempotent
upsert via `PRIMARY KEY (session_id, seq)` + `ON CONFLICT DO NOTHING`; convert-at-
the-boundary (epoch-ms wire → `timestamptz` UTC); denormalized single table +
derive `sessions` later; index-for-your-queries (defer GIN).

**Re-quiz (targeting prior gaps): 3 / 3.** ✅

| Q | Topic | Result |
| --- | --- | --- |
| 1 | Re-send after crash → PK conflict → DO NOTHING | ✅ |
| 2 | New event type needs zero DDL (fields in jsonb) | ✅ |
| 3 | Defer GIN until a query filters inside `data` | ✅ |

**Both 2026-07-14 envelope-quiz gaps (idempotency, storage mapping) are now
closed.** Also resolved open decision `02` §9(1): wire epoch-ms, store `timestamptz`.

---

## 2026-07-14 — Event Envelope (`02`)

**Concepts covered:** envelope/payload split; event-time vs processing-time
(`ts` vs `received_at`); at-least-once delivery + idempotency; dedup key
`(session_id, seq)`; generic transport vs governed vocabulary (tracking plan);
envelope versioning (`v`); "consumers ignore unknown fields".

**Checkpoint quiz: 2 / 4.**

| Q | Topic | Result |
| --- | --- | --- |
| 1 | Group calendar analytics by event-time (`ts`) | ✅ |
| 2 | What prevents duplicate rows under at-least-once | ❌ chose "order by ts"; answer: unique `(session_id, seq)` + upsert |
| 3 | Cost of adding a new event type | ❌ chose "add a column"; answer: nothing in pipeline — registry + emit only |
| 4 | Why transport accepts any `type` | ✅ |

**Diagnosed gap:** both misses reduce to one root concept — **how the
envelope/payload maps onto physical Postgres storage** (envelope → columns +
unique constraint + upsert; payload → JSONB). Q2 is the idempotency/uniqueness
mechanism; Q3 is the JSONB-keeps-schema-stable consequence.

**Action:** prioritize `06_DATA_MODEL.md` (storage strategy: columns vs JSONB,
the unique constraint, upsert/idempotent ingest) to solidify this before moving on.
Re-quiz on idempotency + storage mapping next session.
