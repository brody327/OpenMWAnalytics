# Learning Log

A running record of concepts taught and quiz results, so we can revisit weak spots.
Newest first.

## 2026-07-26 — 4b refresher round 1 (1.5/4), then verification + schema BUILT

Opened with the **proportional** refresher the learner asked for: 12 unassessed concepts from
07-25, planned as 3 rounds of 4 rather than a reflex 3 questions. **Round 1 scored 1.5/4**, round
2 scored worse, and the learner stopped and said *"I'm feeling out of depth on this topic"* —
which was the correct call and the most useful signal of the session. Rounds 2–3 **parked**;
switched to hands-on build, their demonstrably stronger modality (cf. step 5's psql work).

| # | concept | assessment | result |
| --- | --- | --- | --- |
| 1 | embedding = fixed-size fn; cosine = angle | explain-back | ⚠️ **half** — had "angle", missed magnitude *and* the fixed-size property |
| 2 | Matryoshka truncation | mechanism + prediction | ❌ → taught fresh. **STILL UNASSESSED** |
| 3 | memory arithmetic | hands-on | ⚠️→✅ computed correctly; **found an error in my rule of thumb** |
| 4 | HNSW pointer chase ⇒ residency | prediction | ❌ → ✅ landed (clean transfer to the pre-filter path) |
| 5 | cardinality forces the child table | prediction | ❌ **second miss** — substituted "schema openness" again → re-taught concretely |
| 6 | JSONB range-predicate false match | debug | ⚠️ good partial, **plus an unprompted real find** (nothing filters `type='ALCH'`) |
| 7 | local-first ingest topology | explain-back | ✅ reason right (copyright); given the vocabulary |
| 8 | model-swap idempotency trap | prediction | ❌ **instructively** — see below |

### ⚠️ MY FAILURES, and they compounded

1. **Unexplained jargon again** — `->0` used four times before defining it, and `KNN` never
   defined at all. The learner said *"I don't know what that zero is even looking at."* Second
   session running. CLAUDE.md rule, broken the same way.
2. **I gave two wrong numbers and the learner's arithmetic was the only correct input.** I
   asserted HNSW ≈ 2× the raw column (really ~1.25×) and `shared_buffers` ≈ 256 MB (measured:
   **185 MB**). They computed `34,000 × dims × 4` correctly. Worth noting the decision was
   *robust to being wrong twice in different directions* — 384 wins under every variant.
3. **Asked them to read a row I'd shown 400 words earlier.** "I can't see the thing, you didn't
   show it to me" is a layout failure, not a comprehension failure.

### ⭐ The best diagnosis of the session: a correct rule applied in the wrong place (Q8)

Asked to predict a model swap, the learner said *"the ranking would stay the same, they'll just
see the numbers change."* That is **the log-base lesson from 07-25**, correctly recalled — a
monotonic rescale cannot change a sort order — imported into a context where it does not hold.
A model swap is not a rescale; `3-small` and `3-large` produce vectors in unrelated coordinate
spaces with no mapping between them. This is a *more* encouraging failure than a blank: the rule
is retained and being reached for, it just lacks a boundary condition. **Re-teach as "when does
monotonic-invariance apply?" rather than re-teaching the model swap.**

### ⚠️ Confidence gap, THIRD instance

On Q5 the learner said they'd need *"some sort of for loop over it, but I don't know what that
would be in DDL"*, then abandoned it with *"I'm assuming there isn't one, because why would you
ask the question if it did exist."* **The for loop is rows; a child table is the loop.** They
described the answer and disowned it. Same pattern as step 4's content hash and step 6's
rank-as-currency. Named to them again. This is not a knowledge gap and it will read badly in an
interview.

### Verification-first (the discipline held, and it paid)

Before writing any code, checked what doc 11 had assumed:

| assumption | reality |
| --- | --- |
| RDS permits `CREATE EXTENSION vector`? | ✅ yes — tested in a transaction, **rolled back** |
| pgvector version | **0.8.2** prod / 0.8.5 local ⇒ iterative index scans exist |
| `shared_buffers` ≈ 256 MB | ❌ **185 MB**. Every % in 11 §5 understated; 1536's raw column alone = 113% |
| `maintenance_work_mem` sufficient? | ❌ **64 MB** < the ~65 MB index ⇒ slow on-disk build path |

**Decision on `maintenance_work_mem`: do nothing.** 34,000 rows is tiny; measure before tuning —
the same judgment as heuristic-before-ML. If it ever matters, `SET` it **session-scoped**, never
in the parameter group, because autovacuum workers inherit it (3 × 256 MB on a 1 GB box = OOM,
and on RDS an OOM restarts Postgres). Taught as a *ceiling, not a reservation* — the learner had
it as a permanently reserved block, and had "builds need more than 256 MB" inverted.

**Bonus hazard, caught by a warning nobody had to read:** swapping to the pgvector image moved
glibc 2.41 → 2.36, so every text btree was built under different collation rules than it would
now be searched under — silent wrong answers, on the database we are about to benchmark. Fixed
with `REINDEX DATABASE` + `REFRESH COLLATION VERSION` (5s). **That is the FIFTH instance of one
shape this project keeps meeting:** two sides of a transformation that must agree, failing
quietly when they don't (tsvector config · embedding model · idempotency key · migration
baselining · collation).

### Built

`game_records` / `game_chunks` / `record_effects` + `0005_game_corpus.sql` with a hand-added
`CREATE EXTENSION` (drizzle-kit cannot emit one; a fresh DB would fail at the first
`CREATE TABLE`). Smoke-tested: `tsv` generated `'balmora' 'bribe' 'cosad' 'demand' 'guard'` —
byte-identical to 11 §9's measured output — and the provenance CHECK **rejected** a vector
written without its model, so the model-swap trap is now structurally unreachable rather than
merely documented.

▶ **Still unassessed: 2, 5 (retest), 9, 10, 11, 12.** Do not let the build bury them.

### Later the same day — step 7 prediction checkpoint (`ef_search`)

Three predictions taken before running the recall benchmark.

| Q | assessment | result |
| --- | --- | --- |
| 1 — does recall have a ceiling? | prediction | ⚠️ **my question was ambiguous** — "ceiling" was not defined. Learner reasoned correctly about mechanism ("it's blind to everything outside the candidate list") but did not address the shape |
| 2 — is latency linear in `ef_search`? | prediction | ❌ **answered a different question** (whether the search re-runs). Shape left open |
| 3 — anything awkward about `k=10` with `ef_search=10`? | transfer | ✅ **the strongest answer of the day — see below** |

⭐ **Q3 was genuinely sophisticated, and unprompted.** The learner identified that **recall@k is a
SET metric** — order-insensitive within the returned k — so a 10-candidate list for k=10 leaves
nothing to discriminate, and then named **NDCG@10** as the rank-aware alternative. That is real IR
vocabulary arriving without being taught. The measurement confirmed it: `ef_search=10` is the worst
configuration at **79.9%**, ~10 points below default, because pgvector clamps `ef_search ≥ k` so the
candidate list has zero slack.

Refinement taught in return: **HNSW's approximation is in *which* items it finds, not how it orders
them** (distances are exact for every candidate), so NDCG would largely track recall here — the
instinct is right in general, redundant against *this* approximation.

**New material taught, NOT yet assessed** (add to the unassessed list): recall-via-exact-KNN as
ground truth · why out-of-distribution queries are mandatory · **buffers as the trustworthy cost
signal vs. noisy wall-clock** · TOAST and per-row detoast on a sequential scan · why HNSW's fast
path avoids detoasting entirely.

⚠️ **Two more of my own fake-result bugs today** (5 and 6): queries sampled from the indexed corpus,
and `SET LOCAL` outside a transaction silently doing nothing. Both produced clean, plausible,
completely fake tables. Combined with the test-that-could-not-fail earlier, **the day's real theme
is that "looks right" and "is right" are indistinguishable without an independent check** — a
conservation count, a plan assertion, or a mutation test.

---

## 2026-07-25 (cont.) — Phase 4b designed end-to-end: retrieval, embeddings, hybrid search

A long design session, taught **step-by-step at the learner's explicit request** — *"I want to go
step by step and really interrogate and teach that process instead of just you doing it"* — because
retrieval/embeddings is the first domain in this project with **no senior-level prior to build on**.
Six decisions closed; nothing built. Full design record: **`11_SEARCH_AND_RETRIEVAL.md`**.

**⚠️ MY FAILURE, and the learner caught it.** I opened with four unexplained terms — *corpus*,
*ANN*, *hybrid*, *recall* — then asked for arithmetic using them. The learner stopped and asked
*"what is corpus? what does ANN mean? what are we even building?"* That is exactly the behaviour
the teach skill says to reward (§1: "silence is not agreement"), and exactly the CLAUDE.md rule I
broke ("explain jargon on first use"). The thread stalled until it was fixed. **The tell was that
I had produced no questions from the learner for several turns and read it as agreement.**

### Verification-first work (before any design)

- `esmtool.exe` (ships with OpenMW) dumps the corpus: **~31,000 base-game records + ~500 CCFF**.
- ⚠️ **Killed my own working assumption by checking it.** I was about to design around
  `ConfrontationAttempted.topic` joining to game text. Grep against the plugin dump:
  `crime_scene` / `name_at_scene` appear **zero** times — pure Lua constructs. `suspect` joins
  only by *naming convention* (`titania` → 25 records). `AreaEntered.area` is the one exact key.
- Learner's own idea (buff attribution) produced a **better** join than any of mine:
  `ActiveSpell.id` → `SPEL`/`ALCH`/`ENCH` records, exact.

### Assessment log — one per step, learner drove every decision

| step | concept | assessment | result |
| --- | --- | --- | --- |
| 1 | **grain / chunking** | transfer | ✅ **strong.** Derived the *inverse* failure I hadn't raised — chunking causes false promotion ("one alchemy paragraph in six doesn't make it an alchemy book") |
| 2 | storage sizing on a small instance | estimate | ⚠️ **half.** Right instinct (">768 worries me") without the mechanism; didn't attempt the arithmetic and said so |
| 3a | JSONB vs relational | transfer + debug | ⚠️ **partial.** Picked *schema openness* (a "why it's safe" argument); the structural blocker is **cardinality** — generated columns cannot express one-to-many. Correctly narrowed Q2 to the right two candidates without choosing |
| 3b | filtered ANN / selectivity | prediction ×3 | ✅ **2 of 3, and the third was instructive** — see below |
| 4 | idempotency key | design | ⚠️ **had the answer, distrusted it.** Said "are there changes… that feels naive." It is the answer (content hash). Missed the model-swap trap entirely |
| 5 | `tsvector` config | prediction + **hands-on** | ✅ learner ran the queries in local psql and read the cost correctly |
| 6 | **score fusion** | derivation | ✅ **derived RRF's core insight unprompted** — "maybe using the position in the list as a normalizing variable" |

### Diagnosed gaps + what was done

**⭐ The strongest teaching moment was step 3b Q3.** Asked whether the HNSW index is worth building
*at all* if the telemetry-wired query is the selective one, the learner said **no** — correct for
the premise as stated, and it discards the use case they had themselves argued for two steps
earlier (the consistency search). Resolution taught: *the vector index exists to serve the human
search box; the telemetry recommendation path pre-filters and scans exactly.* Being able to say
**why the index is deliberately not on the flagship feature's hot path** is the portfolio-grade
version of this decision.

**⚠️ Recurring pattern to watch: the learner reaches the right answer and then distrusts it.**
Twice today (step 4's content hash, step 6's rank-as-common-currency) they prefaced a correct
answer with "I'm not sure" / "that feels naive." Named it to them both times. This is a
*confidence* gap, not a knowledge gap, and it will read very differently in an interview.

**⚠️ I had the wrong emphasis and was corrected.** I proposed that `SkillStat.base` + `.modifier`
(two fields) answered the skill-check question. Structurally right, **wrong about what matters**:
the learner's design question is *which vehicle* (potion / spell / enchanted gear), because that
is the actionable part. Verified `Actor.activeSpells()` supports full attribution. Their pushback
also produced the best join key in the project. Recorded in
[[project-next-goal-skill-tracking]].

**⭐ Learner solved a problem I had called unsolvable.** I said avoidance was unobservable
("can't emit an event for a non-event"). They identified that the **inspect panel is a bounded
window with an enumerable choice set** — open, checks are known, close without attempting =
a measured decline. That is the impression→action pattern and the denominator `10 §3.2` was
missing. Written up as `10 §3.2a` + new question 2.5.

### Concepts taught (for a PROPORTIONAL refresher — see the teach skill's new §2 rule)

Assessed today: grain/chunking · filtered ANN + selectivity · `tsvector` configs · RRF derivation.
**Taught but NOT yet assessed** — these are the gaps a next-session quiz must cover:

1. what an embedding *is* (deterministic fn, cosine = angle not magnitude)
2. **Matryoshka truncation** — why 384 dims from a good model beats a weak 384-dim model
3. the memory arithmetic (`shared_buffers` ≈ 256 MB; HNSW ≈ 2× the column; disk is *not* the constraint)
4. **HNSW mechanics** — layered proximity graph, skip-list analogy, *pointer chase* ⇒ residency
5. why *cardinality* (not schema openness) forces the relational child table
6. the JSONB range-predicate **false-match** trap
7. local-first ingest topology (2nd time "data trapped on the client")
8. the **model-swap idempotency trap** + the general rule (key must cover every input)
9. **symmetric vs correct stemming**; `Ald'ruhn` splits; `phraseto_tsquery` and `<->`
10. why multiply turns OR into AND
11. **`k` in RRF ↔ `m` in shrinkage** — the same *shape* of knob
12. RRF favours **consensus**, and that is a choice, not an inheritance

⚠️ **Standing hazard named a fourth time**: unverified migrations → prod 500; the `ORDER BY`
output-alias sort (*correct* results, ~2,000× cost); the staleness metric that climbed forever;
and now the model-swap idempotency trap. **Anything that caches, skips, or short-circuits work
needs its invalidation key audited against every input.**

### Non-teaching decision recorded

**Synthetic data: approved, with a line.** Volume/demo ✅ (via the existing `env` column, banner,
no truncate); supporting a finding or training a model ❌ — *volume is not validity*, and more
synthetic rows make that failure **harder to see**, not easier. See
[[project-synthetic-data-policy]].

---

## 2026-07-25 — SPACED-RETRIEVAL refresher on the stuck-ranking heuristic (4/4)

Learner-requested opener (asked for at the close of 07-24): a **next-day retrieval check** on the
ranking material before starting 4b. Prediction / explain-back / transfer / judgment — **no
multiple choice**, per `.claude/skills/teach` and the false-6/6 precedent. Result **4/4**, and
unlike a same-session score this one crossed a day boundary, so it is real retention.

| Q | assessment | result |
| --- | --- | --- |
| 1 — order a 3-row fixture (A 40/24, B 4/4, C 1/1; m=10, C=0.5) + attribute the mechanism | prediction | order ✅ **A,B,C**; mechanism ❌ |
| 2 — what is `m`, units, and the 200-vs-3-attempt asymmetry | explain-back | ✅ |
| 3 — mod author disputes a 1/1 topic ranking last | transfer | ✅ / follow-up mis-specified by me |
| 4 — "why not just learn the weights?" | judgment | ✅ |

**⚠️ THE REAL GAP (Q1) — one rule doing two jobs.** Learner had a single consolidated rule,
*"shrinkage protects against small samples, log protects against large ones"*, and so attributed
the whole ordering to shrinkage. The fixture was built to break exactly that, and it did:

| sort key | order |
| --- | --- |
| shrunk rate alone | **B (.643), A (.580), C (.545)** ← *not* the answer |
| volume weight alone | **A, B, C** ← the answer |

B has the **highest trusted fail rate of the three and still ranks second**; C's shrunk rate
(.545) sits a hair *below* A's (.580), nowhere near last-place. The log term owns this ordering.
Correction taught: the two terms answer **"do I believe this rate?"** vs. **"given I believe it,
how much does it matter?"** — not small-n vs. large-n. And `log(1)=0` is *also* a small-sample
defense, so the two defenses **overlap** on noise rather than dividing the range neatly.

**It landed immediately** — asked to predict `OMWA_RANK_PRIOR_M=0`, learner predicted "order
barely changes, the log is still doing the work." ✅ Confirmed: 2.21 / 1.386 / 0 → **A, B, C
unchanged**; `m=∞` collapses every rate to C → 1.84 / 0.69 / 0 → **also unchanged**. Both extremes
of the only knob produce the same ranking on this fixture. Learner also derived the inverse
unprompted ("without the log, B goes over A").

**Vocabulary corrections (the "your instinct is right, the standard term is…" pattern):**
- learner's *"trust threshold / trust metric"* → **pseudo-count / prior strength** (equivalent
  sample size); technique = **empirical Bayes shrinkage** ("empirical" = C measured from our own
  data). Dropped *threshold* — it implies a discontinuity; `m` is a continuous dial. But their
  threshold instinct is exactly right at **`n = m`, the crossover** where data and prior weigh 50/50.
- Pinned **`m` is in units of ATTEMPTS**, which is what makes comparing it to `n` meaningful.
  Showed the algebraic rearrangement `shrunk = n/(n+m)·raw + m/(n+m)·C` — a weighted average —
  which converts their correct "+10 to 40 vs +10 to 1" intuition into the interview-ready form
  (n=3 → 77% prior; n=10 → 50/50; n=200 → 4.8% prior).

**Incidental but reusable — `Math.log` is `ln`.** Learner's calculator gave `log₁₀(40)=1.602` vs.
our 3.689. Taught the part that matters: **log base cannot affect a ranking.** `log_b(x)=ln(x)/ln(b)`
is a uniform positive rescale → monotonic → order-invariant; base changes only the printed number.
`log(1)=0` holds in every base. Generalized to: *which transformations are ranking-invariant* —
any monotonic squash (log, sqrt, log1p) is a free swap, argued on shape, never on sort-correctness.
Also corrected `log(0)=0` → undefined/−∞ (harmless here; `attempts ≥ 1` for any row that exists),
and that the log reads `attempts` (40) while the `+m` (50) lives only in the shrinkage denominator.

**⚠️ MY MIS-SPECIFICATION (Q3 follow-up).** *"What would you change if you decided they had a
point?"* was too vague and the learner said so — correctly. Rewritten as the real design question:
*the author has domain knowledge our telemetry does not; "working as intended" is true but
insufficient.* Their answer (remove the log) was **the right lever at the wrong magnitude**, which
made a good menu:

| response | breaks |
| --- | --- |
| remove the log | every 1/1 topic tops the chart — one false negative traded for dozens of false positives |
| **`log1p`: `log(1+attempts)`** → 1 attempt scores `log(2)=0.69` | nothing structural; **the dialed version of the learner's instinct** |
| Wilson lower bound instead of a point estimate | more principled, ~same outcome, more UI to explain — cost without benefit here |
| **second section: "not enough data yet"** | nothing — the main ranking stays clean |
| author-supplied pin / expected-difficulty flag | a new input to maintain |

Lesson taught: **the author is not disputing the ranking, they are asking a different question**
("what is untested" ≠ "where should I look first"), and we only built one view. Overloading one
sort key with two intents makes it answer neither. When a user disputes a ranking, first work out
which question they are asking — changing the sort is the last resort.

**Q4 additions.** Learner had cost/bandwidth + determinism + inspectability + tunability. Added
the two **dataset** properties that end the argument: (1) **no labels** — the target *is* the
judgment we are being asked to produce, so learning it requires already having it; and (2)
**population of one** — a model would learn *this player's style* and present it as a finding
about players (same objection that killed collaborative filtering). Plus the statistical closer:
with ~3 features and a few dozen rows a model has **less information than we already encoded by
hand** — scarce data means hand-specified structure *is* the regularization. And the missing
professional move: **say what would change your mind** (many installs + a real label proxy —
quest abandonment, uninstall, repeated reload at one spot — at which point the heuristic becomes
the baseline to beat).

---

## 2026-07-24 — Shrinkage / Bayesian smoothing (Phase 4a ranking, kickoff)

Opened Phase 4a — *rank the dashboard* ("where are players most stuck," look-here-first).
Chose option A (rank on difficulty = shrunk failure rate × volume) over option B (fold in
post-failure behaviour) — build the scoring spine first, layer §3.1 behaviour later. Learner
asked to be taught **shrinkage** properly before designing the formula.

**Assessment types used:** prediction, explain-back (no multiple choice).

**Break point found via prediction.** First prediction — "m: 10 → 3 on a 1-attempt/1-fail
topic, rate up or down?" — learner was directionally right ("up") but reported honestly: *"I
don't really get what m is… is it just an arbitrary number? I don't get what it's doing there."*
That was the real gap: **the meaning of the pseudo-count `m`**, not the arithmetic.

**Re-taught with a changed representation (protocol §4):**
- Dropped the formula, used the **review analogy** — `m` = how many imaginary *average* reviews
  you pad a 1-review restaurant with before trusting it. Named it a **tuning knob we own**, units
  = attempts, not arbitrary.
- **The dial table** (topic X, m = 0/1/3/10/50) did the real work: `m=0` = no shrinkage / pure
  raw, `m=∞` = everything becomes the global average, every real `m` in between. This directly
  answered "what is m doing there."

**Explain-back — clean pass.** "Why does a 200-attempt topic barely move on the `m` dial while a
1-attempt one swings?" → learner: *"the m effect on X is so heavy because there's such a lack of
sample; more sample and it'd be more stable and wouldn't tune as much."* Correctly located it as
**`m` relative to `n`**, not `m` alone — the tug-of-war framing. Shrinkage landed.

**Also corrected:** learner floated the shrunk rate could exceed 1 — clarified it's a weighted
average of `r` and `C`, so it's bounded between them; a rate > 1 would be a bug.

**Volume half taught + landed.** Why volume at all (triage by impact, not just difficulty) and
linear vs. damped: chose `shrunk_rate × log(attempts)`. Break-point-lite moment on `log(1)`:
learner guessed a 1-attempt topic scores "≈ its shrunk rate"; corrected to `log(1) = 0` → score
exactly 0, and *why* that is the design goal (noise hit by both terms at once).

**Final assessment — clean 3/3 prediction on a hand-computable fixture (no MC).** Built
`stats/ranking.ts` (pure `rankTopics(rows, m)` + thin handler reusing the index-only byTopic
scan) + `GET /stats/ranking` + `ranking.test.ts` (Node built-in runner). Gave the learner the
3-row fixture (C = 0.5, m = 10) and asked for C / full order / noise's exact score. Learner:
**C = 0.5 ✓, order 1→3→2 ✓ (incl. the subtle brutal-popular > easy-popular at similar volume),
noise = 0 ✓.** The heuristic (shrinkage + log-damped volume) is solid. Code green: tsc + 5/5 tests.

**Dashboard view SHIPPED same session (4a fully closed).** `RankingList.tsx` — a pure Server
Component (no 'use client', no Recharts), rendered first on /mods/ccff as "Where players are most
stuck". Teaching points landed in the build: (1) a ranked list that EXPOSES the ingredients (n,
raw→adjusted fail rate side by side = shrinkage visibly at work) beats a bar chart of the
composite score, which would hide the why (doc 10 §2/§3.3); (2) you don't reach for a charting
lib for ordered-data-plus-a-bar — a CSS width meter in a Server Component ships zero JS and the
drill-downs stay URL-as-state; (3) single-hue magnitude meter from the same validated blue ramp
as FrictionCharts, theme-aware via `dark:` (no matchMedia). Data layer: `getRankingStats()` +
snapshot capture, same live/snapshot/unavailable degradation contract as the other three.
**Verified:** api tsc + 5/5 tests, dashboard tsc + `next build` clean, and SSR'd /mods/ccff
against the live local API (globalFailRate 0.7486, meters descending 100%→90.1%→… correctly, 200
no errors). Synthetic local data is all high-n so raw≈adjusted — the shrinkage GAP is proven by
the unit-test fixture, not visible here.

**Next:** doc updates (05/07/10 via /update-docs) + commit, then Phase 4b (pgvector hybrid
search — AI eng + the Postgres perf core qual in one thread).

## 2026-07-23 — React fundamentals: the render model + the server/client boundary (dashboard)

Learner asked (end of prior session) to pause feature work and learn to *read* the
React app: JSX and the execution model were opaque even to a deep Angular/TS senior.
Plan was quiz → line-by-line walkthrough of 3 files, learner driving → then features.

**Assessment types used:** prediction, explain-back, transfer, debug (no multiple choice).

**Opening quiz (5 Q) — honest result: 1 full, 2 partial, 2 wrong.**
- Q3 (transfer, controlled input `value`+`onChange`): **full** — including the frozen-input
  failure mode. Solid.
- Q5 (URL-as-state payoff): **partial** — got *why* URL state is good, missed the concrete
  steps a client-store version would add (navigate → seed store → reconcile existing filters).
- Q4 (server/client boundary): **partial** — right frame, but never found the actual trigger
  (`usePathname()` is a hook ⇒ requires `'use client'`); invented a data-fetch role for layout.
- Q1 (move `LINKS` inside the component): **wrong, backwards** — predicted it would break; it
  renders fine, just rebuilds the array every render.
- Q2 (`aria-current={… : undefined}` vs `false`): **wrong** — guessed TypeScript; it's a
  JSX-omits-falsy runtime rule (and aria-* passes `false` through as the string "false").

**Diagnosed gap:** the foundational model — *a component is a function React re-CALLS on every
render; a re-render IS another call; `.map` callbacks run per element per call* — was not solid.
Q1 and Q4 were both downstream of that.

**Re-taught forward from the break point (learner driving all three):**
- NavBar → render model. Locked via prediction: on `/` → `/events` the body runs **twice**
  (once per render), and line 44 (`isActive`) runs **twice per render** (once per link). Learner
  got both, and surfaced `useMemo`/`useCallback` as the opt-outs unprompted.
- layout.tsx → server/client boundary. Learner correctly reasoned server→client is allowed,
  client→server breaks, `'use client'` on root would forfeit SSR app-wide, layout doesn't
  re-render on nav (so NavBar keeps state). Asked the *right* question spontaneously: "if hooks
  only work in client components, why ever use a server component?" → taught the capability/weight
  table (zero JS shipped, direct `await` to backend, holds secrets vs. no interactivity).
- page.tsx drill-down → URL-as-state. Learner **predicted the mechanism before opening the file**:
  filters read on the *server* via `searchParams` (a prop, not a hook; a Promise in Next 16).
  Closed two self-found gaps: `title` is a native HTML attr forwarded through `<Link>` to `<a>`;
  `r` = row (learner's readability critique is correct).

**Outcome:** model moved from "recognizable but opaque" to predicting `searchParams` unaided.
Cleared the gate for step 2 (`/mods/[modId]`, dynamic segments + `params` Promise). The two
wrong quiz predictions were *productive* — they located the exact fault line, unlike a clean
score would have.

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

### 2026-07-22 (later still) — Migrations as an initContainer, and the hybrid read

Both items came straight out of the outage/regression list, so this was remediation, not new
feature work. Teaching was thinner here by design — the learner asked to execute.

**Migrations.** The interesting problem was **baselining**: adopting a migration tool onto a
database that already has the schema. `drizzle-kit generate` emits bare `CREATE TABLE`s that fail
against both DBs. Two options weighed in the code comments: add `IF NOT EXISTS` (rejected — it
runs *green* against a drifted table, the same silent-wrongness class as the outage) vs. record
the migration's hash as applied without running it (chosen — asserts exactly what is true).
Required reading drizzle's migrator to learn the record is `sha256(file contents)` in
`drizzle.__drizzle_migrations`. Verified the baseline's *claim* rather than trusting it: local and
RDS column shapes diffed clean.

Two traps caught, both of the "not-compiled-but-required" family:
1. The Dockerfile copies only `dist/`, so `drizzle/` had to be copied explicitly — the same miss
   that kept `scripts/` out of the image earlier the same day.
2. `.gitattributes` — the applied-migration record is a hash of file BYTES, and `core.autocrlf=true`
   would give Windows CRLF and CI LF, so an applied migration would look pending, be re-run, and
   fail. **My first attempt at the rule silently did nothing**: a gitattributes pattern containing
   a slash is anchored to the file's directory, so `drizzle/**` missed `api/drizzle/**`. Caught it
   only because the commit output still warned about line endings; fixed with `**/drizzle/**` and
   verified with `git check-attr` instead of assuming.

**Hybrid read.** Design point worth keeping: the split key is the **done-guard, not the
watermark**. Splitting on settled/unsettled leaves a gap where a settled-but-unfolded session is
in neither half and briefly *disappears* — worse than stale, because the number silently shrinks.
Folded/not-folded is exhaustive, which also demotes the fold to a pure optimisation: a dead cron
now makes the endpoint slower, not wrong.

**The payoff nobody designed for:** the halves merge with `UNION ALL` + re-aggregate *only*
because round 3 stored decomposable parts (sum+count, avg derived) and round 4 kept per-session
grain. Two rules adopted for other reasons turned out to be what made this feature possible at
all. Worth showing the learner as the argument for principled constraints over local optimisation.

**Measured before designing, again:** the obvious `select distinct session_id from events`
anti-join cost **653 ms** — more than the query the rollup replaced (no skip-scan in PG16, so it
walks all 1M PK entries). Bounded by `received_at` + a new index instead.

**Verification standard held:** proven identical in three modes — 100% folded, 100% live, and
MIXED (9,255 folded + 1 fresh session vs. a full live recompute). The mixed case is the only one
where a double-count or dropped session could hide, and it is the state production is always in.

### 2026-07-23 — Multi-mod, the explorer, and a pivot to React fundamentals

**Recall refresher first (learner-requested, spaced retrieval).** Written refresher on the four
scan types, visibility map vs bitmap, VACUUM, "materialize" (disambiguated into three senses:
stored generated column / materialized view / the `Materialize` plan node — that overload was the
likely source of the fog), and rollups. Then four retrieval questions, no multiple choice.

- ✅ Cold VM → VACUUM: diagnosed confidently and unprompted. **Retained across sessions**, not
  just recognised in the moment.
- ⚠️ VM phrasing: said "can we currently see this page". Corrected — visibility is per-SNAPSHOT,
  which a shared persistent bit cannot encode; the VM asks *is every row version on this page
  visible to EVERY transaction*.
- ❌→✅ sum+count vs avg: had the rule verbatim, could not walk the mechanism, and **said so**.
  Re-taught on four numbers (A: 10/20/30, B: 100 → truth 40s, avg-of-avgs 60s). Missing idea
  named: **an average has discarded its WEIGHT, and count IS the weight.**
- ❌→✅ median: conflated with COUNT DISTINCT. Corrected — same list, unrelated operations; and
  crucially **no extra column rescues a median**, unlike avg.

**Dimensions vs measures.** The learner answered a filter question in terms of *measures*. Named
the distinction explicitly, because it governs everything that followed: **a measure must be
decomposable to survive a rollup; a dimension must be IN THE GRAIN to be filterable at all.**

**Strategic design session (learner-led, and the best thinking of the day).** They reframed the
project from proof-of-concept to platform, and pushed back correctly twice:
- `mod_id` should name the **content domain**, not the emitting code — hence `base` for unmodded
  engine behaviour, and no `omwanalytics` id, because this project authors no content. Better
  than my original "the mod that owns the event".
- On auth: reasoned unprompted through authentication vs **authorization**, concluded correctly
  that neither is needed yet but both are worth being able to discuss. I extended it: the
  interesting half here is **tenancy**, and `mod_id` is the tenancy key — so adding the dimension
  now makes future authz a filter rather than a redesign.

**Verified rather than assumed (repeatedly).** Whether `mod_id` could be auto-derived was settled
by reading a real `openmw.log` line (prefix is always our own emitter) and the sandbox docs (no
`debug` library) — *then* designing. Same for Next 16's `searchParams` being a Promise, read from
the project's generated types after `node_modules/next/dist/docs/` turned out not to exist.

**Prediction before measuring — OFFSET vs keyset.** Learner predicted "same cost, you can index
to it, you know the count from ANALYZE." ❌ Measured: same index, 0.14 ms vs 218 ms (~1,500x).
Correction: **a B-tree has no rank statistic** — there is no seeking to the Nth row — and ANALYZE
produces planner *estimates*, not positional access. They did not know the correctness half
(OFFSET is anchored to a count, which drifts on an append-only newest-first feed), which was the
more important half.

**⚠️ MY BUG, found only by measuring.** `ORDER BY` resolves a bare name against SELECT **output
aliases** first; the feed query aliases the epoch-ms expression as `ts`, so `order by ts` sorted
by a computed bigint no index covers. Parallel seq scan + top-N sort, ~0.14 ms → ~280 ms per
page, with **completely correct results**. WHERE never sees output aliases, which is why the
cursor predicate was unaffected and nothing looked wrong. Third time this session the dangerous
failure was the one that *looked* right (the others: shipping code without its schema — loud;
and a staleness metric that read `max(rolled_at)` and so climbed forever while the cron was
perfectly healthy — silent).

**⚠️ Also mine: self-inflicted schema drift.** I created an index by hand while measuring, so the
migration then failed with "already exists" — drift caused by exploratory DDL outside the very
tool built to prevent it. Undone and re-applied through the migration.

---

## ▶ PIVOT (learner request, end of session): React fundamentals before more features

> *"When I'm looking through the React app, I'm having trouble actually parsing what I'm seeing.
> It's recognizable, but I want to focus more on the learning… so I can at least follow it and
> understand how it works when I'm designing things around it."*

This is the single most important signal of the session and it **overrides the feature roadmap**.
The learner is a deep Angular/TS senior — so the gap is not "learning to program a UI", it is
**JSX and the React execution model being genuinely unfamiliar**, and code that reads fine to me
being opaque to them. Building more of it faster makes the problem worse, not better.

Started the correction: taught JSX-is-JavaScript-not-a-template with an Angular mapping table
(`*ngIf` → `&&`, `*ngFor` → `.map()`, `trackBy` → `key`, `[ngClass]` → template literal, **no
two-way binding exists**), and that the component function **re-runs every render**, so `useState`
is not a field declaration but a request for a numbered slot — which is why hooks cannot sit
inside `if`.

**NEXT SESSION STARTS HERE, before any step-2 work:**
1. **Quiz on React** — prediction/explain-back only, never multiple choice (see `.claude/skills/teach`).
2. **Line-by-line walkthrough** of the three annotated examples, learner reading aloud/driving:
   - `dashboard/app/components/NavBar.tsx` — the smallest complete component; contains
     `'use client'`, a hook, `.map()` + `key`, a template-literal `className`, a ternary, and
     `{expression}` interpolation.
   - `dashboard/app/layout.tsx` — the Server/Client boundary and `children` as `<router-outlet>`.
   - the drill-down block in `dashboard/app/page.tsx` — URL-as-state cashed out as a `<Link>`.
3. Only then: step 2 (`/` → `/mods/ccff`, `/mods/[modId]`), which introduces dynamic segments
   and `params` (also a Promise in Next 16).

Comment density in the new dashboard files is deliberately high **for this reason** — they are
teaching artifacts, not just code. If an annotation explains the wrong thing, that is signal.

---

## 2026-07-26 (round 3) — spaced check on the six unassessed 4b concepts

Run at the end of the session, after prod was deployed and populated, specifically so the build
would not bury them. Four questions covering concepts taught on 07-25 and 07-26 but never checked.

| Q | concept | assessment | result |
| --- | --- | --- | --- |
| 1 | **Matryoshka truncation** | mechanism → **explain-back** | ❌ → ✅ **repaired in session** |
| 2 | cardinality forces the child table (**3rd attempt**) | transfer, non-game domain | ✅ **landed** |
| 3 | **asymmetric `tsvector` config** | prediction | ❌ **missed the failure entirely** |
| 4 | RRF: consensus, and `k` ↔ `m` | judgment | ⚠️ **half** — mechanism yes, knob no |

**Q1 — the break point was further back than the concept.** The learner said plainly *"I don't
understand what the dims are."* Matryoshka was unteachable on top of that, because "dimension" had
never been connected to "one number in the array." Re-taught from there (dims = array length;
truncation = keep the first N), then the ordered-by-importance analogy (a description ordered
*tall · dark hair · glasses …* survives being cut; a randomly ordered one does not). **They then
explained it back unprompted and correctly** — ordering by importance, index 0 most significant,
cutting the tail costs refinement not substance. Counting this as landed on the strength of the
explain-back, not the first answer.

⚠️ **They also pushed back on the *name*, correctly**: "matryoshka" made them expect nested
arrays. Clarified that the nesting is conceptual, not structural — the point of the doll metaphor
is that **each inner doll is a whole doll**, which is exactly the claim (the first 384 numbers are
an embedding, not a fragment). Good instinct; the metaphor was underspecified when I first used it.

**Q2 — the correction finally stuck.** Twice on 07-25/26 they substituted "we know the shape, so
model it" (an argument for why relational is *safe*) for the structural blocker. This time, on a
`users`/emails question with no game context, they went straight to the N+1 problem. Answered in
Morrowind vocabulary ("skills", "potion") despite the domain switch — the reasoning transferred
even though the words didn't, which is the part that counts.

**Q3 — the real miss, and it is the day's own theme.** Asked what happens when the index uses
`english` and the query uses `simple`, they described the token-count difference (true, measured
07-25) — an *efficiency* answer to a *correctness* question. The actual behaviour: the document
stored `guard`, the query asks for `guards`, **zero rows, and the error log says nothing.** Both
configs are valid; the query succeeds and matches nothing. Re-taught as: *stemming does not need
to be correct, it needs to be SYMMETRIC.*

**Q4 — had the mechanism, not the dial.** Correctly called the behaviour intentional and
reconstructed reciprocal rank as scale-free normalization. Could not say what "the opposite
behaviour" would require. Taught: **lower `k`** steepens `1/(k+rank)` at the top so one confident
retriever can win alone; high `k` flattens it so appearing in *both* lists dominates. Tied back to
concept 11 — `k` and `m` are the same shape of dial: trust this evidence vs. demand corroboration.

▶ **Still unassessed: 6 (JSONB range-predicate false-match), 7 (local-first ingest — partially
covered), 10 (why multiply turns OR into AND).** Plus everything new from step 7: recall via exact
KNN, out-of-distribution queries, buffers-vs-wall-clock, TOAST and detoasting.

▶ **Re-test candidates, in priority order:** Q3's silent-asymmetry failure (missed outright, and it
is the pattern the whole day produced), then Matryoshka in a *different form* — I have now
explained it twice, so a third explanation is not the answer; a hands-on comparison is.

---

## 2026-07-27 — the planned 6-question opening check (ran as written, no improvisation)

| Q | concept | form | result |
| --- | --- | --- | --- |
| 1 | asymmetric `tsvector` config | prediction | ✅ **REPAIRED** (was ❌ 07-26) |
| 2 | Matryoshka | hands-on | ✅ conclusion right, ⚠️ reason wrong — **and the exercise was mis-designed** |
| 3 | JSONB range-predicate false match | debug | ⚠️ **half** — right disease, wrong clause semantics |
| 4 | multiply turns OR into AND | prediction | ✅ + a knob collision corrected |
| 5 | recall via exact KNN | explain-back | ✅ |
| 6 | buffers vs wall-clock | judgment | ❌ **inverted** → re-taught → landed on follow-up |

**Q1 — the repair held across a day boundary.** Last time they gave an *efficiency* answer to a
*correctness* question. This time: index stores `guard`, query asks `guards`, zero rows, **log
silent**, both configs valid. Minor tightening only — they said `english` "breaks it up," conflating
stemming (reduce to root) with tokenization (split); both configs tokenize identically.

**Q3 — had the class of bug, not the clause.** Correctly identified that `@>` and the magnitude test
are unlinked predicates satisfiable by *different* array elements. But read
`(effects->0->>'magnitude')` as "look through the effects" when `->0` is **array index 0 only**.
Against the fixture (speechcraft first, magnitude 5) the row is therefore a false **negative**, and
reordering the same array makes it a false positive — worse than the bug they described, because
nothing pins array order. Doc 11's example assumes strength sits at index 0; noted.

**Q4 — correct, and it surfaced a genuine collision worth recording.** They fused `k=60` (RRF's rank
discount) with `ef_search=80` (the HNSW graph-walk width). Both are tuned integers from 07-26 and
they had merged them into one "k." Separated by failure mode: **bad `k` → wrongly ordered results;
bad `ef_search` → missing results.** Also: RRF = Reciprocal Rank **Fusion**; "rank" is load-bearing
(scores are discarded, which is what makes it scale-free).

**Q6 — the real miss, and it is last session's own headline inverted.** Asked which number to report
when buffers are bit-identical and p50 differs 60%, they chose latency ("latency is what we care
about"). Re-taught from the premise: identical buffers ⇒ *the same pages, the same work* ⇒ the 60%
is the machine's mood, not the query's cost. Three properties tabled — deterministic, monotonic,
portable — and tied to the fact that identical-buffers-across-different-configs is precisely how
bug #5 (`SET LOCAL` no-op) was caught. Follow-up prediction (buffers 41,509 → 844, wall-clock
unchanged): ✅ answered correctly, then **over**corrected to "wall-clock never matters." Split it:
**buffers = comparison instrument, latency = acceptance instrument measured on prod.**

### ⭐ Q2 — the mentor's exercise was wrong, and the data said so

Designed to test Matryoshka by comparing **head-96** vs **tail-96** of the stored 384-dim vectors,
expecting the head to win. Learner predicted the tail would do just as well. **They were right.**

| slice (96 dims each) | mean overlap@10 vs full-384, 100 queries |
| --- | --- |
| head, dims 1–96 | **6.07** |
| middle, dims 145–240 | **6.40** |
| tail, dims 289–384 | **6.35** |

Controls run **before** interpreting anything (the day's own discipline): `subvector(1,384)` vs full
= **10.00** exactly (instrument sound), first-8-dims = **2.30** (instrument *can* detect
degradation). So the tie is real, not a dead measurement.

**The conflation:** MRL's actual promise is that a **prefix is itself a usable embedding**, with the
loss applied at nested prefix *lengths* (64/128/256/512…). It does **not** promise that dim 5 beats
dim 300 inside an already-truncated prefix. I tested the second and called it the first.

Prefix-length sweep (the test I should have written), 60 queries:

| prefix | overlap@10 |
| --- | --- |
| 384 (stored) | 10.00 |
| **192** | **7.62** — half the bytes, 76% of the ranking |
| 96 | 6.27 |
| 48 | 4.88 |
| 16 | 2.73 |

Graceful degradation, no cliff — which justifies the 384 decision. **But it does not demonstrate
Matryoshka**, and that is the lesson that actually landed: head-96 ≈ tail-96 means *two hypotheses
predict this curve equally well* — "MRL front-loads information" and "any N dims carry N/384 of the
information." Nothing here separates them. Separating them needs a prefix beating a non-prefix **at
equal width**, and every width buildable from stored data fails to show that.

⚠️ **Therefore: the dims sweep is blocked for a structural reason, not a scheduling one.** It needs
the 1536-dim source, which `ingest.ts` discards at write time. Record it that way.

⭐ **Generalized for the learner:** *an experiment only supports a claim if some outcome would have
refuted it.* Same family as 07-26's bug #4 (a test that could not fail) — and this time the person
who wrote the experiment was the one who got it wrong.

**Pipeline verified clean during the investigation:** `embeddings.ts:139` requests the native 1536
and `truncateAndNormalize` takes `slice(0,384)` + re-normalizes, exactly as doc 11 states.

▶ **Still unassessed:** concepts 6, 7, 10 from the 07-25 list; TOAST/detoasting; out-of-distribution
query construction (mentioned but not tested — they did not raise it unprompted on Q5).
▶ **Re-test next:** Q3's `->0` element semantics, and Q6's buffers/latency split in a *new* form.

---

## ✅ EXECUTED 2026-07-27 — PLAN FROM 2026-07-26 (kept for the record; superseded by the 4c plan at the end)

### 1. Opening retrieval check — ~6 questions, and the list is fixed, not improvised

Sized to the material (skill §2). Two of these are **re-tests of things that did not land**, which
matters more than covering new ground:

| # | concept | why | form |
| --- | --- | --- | --- |
| 1 | **asymmetric `tsvector` config** | ❌ missed outright 07-26; gave an *efficiency* answer to a *correctness* question | prediction — "index `english`, query `simple`, user searches `guards`: what returns, what does the log say?" |
| 2 | **Matryoshka** | ✅ repaired 07-26, but only after two explanations — needs to survive a day boundary | ⚠️ **NOT a third explanation.** Hands-on: truncate a real vector, compare cosine before/after |
| 3 | JSONB range-predicate **false match** | never assessed | debug — hand them the Skooma clause, ask for the wrong row |
| 4 | why **multiply turns OR into AND** in score fusion | never assessed | prediction |
| 5 | **recall measured via exact KNN** | taught 07-26, unassessed | explain-back — "how do you know the index missed something?" |
| 6 | **buffers vs wall-clock** | taught 07-26, unassessed | judgment — "two runs, identical buffers, p50 differs 60%. Which do you report?" |

### 2. ⭐ The theme worth teaching explicitly, because the session produced SIX instances

**"Looks right" and "is right" are indistinguishable without an independent check.** Every failure
on 2026-07-26 was silent and plausible:

| # | failure | what caught it |
| --- | --- | --- |
| 1 | 5,286 id-less headers folded into the previous record | header count did not reconcile |
| 2 | 708 ENCH records + 1,069 effects dropped | effect count did not reconcile |
| 3 | 99 INFO ids colliding across topics | Postgres `21000` |
| 4 | a test that **could not fail** (uniform vectors normalize identically) | mutation — deleted the sort, watched it fail |
| 5 | benchmark measuring one config against itself (`SET LOCAL` outside a transaction) | identical buffers across "different" plans |
| 6 | ingest deleting a real corpus (unscoped orphan sweep) | a search returned fixture text |

The three techniques that did the catching, and they generalize: **conservation counts** (N in, N
out, classified), **plan/constraint assertions** (assert what actually ran), and **mutation checks**
(break the code, confirm the test notices). Teach as one lesson, not six anecdotes.

### 3. ⚠️ Dashboard work: the learner asked for SLOW, decision-by-decision React

Requested at session close 2026-07-26: *"When we go through the dashboard work I want to go slowly
through the actual react coding/decision making to understand it."*

This is the **step-by-step mode** from `feedback-4b-step-by-step-mode` applied to React — but note
the difference: for retrieval there was no senior-level prior, whereas here there IS deep Angular /
TypeScript strength to build on. So the teaching should target **where React differs from Angular**
(server vs client components, no DI, rendering model, data fetching) rather than re-explaining
component-oriented UI. One decision per step, learner makes the call, jargon defined in place.

Prior React work is DONE and landed (07-23 fundamentals quiz, `/mods/[modId]`) — build on it, do
not restart it.

### 4. Still unassessed after everything

Concepts 6, 7, 10 from the 07-25 list, plus all of step 7's material except what question 5 and 6
above cover. Do not let the dashboard bury them.

---

## 2026-07-27 (part 2) — step 8 built in step-by-step React mode (learner drove every decision)

Requested at the 07-26 close: *"go slowly through the actual react coding/decision making."* Run as
**four decisions, learner makes the call, I only frame the tradeoff.** Per
`feedback-react-step-by-step`, the target was where React **differs from Angular**, not React
fundamentals (done 07-23).

| # | decision | learner's call | quality of the reasoning |
| --- | --- | --- | --- |
| 1 | type-ahead vs submit-only | **submit-only, URL holds `q`** | ⭐ **better than the conclusion** |
| 2 | `<form method="get">` vs `router.push` | **client component** | ⭐ named the right cost model |
| 3 | where the pending state comes from | **scoped `<Suspense>` + `useTransition`, results clear** | ⭐ strongest of the four |
| 4 | what to do about 2.6 s cold latency | **accept it** | ✅ consistent with 3 |

⭐ **D1 — they derived the distinction unprompted.** *"We're making the request over a set of data
that's not currently in the UI."* That is **filter vs query**, arrived at from first principles;
I supplied only the vocabulary. Then, unprompted: *"if we're debouncing that much, we might as well
do it on submit"* — the observation that a debounce long enough to protect an expensive backend has
already destroyed the type-ahead feel it was added to provide. Most engineers never say that out
loud.

⭐ **D2 — "costs are additive, not alternative."** Rejected the framing in my own question (I asked
whether the reload's 300 ms was *irrelevant next to* the embedding round-trip) and pointed out it
**stacks on top**, so feedback matters *more* as the wait grows. They also weighed simplicity
explicitly before spending it, rather than by default.

⭐ **D3 — the best reasoning of the session, and it beat the answer I was fishing for.** I expected
"keep stale results visible." They argued the opposite from the *trigger semantics*: a submit is an
explicit opt-in, so the old set is dead by definition — and post-submit stale results are
**indistinguishable from a finished search**, so they read as silent failure and invite repeated
submissions. Generalized with them as: *the cost of stale data scales with how hard it is to tell
apart from fresh data.* Also insisted the two regions must **agree** (busy button + cleared list),
which is the failure mode split feedback actually produces.

**Taught in place** (jargon-on-first-use, all React/Next-specific): Server Components have no
instance so the request *is* their props; `defaultValue` vs `value` and why `value` without
`onChange` is read-only (the nearest React gets to *not* having `[(ngModel)]`); `startTransition`
marking an update non-urgent to yield `isPending`; and ⚠️ **`key` on a `<Suspense>` boundary** —
without `key={q}`, `?q=a → ?q=b` updates in place and the fallback never re-shows. Same `key`
concept as in `.map()`, doing a job nobody expects it to do.

**Assessment note:** this session was **learner-driven decisions, not quizzing** — four judgment
calls with real tradeoffs is a stronger signal than four questions, and all four were defended with
reasoning rather than preference. Logging it as *demonstrated judgment*, not as a quiz score.

### ⭐ The day's theme landed twice more, in infrastructure

The 07-26 plan named *"looks right and is right are indistinguishable without an independent
check"* as the lesson to teach explicitly. It taught itself instead — two more instances, both
found while deploying, both with `/health` green (see `09`):

| # | failure | why it was invisible | what caught it |
| --- | --- | --- | --- |
| 7 | pod 45 min older than the code | 404 on **one route**; every other endpoint fine | curling the *specific* new route |
| 8 | `OPENAI_API_KEY` absent ⇒ `mode:'lexical'` | real, relevant, plausible results | **semantic-only hits** (`lexical_rank:null`) — impossible from the lexical half |

⭐ **The transferable move: pick a check that CANNOT pass under the failure you fear.** A
semantic-only hit cannot be produced without the embedding path, so one such row disproves silent
degradation. `/health` was green through both and proved nothing.

▶ **Still unassessed:** 07-25 concepts 6, 7, 10; TOAST/detoasting; out-of-distribution query
construction (they did not raise it unprompted on Q5).
▶ **Re-test queued:** the `->0` element semantics (Q3), and buffers-vs-latency in a *new* form (Q6).

---

## ▶ PLAN FOR NEXT SESSION (written 2026-07-27) — 4c, the last resume gap

### 1. Opening retrieval check — ~4 questions, list fixed

Smaller than today's because less new ground was broken (four decisions, one experiment). Two are
carry-over re-tests; **never multiple choice**.

| # | concept | why | form |
| --- | --- | --- | --- |
| 1 | JSONB `->0` vs "any element" | ⚠️ half-landed 07-27 — had the disease, not the clause | debug — same fixture, reordered array; ask if it still matches |
| 2 | buffers vs wall-clock, **new form** | ❌ inverted 07-27, repaired, needs to survive a day | judgment — a *prod* scenario, not a local one |
| 3 | why head-96 ≈ tail-96 defeats the Matryoshka claim | today's own finding, assessed only once | explain-back |
| 4 | a check that cannot pass under the failure you fear | the deploy lesson | transfer — *different* system, e.g. "how would you prove a cache is actually being used?" |

### 2. ⚠️ 4c is where the guardrails matter most

`4c — LLM insights over the aggregate layer` closes résumé bullet 5, and the JD's *"define the
right problems / balance human and technology intelligence"* is **explicit wariness of reaching for
ML where a heuristic does**. So the teaching frame is not "how to prompt" — it is:

1. **Have the "why not just a heuristic" answer ready before writing a prompt.** 4a already proves
   we reach for the heuristic first; 4c must justify *why this specific job needs generation*.
2. **Bounded prompts + human review** (the `project-resume-gap-plan` shape) — not an agent, not a
   tool-calling loop. Guardrails: no new infra without demonstrated need.
3. **n=1 is still true.** Insights over an aggregate built from one install are a *demo of the
   mechanism*, not a finding. Say so in the UI, as `mode:'lexical'` and the synthetic banner do.
4. ⚠️ **The failure mode is this session's theme again, at its worst:** an LLM produces fluent,
   plausible, confident output *by construction*. "Looks right vs is right" has no natural tell
   here, so decide the independent check **before** building — what would falsify a generated
   insight? That question is the design work.

### 3. Also open (not blocking 4c)

- **`kubectl rollout restart` is manual** — no rollout trigger on a new image (`09`). Small,
  self-contained, and it removes a footgun that already bit once.
- Rate limiting (bullet 2) + uptime/error monitoring (bullet 3) — each turns a currently-overstated
  résumé bullet fully true. Interviewers probe bullets.
- Synthetic seeding for the **telemetry** views (`project-synthetic-data-policy`) — never needed for
  search, which runs on real corpus data.

---

## 2026-07-27 (part 3) — the day the theme stopped being a theme and became a method

The 07-26 plan named one lesson to teach explicitly: *"looks right" and "is right" are
indistinguishable without an independent check.* It was scheduled as a lecture. Instead the day
produced **nine** instances, **three of them the mentor's own**, and the lesson taught itself.

### The full ledger

| # | failure | why it was invisible | what caught it |
| --- | --- | --- | --- |
| 1 | `ItemUsage` cannot see quick-keys / AI / mwscript potion use | fewer rows, no error, plausible counts | reading the API's own caveat, then **testing the quick-key path deliberately** |
| 2 | `activeEffects:getEffect(FortifyAttribute, …)` is blind to drains | returns nothing = "no boost", identical to genuinely unboosted | the 0.51 docs exposing `base/modified/modifier/damage`; confirmed by Skooma's **−20 Agility** |
| 3 | prod pod 45 min older than the code | 404 on **one route**; `/health` green | curling the *specific* new route |
| 4 | `OPENAI_API_KEY` absent so search served `mode:'lexical'` | real, relevant, half-a-feature results | **semantic-only hits** — impossible from the lexical half |
| 5 | shipper dead 6 days | every signal green; the API *was* fine | a human noticing prod's newest event was stale |
| 6 | ⭐ **mentor's**: install-id scan window 26× too small | parsed cleanly, threw nothing, returned `null`; `shippers: []` looks like "not started yet" | probing the assumption directly — 64 KB yielded **0** telemetry lines |
| 7 | `Stop-ScheduledTask` orphans the node child, giving **two** shippers | `IgnoreNew` governs the task, not a grandchild | listing processes instead of trusting the task state |
| 8 | ⭐ **mentor's**: "corrected" doc 11 from 3 effects to **2**, matching corrupt data | the database agreed with the edit | the game contradicting both |
| 9 | ⭐⭐ **test fixture overwriting real corpus records** | 48 tests green — they assert rows the fixture itself defines | **contradiction between two independent observations** |

### The four techniques, now a method rather than anecdotes

1. **Conservation counts** — N in, N out, classified. ⚠️ **And across the stage boundary that
   persists, not only within a stage.** Every check in this project lived *inside* the parser;
   nothing compared Postgres to the `.esm`. That gap is bug #9, and `verify-corpus` is ~90 lines.
2. **Assert what actually ran** — the plan, the constraint, the process list.
3. **Mutation checks** — break it, confirm the test notices. Bugs #6 and #9 both looked fine while
   returning nothing and asserting nothing respectively.
4. ⭐ **NEW, and the day's real contribution: pick a check that CANNOT PASS under the failure you
   fear.** Not "does it work" but "what observation is *impossible* if the thing I fear is true?"

| fear | the discriminating check |
| --- | --- |
| the seam cannot see quick-key usage | drink a potion **from the hotkey** |
| prod silently degraded to lexical-only | find a hit with `lexical_rank: null` |
| the supervision fix does not actually restart | **kill the process** and watch |
| the alert endpoint works but nobody is told | **induce a real outage** and wait for the phone |
| the corpus disagrees with the game | join telemetry to it and look for a contradiction |

Every one of those was run. Four of them found something.

### ⭐ Bug #9 is the teaching artefact — keep it

`ingest.test.ts` used **real record ids** for realism. `record_id` is the primary key, so every
`npm test` upserted the fixture over the genuine rows. Skooma's four effects became two.

- **It recurred on every test run.** Not a one-off — the mentor re-triggered it twice that day.
- **The 07-26 fix was insufficient in a way that reads as sufficient.** Source-scoping stopped tests
  *deleting* real data. It could never stop them *overwriting* it, because **a shared primary key
  does not care about the `source` column.** A fix aimed at the symptom you noticed looks complete
  until the other half of the class shows up.
- **It was caught by contradiction, not inspection.** Telemetry said `strength +20`; the corpus said
  Skooma has no Strength effect. Both internally consistent; only *against each other* wrong.
- ⭐ **The synthesis layer found a bug in its own foundation on first real use.** That is the
  strongest available argument for building 4c's telemetry × corpus join at all — and it is an
  interview story, not merely a fix.

### Learner-driven work — logged as JUDGMENT, not quiz scores

Four `/search` UI decisions plus several instrumentation decisions, learner making each call. Twice
they beat the answer being fished for, and once they corrected the mentor's framing outright:

| decision | learner's reasoning |
| --- | --- |
| submit-only search | derived **filter vs query** unprompted; then *"if we're debouncing that much, we might as well submit"* |
| `router.push` | rejected the question's framing — reload cost is **additive** with the embedding round-trip, not an alternative |
| clear results while loading | ⭐ from *trigger semantics*: an explicit submit means the old set is dead, and stale results post-submit are **indistinguishable from a finished search** |
| accept cold latency | same principle applied — staged streaming reorders results under the reader |
| `SkillCheckDisplayed` grain | independently re-derived `10 §3.2a`'s per-check decision, and rejected a panel id on *"don't store what we won't use"* |
| `statDetail` shape | *"morph the data to support the needs, as opposed to consistency when it counts"* |
| **`n=1`** | ⛔ shut down a question the mentor had re-raised across sessions: *faking data demonstrates the SYSTEM works, not that the problem is real* |

⚠️ **Mentor correction to carry forward:** `n=1`/synthetic data was **already decided** and got
re-litigated at the start of a new feature. Apply the standing policy silently; do not reopen it.

### ▶ Assessment debt

**Nothing was formally quizzed after the opening check.** The session ran on learner-driven
decisions, which is the stronger signal for *judgment* but leaves *recall* unmeasured. Open: 07-25
concepts 6, 7, 10; TOAST/detoasting; out-of-distribution query construction; and the new material —
liveness vs freshness, single-row liveness tables, the discriminating-check technique, and why a
shared primary key defeats source scoping.

### ▶ Plan for 4c (supersedes the earlier 4c note in this file)

The data layer is **complete and verified**: `ItemConsumed` + `SkillCheckDisplayed` +
`base_value`/`stat_modifier`/`stat_damage`, joined to `record_effects`, with attribution proven
(`skill_value − base_value` equals the fortify magnitude).

1. **Open with ~4 questions** from the debt list above — prediction / explain-back / transfer,
   never multiple choice.
2. **Build the Q3.6 SQL BEFORE any LLM touches it.** *"Players fail this Personality gate, nobody
   boosted, and here is every item in the game that could have"* is a
   `WHERE affected='personality' AND magnitude_min >= n` join. Seeing exactly how far the heuristic
   gets **is** the "why not just a heuristic" answer, and it has to be measured, not asserted.
3. ⚠️ **Then the hard part: an LLM produces fluent, plausible, confident output BY CONSTRUCTION.**
   Every failure this session had a tell — a count that would not reconcile, a 404, a contradiction.
   Generated prose has none. **Decide the independent check before writing the prompt.** What
   observation would be impossible if the insight were wrong? If there is no answer, the feature is
   not ready to build.
