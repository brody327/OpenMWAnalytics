# Learning Log

A running record of concepts taught and quiz results, so we can revisit weak spots.
Newest first.

## 2026-07-20 — Public URL, dashboard deploy, and the loop closed in the cloud (`09`, `07`, `04`)

Finished the deploy: **`https://omwanalytics.com`** (dashboard) over
**`https://api.omwanalytics.com`** (API), both on auto-renewing TLS, serving real
gameplay events end-to-end.

**Concepts covered (cloud/DNS is the growth area — taught step-by-step):**
- **Elastic IP** — EC2's default public IP is a *lease* reclaimed on stop; an EIP is
  account-owned and remappable, so DNS survives stop/start. Unattached EIPs bill; since
  Feb 2024 *all* public IPv4 bills (free-tier allowance for 12 months).
- **The four layers of "a URL"** — stable address (EIP), name (DNS), routing (Ingress),
  certificate (ACME). Naming them separately is most of the clarity.
- **Ingress is a routing *rule*, not a proxy** — the controller (Traefik) reconfigures
  itself to match. Why not NodePort (random port, no TLS) or k3s `LoadBalancer`/Klipper
  (one Service owns :443). Ingress shares :80/:443 and centralizes TLS.
- **ACME / HTTP-01** — LE issues a token, cert-manager serves it at
  `/.well-known/acme-challenge/`, **LE fetches it inbound from the public internet**
  (hence :80 open to `0.0.0.0/0`, not My-IP). 90-day certs force automation by design.
  DNS-01 is the alternative when :80 can't open or a wildcard is needed.
- **CNAME flattening** — a CNAME at the apex is illegal DNS (apex must hold SOA/NS);
  Cloudflare resolves it server-side and answers with A records. Declined Vercel's
  nameserver delegation: it would strip Cloudflare's authority and take the `api` A
  record — and its cert renewal — with it.
- **Verify DNS by resolving it, not by reading the dashboard** — the dashboard shows
  intent; `nslookup` shows what the world sees. Also how to confirm "grey cloud": if the
  answer is *your* IP, it isn't proxied.
- **`next dev` doesn't gate on type errors; `next build` does** — and contextual typing
  beats hand-restating a library's union (my own annotation was wrong twice: missed `null`).
- **`ƒ` vs `○` in the build summary** is the proof of rendering mode (dynamic vs static).
- **Bounded fetches** — a *stopped* host drops packets rather than refusing them, so an
  unbounded fetch **hangs** instead of failing. `AbortSignal.timeout` converts an
  indefinite wait into a handleable error.
- **Threat models change on deploy** — `POST /events` went from "unreachable on localhost"
  to world-writable. The security property was never in the code; it was in the topology.

**Checkpoint quiz: 2 / 2.** ✅

| Q | Topic | Result |
| --- | --- | --- |
| 1 | Why :80 must be world-open despite serving on :443 (LE fetches the challenge inbound over plain HTTP) | ✅ |
| 2 | Valid cert + 404 ⇒ TLS/SNI matching and backend routing are separate steps | ✅ |

**Two debugging lessons, both the same shape — *test through the layer production uses*:**
1. The `omwa-api` **Service had never existed**. Last session's `kubectl port-forward
   deploy/…` talks straight to the pod and skips the Service, so it validated a path
   production doesn't use. Surfaced only when the Ingress needed it.
2. A play session's events reached `openmw.log` but not Postgres — **the shipper wasn't
   running**. The tell was the *absence* of `.ship-state.json`, which is written on every
   poll even when a chunk has zero events: **an artifact written each iteration is a free
   liveness probe.** Recovery was one seeded checkpoint, safe only because at-least-once
   delivery meets an idempotent sink (`inserted: 8, duplicates: 0`) — the July reliability
   work paying for itself.

Rhymes with 2026-07-18's *"I saw the log line" proves the emitter, not the pipeline.*

---

## 2026-07-19 — Deploy: API live on k3s + RDS (`09`)

Took the platform from "runs on my laptop" to "running in AWS." End state: containerized
API on single-node **k3s** (EC2), pulling from **GHCR** via **GitHub Actions**, connected to
managed **RDS Postgres** over TLS — verified by a DB-backed query served from the pod. Public
URL (Ingress) is the remaining piece.

**Concepts covered (cloud/Linux is the user's growth area — taught step-by-step):**
- **Security groups grant by identity, not address** — RDS 5432 allowed *from the EC2's
  security group*, not an IP; stable across reboots, least-privilege, never `0.0.0.0/0`. SG
  rules are also stateful (return traffic implied).
- **The VPC boundary** — the pod reaches RDS over the private network (inside the VPC); the
  laptop is an outsider, which is why the one-off schema migration needed *temporary* RDS
  public access + a laptop-IP rule, then reverted.
- **Container registry = npm for images** — image≈package, GHCR≈npmjs, push≈publish,
  pull≈install, tag≈version. Push auth via the auto per-run `GITHUB_TOKEN` (no stored PAT);
  pull is anonymous → **package must be Public** (separate from repo visibility) or k3s
  `401`s → `ImagePullBackOff`.
- **`:latest` vs `:<sha>`** — sha is immutable/traceable/rollback-able; latest is a moving
  pointer. CI stamps both.
- **k8s object model** — Deployment (desired state + rollouts + self-healing), Service
  (stable address in front of ephemeral pods), Secret (credential out of image *and* git;
  base64 not encrypted by default). Readiness gates *traffic*; liveness triggers *restart*.
- **RDS TLS** — pg needs `ssl`; used `rejectUnauthorized:false` (encrypted, cert not
  verified) gated on `DATABASE_SSL` so local dev stays plaintext.
- **Capacity is a first-class constraint** — 1 GB `t3.micro` can't hold k3s (~600–750 MB
  idle) + any workload; presented as thrash → API-server timeouts → `kubectl` "hangs."
  Fixed with swap (headroom) then **right-sizing to `t3.small`** via in-place instance-type
  change (disk/k3s/swap persist). Chose x86 `t3.small` over cheaper arm64 `t4g.small`
  because images are architecture-specific.
- **CI failure triage** — build broke on the retired `type=gha` cache backend (a
  build-speed optimization), not the app; removed it. Distinguished `ImagePullBackOff`
  (fetch) from `CrashLoopBackOff` (app died after start).

**Quiz:** 8/8 across two rounds (SG-by-identity, VPC boundary, ImagePullBackOff cause,
tag tradeoff, readiness-vs-liveness, Secret boundary, TLS tradeoff, CI token). A third
whole-process quiz follows. **Feedback captured:** randomize the correct-answer position in
quizzes (don't always place it first).

**Cost note:** `t3.small` not free 24/7 → instance stopped between sessions. **Next:**
Ingress + TLS + public URL (needs an Elastic IP for a stable address), then wire the
dashboard (Vercel) + local shipper at it.

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

---

## 2026-07-20 — Analytics product design, sequence SQL, ops (a long session)

**Concepts covered.** Question inventory / metric tree (decision → question → metric
→ event) and inverting a registry from bottom-up to top-down; the denominator problem
(engagement vs **exposure** events); why a pass-rate cannot separate good difficulty from
bad (the discriminator is post-failure behaviour); **margin** vs pass/fail, and raw-vs-derived
storage ("precompute at write time only what you cannot reconstruct at read time");
window functions (`LEAD`, `ROW_NUMBER`) over `(session_id, seq)`; `WHERE` runs *before*
window functions (hence the CTE); de-duplicating to the unit the question is about; ordinal
vs categorical colour encoding; ingest auth threat modelling (what a client-side secret can
and cannot buy) and **fail-closed** defaults; k8s secrets are read at container **start**;
ingest provenance (`env`) as server-stamped metadata rather than an envelope field.

**No formal quiz this session** — it was execution-heavy. The teaching landed in design
docs `10` (new), `05` (auth threat model), `06` (`env`), `07 §4c/§5c`.

**Recurring failure mode, hit FIVE times — worth naming as the session's lesson:**
*silence that looks like success.*

| Instance | How it presented |
| --- | --- |
| `pkill` on Windows | reported success, left the process listening → read stale output twice |
| Chart dropped an unnamed bucket | a real abandonment looked like "this never happens" |
| `LEAD` met an event type with no `CASE` branch | signal fell into `other`, then was discarded |
| Placeholder `<TOKEN>` / `<NEW_PASSWORD>` pasted literally | command succeeded; the "secret" was public |
| Scheduled Task ran with a bare environment | `OMWA_ENV` would have silently reverted to `prod` |

Every one behaved correctly under manual testing and did the wrong thing unattended.
The countermeasures now encoded: render unmatched buckets instead of dropping them,
verify the **value** not the exit code, source config from a file rather than the
environment, and check *"is the thing I am testing the thing I think I am testing?"* first.

**Also learned by doing:** verify a credential at the lowest layer that can prove it
(one `psql`) BEFORE adding layers — testing two unknowns at once cost four rounds; and
never read a credentials file (a redaction regex leaked two passwords into a transcript,
forcing a rotation).

**Delegation experiment** (`SkillCheckResolved` Lua half via subagent): worth it for this
task shape. Its most valuable output was a **gap in the spec** it found by executing it —
the passive multi-stat path retains no deciding stat when nothing clears the awareness
floor. Verdict recorded in memory: delegate work whose difficulty is in the DOING; keep
work whose difficulty is in the DECIDING.

---

## 2026-07-21 — Postgres performance: plans, selectivity, index-only scans

**Concepts covered:** the planner is cost-based, not rule-based (why a seq scan is *correct*
on a small table); **selectivity** as the deciding factor for whether an index helps; index
vs heap ("the catalogue tells you the shelf, not what's inside the book"); Bitmap Index Scan
vs Index Scan vs **Index Only Scan**; `Buffers: hit` (cache) vs `read` (physical) as the real
cost signal; warm-vs-cold measurement discipline; the visibility map's role in index-only
scans; partial indexes; stored generated columns; `GroupAggregate` vs `HashAggregate` and
sorted input; every index as a tax on writes.

**Checkpoint quiz 1: 3 / 3** — why volume was a prerequisite (a seq scan is genuinely optimal
at 100 rows, so nothing is measurable); why an index-using query still read 29,555 heap blocks
(grouping keys live in `data` in the heap, not the index); why no index fixes `/stats/friction`
(its filter matches ~99% of rows — nothing to narrow).

**Checkpoint quiz 2: 3 / 3** — why the expression index barely helped (Postgres cannot
*return* an expression's value from an index-only scan); why `GroupAggregate` beat
`HashAggregate` (index supplied the ordering, no hash table); why the endpoint gained only 2×
against the query's 13× (a second unoptimised query, and a response waits for its slowest part).

**6 / 6 overall — ⚠️ AND THE SCORE WAS MISLEADING.** The learner reported afterwards that
they *"barely followed any of it."* Recorded here because the failure is instructive:

- **Multiple choice tests recognition, not understanding.** Options can be eliminated and
  pattern-matched without following any mechanism. The correct answers were also consistently
  the longest and most detailed — a tell that can be exploited with zero comprehension.
- **The session was demonstration, not instruction.** Commands were run, output shown and
  conclusions narrated at speed. The learner watched a debugging session rather than
  participating in one.
- **Missed signal:** no clarifying questions were asked throughout. Genuine engagement with
  unfamiliar mechanics almost always generates questions; silence was read as agreement.

**Action: this material is to be re-taught granularly next session, before any new topic.**
Assessment must move to prediction ("what plan will this produce, and why?"), explain-back in
the learner's own words, and hands-on driving — not multiple choice.
Contrast with the 2 / 4 on 2026-07-14 — the storage-mapping concept that was weak then
(envelope → columns, payload → JSONB, and what that costs at query time) is now the concept
being *applied* to decide where to promote a key out of JSONB.

**The method worth keeping**, since it generalises past Postgres: measure warm and repeated;
change ONE thing; when the result surprises you, **shrink the query until the behaviour
changes** (`count(*)` vs selecting the expression isolated the real cause in one step); and
force the planner's hand (`enable_bitmapscan = off`) as a *diagnostic* to see what the
alternative would have cost — confirming the planner was right, rather than assuming it wrong.

---

## 2026-07-21 (later) — RE-TEACH round 1: selectivity, correlation, scan types

Re-teach of the material above, run under `.claude/skills/teach/SKILL.md`. **No multiple
choice.** Every command was preceded by a prediction; the learner drove psql directly in
their own terminal.

**Method change that mattered:** shrank the example. Started on a **5-row** table, moved to
a purpose-built 1M-row `big` / `big_shuf` pair with exactly one variable between them —
rather than the real `events` table, where several effects are tangled together.

**Assessments and results:**

| # | Type | Question | Result |
| --- | --- | --- | --- |
| 1 | Prediction | Will a 5-row table use its index? | ✅ correct, with mechanism unprompted ("touching two things, seq scan is cheaper") |
| 2 | Prediction | 1M rows: index for `n=42` (1 row) vs `n>0` (999,998)? | ✅ both correct; **described selectivity before being given the word** |
| 3 | Estimate | At what % of the table does the index stop winning? | "50%" — came out *right on `big`*, but for the wrong reason (see below) |
| 4 | Prediction | Shuffle physical order — where does the flip move? | ❌ **"75%, then seq"** — wrong direction. The productive error of the session. |
| 5 | Explain-back | Why is a forced bitmap scan *worse* on the correlated table? | ✅ correct (missed only the cost side: materialization + recheck) |
| 6 | Transfer | Which `events` column has correlation ≈ 1, and what does that buy? | ✅ `received_at`; needed one correction — it makes *range* queries cheap, not selects generally |

**Diagnosed gap → the real lesson.** Q3/Q4 exposed that "index vs seq" was understood as a
function of **selectivity alone**. The `big` table was accidentally a best case: built with
`generate_series`, so physical order matched index order (`correlation` ≈ 1.0) and index
scans stayed optimal past 50% — which *validated a wrong model*. Shuffling the same rows
(`ORDER BY random()`, correlation ≈ 0) collapsed plain `Index Scan` from >50% to **below
0.1%**, and the same 0.1% query went from **cost 40 → 2,787 (70×)** with identical data,
index, and result set.

That reframed the index's value: **finding the rows was never the expensive part** (the
Bitmap Index Scan cost 20 of that 2,787) — avoiding **random heap I/O** is. `Bitmap Heap Scan`
then arrived as the answer to precisely the problem the learner had already named in Q1:
collect row locations first, then sweep the heap in physical page order once.

**Order of access patterns established:** Index Scan (needs correlation) → Bitmap (batches
hops into page order, pays `Recheck Cond`) → Seq Scan (skip the index entirely).

**Still to re-cover:** Index Only Scan + the visibility map; `Buffers: hit` vs `read`; warm vs
cold measurement; ⭐ the core finding (an expression index can filter/order/count but cannot
*return* the expression's value); stored generated columns + partial index; why the endpoint
gained 2× against the query's 13×.

**Noted for later:** correlation on an append-only event table is the seed of **time-based
partitioning** — flagged, deliberately not taught yet.

### 2026-07-21 (later, cont.) — RE-TEACH round 2: Index Only Scan, visibility map, VACUUM

Continued straight on from round 1, same method (predict → run → explain-back, learner driving psql).

**Concepts:** Index Only Scan as a *fourth*, cheapest access pattern (never touches the heap);
covering — index-only requires every SELECTed column to live in the index; the **visibility
map** (per-page "all-visible" bits, maintained by **VACUUM**) as what lets an index-only scan
skip the heap; `Heap Fetches` as the tell; **autovacuum** as a background, asynchronous process
decoupled from queries.

**Assessments:**
- Prediction: what changes between `SELECT *` and `SELECT n` on the same filter? → after one
  nudge off "selectivity" (the WHERE was identical), got it cleanly: "it never looks in the
  heap because n is already in the index." ✅
- Prediction: will an Index Only Scan still show nonzero `Heap Fetches`, and why? → guessed the
  *shape* right ("there's a stored thing that lets it skip the heap") but two details off:
  thought it was lazily cached on first read (it's maintained ahead of time by VACUUM) and
  per-row (it's per-page). Corrected.
- ⭐ **Productive surprise #2:** predicted `Heap Fetches` ≈ full set on the fresh table; it came
  back **0** *before* the manual VACUUM. Cause: **autovacuum had already fired in the
  background** (`last_autovacuum` populated in `pg_stat_user_tables`) — the experiment was
  contaminated by the very process under study. Re-staged on a fresh table queried in the same
  breath: **Bitmap Heap Scan, Heap Blocks=929, 52 ms → (VACUUM) → Index Only Scan, Heap
  Fetches: 0, 0.135 ms — ~385× from one VACUUM.** The planner itself declined index-only while
  the VM was cold, which taught that VM state is an *input to planning*, not just runtime.
- Page-count prediction: 1,000 scattered rows (correlation ≈ 0) → ~1,000 distinct pages.
  Actual `Heap Blocks: exact=929`. ✅ magnitude, not just direction.

**Explain-back (transfer):** "a friend's append-only events table has a slow SELECT" — produced
a correct decision tree unprompted: inspect schema, index the timestamp, tiny→seq, matches-most
→seq, low-correlation+few-rows→bitmap, correlated+ordered→index.

**One diagnosed conflation, corrected:** fused "correlated" with "index-only." Split them —
**correlation** decides whether heap hops are cheap (plain Index Scan); the **SELECT list**
decides whether you hop at all (Index Only Scan). Independent knobs; a query can have either
without the other. This is the exact hinge for the next concept (the ⭐ core finding: an
expression index can filter/order/count but cannot *return* the expression's value).

**Contrast with the 2026-07-21 (earlier) 6/6 that the learner "barely followed":** this time
every claim was earned by a prediction the learner committed to before seeing output, two of
which were wrong in instructive ways. The wrong predictions are the evidence the model is real.

### 2026-07-21 (later, cont.) — RE-TEACH round 3: the ⭐ core finding (expression index vs generated column)

Grounded on a 200k-row toy (`ev`) with BOTH an expression index `((data->>'grp'))` and a
generated `grp text GENERATED ALWAYS AS (data->>'grp') STORED` + plain index, VM warmed.

**Measured on this Postgres 16 (all four, same filter `= 'g7'`, ~2000 rows):**

| Setup | Query | Plan | Heap access | Time |
| --- | --- | --- | --- | --- |
| Expression index | count(*) | Bitmap Heap Scan | Heap Blocks 1470 | 1.4 ms |
| Expression index | return value | Bitmap Heap Scan | Heap Blocks 1470 | 1.5 ms |
| Generated column | count(*) | **Index Only Scan** | **Heap Fetches 0** | 0.17 ms |
| Generated column | return value | **Index Only Scan** | **Heap Fetches 0** | 0.14 ms |

**⚠️ HONEST CORRECTION to the 2026-07-21 (earlier) notes.** Those recorded the finding as
"an expression index can filter/order/COUNT but cannot RETURN the expression's value." On this
PG16 the split is sharper: **an expression index gets NO index-only scan at all** — not even
for `count(*)` — and forcing the planner (`enable_bitmapscan=off; enable_seqscan=off`) made it
choose a plain heap-touching Index Scan rather than index-only. The expression index is still
used to *filter* (the Bitmap Index Scan step), but never index-only. Materializing the same
expression into a **stored generated column** flips BOTH count and return to Index Only Scan,
zero heap fetches, ~10×. Same conclusion the earlier session reached (use generated columns),
cleaner mechanism. This is why `events.suspect`/`events.topic` are generated columns, not a
bare expression index.

**Assessments:**
- Prediction (pre-run): "both index-only; count 0 fetches, return full fetches." ❌ — assumed
  the expression index behaves like a real-column index. Reality: expression index isn't
  index-only for EITHER. The productive error that motivated the whole reveal.
- Explain-back + transfer: "teammate wants a bare index on `data->>'status'`" → correctly said
  it'll still do heap fetches / bitmap, fix is a generated stored column + plain index, and
  **spontaneously re-applied it to a new example** (`evidence_type` in the blob). ✅ Strong.
- Added (not yet assessed): the WRITE-COST tradeoff — generated columns cost storage + write
  time, so promote a JSONB key to a generated column only when it's HOT (design docs/06 §2).

**Measurement discipline modelled live (three contaminated runs, each surfaced honestly):**
`VACUUM` silently failed inside psql's implicit txn block ("cannot run inside a transaction
block") → cold VM; `enable_bitmapscan=off` used as a diagnostic to see the forced alternative;
autovacuum (round 2) had pre-warmed a table we meant to measure cold. Each contamination was
named and re-staged rather than narrated past — the exact opposite of the original session.

**Still not re-covered (next):** `Buffers: hit` vs `read`; warm/cold timing on the REAL
confrontation aggregate; why the optimized endpoint gained ~2× against the query's ~13×
(second unoptimised query; a response is bounded by its slowest part).

### 2026-07-21 (later, cont.) — RE-TEACH round 4: Buffers, warm/cold, endpoint-bounded-by-slowest

Grounded on the REAL `/stats/confrontations` endpoint (`api/src/stats/confrontations.ts`),
both queries, `EXPLAIN (ANALYZE, BUFFERS)`.

**Concepts:** `shared hit` (in shared_buffers) vs `shared read` (had to read in); buffers count
= a **stable measure of work (blocks touched)**, time = noisy/cache-dependent — hence measure
warm & repeated, warm-vs-warm; the **OS page cache as a second layer below shared_buffers**
(`read` can stay high on a warm run yet be fast — "read" ≠ "slow disk", only "not in Postgres's
own cache"); a response is **bounded by its slowest part** (two sequential `await`ed queries →
~57ms + ~90ms).

**Live numbers:** byTopic cold `read=31106` 1164 ms → warm 57 ms (buffers ~unchanged); byReason
warm ~90 ms, `read=31106`. Endpoint ≈ sum. So optimizing byTopic alone caps the endpoint win at
byReason's floor — the concrete "query 13× → endpoint ~2×" mechanism.

**Assessments:**
- Prediction (cold vs warm read count): explained the buffer cache correctly in own words
  ("it already read it the first time, so the second is faster thanks to the buffer"). ✅
- Prediction + transfer (why is byReason slow, what's the fix): fix correct (generated column +
  plain index on `reason`), tradeoff-exists correct, storage-cost-unavoidable correct.
- ❌→✅ **One inverted-logic error, corrected:** conflated READ frequency with WRITE frequency —
  claimed "hitting it more often may make it not worth it." Straightened: read-freq feeds the
  BENEFIT, write-freq feeds the COST; they're independent clocks on opposite sides. "Hot" =
  read-hot. Applied to events (analytics table, read-hot, write-tolerant) → materializing
  `reason` IS justified.

**⚠️ TWO stale claims in the codebase surfaced by live measurement — real TODOs:**
1. `confrontations.ts` lines 22–26 comment repeats the OLD core-finding framing ("cannot RETURN
   an expression's value from an index-only scan") and claims "29,670 buffers -> 116, ~90ms ->
   ~7ms." **Does not reproduce:** byTopic currently does a Parallel Bitmap Heap Scan reading
   31,106 blocks (57 ms warm), NOT an ~116-buffer index-only scan — because it needs
   `data->>'passed'` (passes/pass_rate), which lives in the HEAP, not in
   `events_confrontation_cols_idx (suspect, topic)`. The recorded 13× is stale/aspirational.
2. `byReason` is un-optimized (groups on JSONB `data->>'reason'`, no generated column/index).

**Project TODOs that fell out of the lesson (for tonight):** (a) fix the misleading comment in
confrontations.ts to the corrected mechanism; (b) decide/execute promoting `passed` to a
generated column so byTopic can approach index-only; (c) promote `reason` likewise for byReason.

### 2026-07-21 (later, cont.) — APPLIED IT: the re-teach's TODOs, shipped

The re-teach surfaced stale/false claims and two un-optimised queries; the learner then drove
fixing all three, smallest->biggest, choosing designs and predicting each measurement.

1. **Corrected the false mechanism** in confrontations.ts, schema.ts, and design docs/06 (the
   "expression index can COUNT but not RETURN" framing -> "expression index gets NO index-only
   scan at all; a stored generated column does"). Removed brittle buffer numbers that had
   already gone stale once.
2. **Promoted `reason` + `passed`** to stored generated columns (Option B, learner's call:
   reusable across both queries beats a one-off baked-in predicate BECAUSE a second consumer was
   known to be coming). Index (passed, reason) -> byReason 31,106->85 buffers, ~91->~7 ms,
   Bitmap Heap->Index Only, Hash->GroupAggregate.
3. **Extended the byTopic index to (suspect, topic, passed)** -> byTopic 31,345->118 buffers,
   ~59->~14 ms, fully index-only. Read side switched to reference the columns (not data->>).
   **Endpoint ~148 ms -> ~21 ms (~7x)** -- the concrete "bounded by its slowest part" payoff:
   round 1's one-query fix capped at 2x; fixing both moved it.

**Assessment quality (all prediction/explain-back, learner driving):** correctly diagnosed the
post-push Bitmap-Heap-Scan as a cold-VM-after-rewrite (recall from round 2) and named VACUUM as
the fix AND warm-to-warm as the measurement discipline -- unprompted. Chose Option B with correct
read-vs-write-frequency reasoning, and spontaneously raised the read-hot+write-hot case,
re-deriving the async-rollup answer (exactly the queued /stats/friction plan).

**Mistakes made & caught (mine):** backticks inside a sql template literal broke the TS build;
drizzle-kit push needs a TTY and tried to drop the teaching toy tables (dropped them first).
npm run build surfaced the first immediately -- the "verify, don't assume" habit paying off.

### 2026-07-21 (later, cont.) — Friction rollup: precomputation when indexes can't help

Continued the same day into the resume's still-false bullet (precomputation/materialized rollups),
same method: teach the design before code, prediction/explain-back throughout, learner chose the
design fork.

**Concepts:** row-local vs row-relational work (why `LEAD`/`ROW_NUMBER` can't be index-narrowed --
each output depends on a NEIGHBOUR row, not a seekable value); append-only + per-session-partition
immutability as what makes incremental rollup CORRECT; decomposable aggregates (store sum+count,
derive avg; AVG ignores NULLs so its denominator differs from count; percentiles/COUNT DISTINCT
don't decompose); **watermark with allowed lateness** (named the stream-processing term for the
learner's own instinct); the done-guard as exactly-once/idempotency one layer up from ON CONFLICT.

**Assessments:**
- Transfer (why can't an index help here?): partially right ("failure isn't a specific thing to
  index") -- corrected: we DID index failure (`passed`); the real reason is neighbour-dependence.
- Explain-back (the wasteful thing): nailed -- "we rebuild the whole thing every load when it
  doesn't change unless there's something new."
- ❌ **Key misconception, corrected:** thought a NEW session could change a PRIOR session's friction
  ("they come back and solve it"). It can't -- the window partitions by `session_id` and each launch
  mints a new one, so `LEAD` never crosses sessions. This was THE hinge of the whole design; worth
  the time it took. (The learner's cross-session point survives as a real doc-10 analytics question,
  parked.)
- Design fork: chose Option B (incremental table) over a materialized view, with correct reasoning
  (reusable/deeper, matches the resume bullet).
- Good architectural instinct raised unprompted: "just emit a SessionEnded event." Addressed
  seriously -- it's a valid v2 optimisation but not a replacement, because crashes/alt-F4 emit
  nothing AND async shipping means "game done" != "we have all events". Taught: in an async pipeline
  you can't KNOW you've seen everything, only wait a bounded time -> the watermark is unavoidable.
- Honestly flagged not knowing what `LEAD` does after reasoning about it for a while -- taught it
  concretely ("look at the next row"); should have checked this earlier.

**Built + PROVEN (not asserted):** afterFailure rollup end-to-end -- correctness by symmetric EXCEPT
diff = 0/0 vs the live query; idempotency by a 2nd run folding 0 sessions with buckets unchanged;
776 ms -> ~0.3 ms (~2,700x). The rollup read is a Seq Scan on 239 rows -- and that is CORRECT,
closing the loop with the night's very first `tiny`-table lesson.

**Deferred:** attemptsToPass rollup (now the endpoint's tall pole, ~324 ms -- same pattern),
scheduling the fold, the SessionEnded enhancement, the cross-session analytics question.

**Process note (learner request, 2026-07-21):** wants periodic RECALL REFRESHERS -- short retrieval
checks on material from PAST sessions, not just the current one. Space them out; spaced retrieval is
exactly what the false-6/6 episode showed was missing. Good candidates to spiral back on:
selectivity, correlation, the four scan types, index-only + visibility map/VACUUM, decomposable
aggregates, and the watermark/immutability argument.

### 2026-07-22 — RECALL REFRESHER (spaced retrieval) + the attemptsToPass rollup

Learner opened by requesting the refresher they'd asked for on 07-21: scan types, rollup,
"materialize", VACUUM, visibility map vs bitmap. Delivered as a written refresher (as asked) with
a 4-question retrieval set appended — no multiple choice.

**Refresher content:** the four scan types framed by one question (*how many heap pages must I
touch?*), including that Seq Scan is not a failure mode; visibility map vs bitmap side by side
(persistent/on-disk/VACUUM-maintained/MVCC vs ephemeral/in-memory/per-execution/I-O-ordering);
VACUUM's four jobs with ANALYZE separated out; **"materialize" disambiguated into three senses**
(materialize a value = stored generated column; materialized view; the `Materialize` plan node) —
that overload was the likely source of the fog; rollup as incremental precomputation and why
matview REFRESH was rejected.

**Retrieval results:**
- ✅ Q1 (Index Only Scan with nonzero Heap Fetches): diagnosed cold VM + named VACUUM, confident
  and unprompted. This is now RETAINED across sessions, not just recognised in the moment.
- ✅ Q4 (bitmap): "how are these rows organized amongst these different pages" — essentially right.
- ⚠️ Q4 (VM): said "can we currently see this page". Corrected: visibility is per-SNAPSHOT, which
  a persistent shared bit cannot encode; the VM asks *is every row version on this page visible to
  EVERY transaction*. Reader-independent, all-or-nothing, conservative.
- ❌ Q2 (why sum+count not avg): had the RULE verbatim, could not walk the mechanism, and said so.
  Honest self-report — the useful thing to say. Re-taught by shrinking to 4 numbers (A: 10/20/30,
  B: 100 -> truth 40s, avg-of-avgs 60s) and naming the missing idea: **an average has discarded its
  WEIGHT, and count IS the weight**; once discarded it cannot be re-weighted. Added the NULL half
  (`AVG` ignores NULLs -> denominator is gap_count, not count).
- ❌ Q3 (median): conflated median with COUNT DISTINCT. Corrected — same list, unrelated
  operations; median-of-medians (2 vs 51 on the same tiny example) and, crucially, **no extra
  column rescues it**, unlike avg. But the learner's closing instinct ("you may be able to derive
  median during the query itself") was the right thread and got promoted into the day's main idea.

**Design fork (the real lesson): GRAIN.** Reframed "can I roll this up?" as "**what grain do I roll
up to**", rule: *never collapse past the grain that retains an aggregate's inputs* — a
generalisation of round 3's decomposable-aggregates rule. Learner chose per-session (Option B).

**Transfer check on `max`:** asked why `max` is the fragile one given it IS decomposable. Learner
answered with the general grain point (correct, but the point already made) and missed the specific
property. Taught: **`sum`/`count` are invertible, `max` is not** — a mis-folded session can be
subtracted out of a sum, but a stored max can only be repaired by full recompute. Grounded in a
real hazard here (1M `env='synthetic'` rows in the same table, `/stats/*` doesn't filter env).

**Prediction before measuring the new read plan:** ✅ predicted Seq Scan, ✅ said an index on
`(suspect, topic)` would not help. ❌ **Mechanism slip worth watching**: justified it with *"it's
gotta look at almost all the events to know what came after"* — but the read query has NO window
function any more; that work moved to fold time. The Seq Scan is justified by SELECTIVITY alone
(no WHERE -> 100% of rows). **Right answer, mechanism borrowed from the previous slide** — the same
shape as 07-21's "failure isn't a specific thing to index". Recurring pattern; flag it again.
Timing prediction (~0.3 ms) was optimistic — actual 11.5 ms, because this table is 72,255 rows vs
afterFailure's 239. That gap IS the Option B cost, and naming it was more useful than a hit.

**Shipped:** `friction_attempts_rollup` + fold in the same transaction/`_settled` set as
`friction_rollup`. attemptsToPass ~324 ms -> ~11.5 ms (~28x); **endpoint ~1,100 ms -> ~14 ms
(~78x)** — "bounded by its slowest part" demonstrated a second time, since round 3 alone left the
endpoint pinned at ~330 ms. Proven: symmetric EXCEPT 0/0 vs live; idempotent re-run folds 0; and a
full truncate-and-rebuild reproduced the previously-verified `friction_rollup` 0/0, showing the
fold is deterministic and "recompute from source" is always available as a repair.

**Still not re-covered / next refresher candidates:** selectivity + correlation (why the planner
picks Bitmap over Index Scan), `work_mem` and lossy bitmaps, GroupAggregate vs HashAggregate.

### 2026-07-22 (later) — Scheduling, `install_id`, and a self-inflicted production 500

**Built:** the CronJob scheduler, `install_id` on `friction_attempts_rollup`, and the prod deploy.

**Teaching moment 1 — concurrency, and a "defensive fix" that would corrupt data.** Asked the
learner to predict what two simultaneous folds do. They correctly said neither rollup ends up
double-counted, and correctly singled out step 3's missing `ON CONFLICT` as the odd thing — but
read it as a *bug* ("we don't want that"). It is load-bearing. Traced it concretely: `T2` DOES
double-add into `friction_rollup`; what saves it is step 3 raising a unique violation and rolling
the single transaction back. So adding `ON CONFLICT DO NOTHING` there — which looks purely
defensive and is exactly what a reviewer would suggest — would commit the doubling silently.
Added a `⚠️ DO NOT ADD` comment and an advisory lock (framed explicitly as *tidiness, not
correctness*: it turns a crash into a quiet wait). Proven with 3 concurrent folds.

**Teaching moment 2 — the grain decision paid off within the hour.** Doc 10 Q1.7 (cross-session
comeback) had been parked as "invisible to a session-partitioned window". Resolved it by
separating the ORDERED question (window partitioned by `install_id` — would break the rollup's
correctness argument, since a new session could change a prior partition's answer, so nothing is
ever frozen) from the SET-BASED question (`bool_or` grouped by install at read over rows that are
individually frozen — costs the rollup nothing). Answerable *only* because round 4 kept the
session grain.

**⚠️ MY ERROR, and the honest version: I caused a production outage.** I deployed an image whose
schema prerequisites were not in RDS. I created the three rollup tables but not the **stored
generated columns on `events`** (`suspect`/`topic`/`reason`/`passed`) that the perf work added
locally. Result: `/stats/confrontations` — an endpoint this session never edited — returned 500
in production until I applied the DDL. `/stats/friction` failed more quietly, `200` with empty
arrays, because its tables existed but the fold crashed on the same columns.

Root cause is a **process gap, not a typo**: `db:generate`/`db:migrate` are wired up but no
`drizzle/` migration has ever been generated, so schema is applied by hand and nothing links "code
merged" to "schema applied". CI/CD ships code automatically and schema by memory. Written up in
`09 §7` with a checklist, and generating a migration baseline + a pre-rollout Job is now the top
deploy priority. Rule recorded: **schema lands first and must be backward-compatible**, because
both versions run simultaneously during a rollout (two pods were briefly Running here).

**A second mistake worth logging (mine):** I first reported the deploy as "stale image — missing
entrypoint". It was not. `kubectl get pod -l app=... -o jsonpath={.items[0]}` had selected the
OLD, terminating pod. The image was correct all along. Lesson: when checking a rollout, filter to
the Running pod and compare the image *digest* — `items[0]` is not "the current pod".

**Verified after the fix:** all four endpoints 200 with real data; fold ran (10 settled sessions);
CronJob armed at `*/5`; 0 null `install_id`, 1 distinct install (the author — correct).
