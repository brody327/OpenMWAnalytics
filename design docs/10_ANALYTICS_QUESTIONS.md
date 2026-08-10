# 10 — Analytics Questions (the question inventory)

**Status:** 🟡 new (2026-07-20). Modules agreed; question rows will accrete.

This doc answers *"what is the dashboard **for**?"* — and by doing so, it governs
`03_EVENT_REGISTRY.md`. Every event we add should cite a question here. Events that
can't are cut.

---

## 1. Why this doc exists — bottom-up vs. top-down

Everything in the registry so far was designed **bottom-up**: *"here's a seam I can
instrument — what can I get out of it?"* `AreaEntered` exists because `self.cell` is
pollable. `ConfrontationAttempted` exists because CCFF had eight call sites to hook.

That is a legitimate way to *start* — it proved the pipeline — but it produces a
dashboard that shows **what was easy to collect**.

This doc inverts it. Start from a decision a mod developer needs to make, work
backward:

```
decision  ─▶  question  ─▶  metric  ─▶  events required  ─▶  instrumentation
```

In analytics practice this is a **question inventory** (also "metric tree" / "KPI
tree"), and it is what *justifies* a tracking plan. The registry stops being a
catalog of what we can see and becomes the answer to what we **must** see.

**Consequence for `03`:** adding an event is no longer "this looks capturable." It is
"question Q-x.y in this doc is unanswerable without it."

---

## 2. Audience — the mod developer, not the player

The dashboard is a **tool for the author of a mod**, not a player-facing stats page.
It is not a leaderboard, not an achievement wall, not a "your playthrough in numbers"
recap. Players may find it interesting; they are not who it is designed for.

That single decision has teeth. It means:

| Because the audience is the author… | …the dashboard does this |
| --- | --- |
| the unit of interest is **the content**, not the player | group by puzzle / topic / check — never rank players |
| the output must be **actionable** | every view ends in "…so change X" or "…so leave it alone" |
| unflattering findings are the *point* | surface content nobody found, checks nobody passes |
| identity stays anonymous (`02` / identity) | cohorts and aggregates only; never "who" |

The governing question the whole platform exists to answer:

> **"Is this mod being played the way I designed it to be played — and where is it
> hurting?"**

Everything below is a decomposition of that.

---

## 3. Two problems that shape every module

These are cross-cutting. Read them before the inventory; several "events required"
cells only make sense in their light.

### 3.1 A failure rate cannot, by itself, tell you if something is broken

This is the central trap of difficulty analytics. A boss players lose five times and
then beat is a *great* boss. A confrontation players lose five times and then beat is
possibly also great. **Same number, opposite verdicts.**

What separates them is not the failure rate — it is **what the player does next**:

| Post-failure behavior | Reading | Author action |
| --- | --- | --- |
| retries → succeeds | good friction, working as intended | leave it alone |
| retries *many* times → succeeds | brute force, not deduction — comprehension gap | clarify the framing, not the numbers |
| retries → never succeeds → moves on | dead end / soft bypass | check for an unwinnable state |
| fails once → wanders off → never returns | **bad friction** — confusion or discouragement | this is the alarm bell |
| fails → session ends | worst signal available | investigate first |

**Structural consequence:** events must be readable as an **ordered sequence per
player**, not merely counted in aggregate. We already have that — `session_id` +
`seq` is an ordered stream (`02`) — but no dashboard view uses it yet. Sequence-aware
queries (what happened *after* the failure) are the single biggest unlock available
from data we already store.

### 3.2 The denominator problem — attempts are not exposure

*"70% failure rate on cornering Titania"* is meaningless without knowing how many
players **reached** Titania at all. Two players, one failure, is noise rendered as a
confident bar chart.

Today every event we emit is an **engagement** event: it fires when a player *does*
something. We have no **exposure** events, which fire when content is *presented*.
Without exposure:

- we cannot compute a true rate (no denominator);
- we cannot distinguish *"nobody passes this"* from *"nobody found this"* — which
  demand opposite fixes;
- Module 2 (Coverage) is entirely unanswerable.

**Structural consequence:** the highest-leverage *new* event class is exposure, not
more attempt detail.

#### 3.2a — A mechanism for exposure, identified 2026-07-25 (designed nowhere yet)

The claim *"you cannot emit an event for something that didn't happen"* is true and was too
strong a conclusion. **You can emit one for the bounded window in which the non-event occurred,
provided the choice set is enumerable** — which is exactly what CCFF's **inspect panel** is:

```
panel opened  →  the available skill checks are enumerable  →  panel closed
                 whatever was not attempted was DECLINED
```

That is the standard **impression → action** pattern, and it supplies the denominator this
section says we lack. The prize is the 2×2:

| | attempted | **declined** |
| --- | --- | --- |
| **threshold met** | routine | didn't want the outcome |
| **threshold not met** | failure prose is **read** | **deterred — prose never seen** |

⚠️ **Four things to settle before designing it** (feasibility gate first):

1. **Does the panel code know, at open time, which checks exist *and* whether the threshold is
   met?** A code read decides whether the full 2×2 is buildable or only the top row.
2. **Grain is per-check, not per-panel** — 3 checks with 1 attempt = 1 attempt + **2** declines.
3. **Dedupe repeat opens** (probably first-open-per-session) or the decline rate inflates.
4. **Name the field `check_displayed`, not `check_seen`** — rendered ≠ read. Put the viewability
   limitation in the schema, not in a footnote.

⭐ **This also fixes a blind spot in 4a's ranking** (`07 §7`): `stuck_score` uses `attempts` as its
volume term, so a check nobody attempts scores ≈ 0 — indistinguishable from one that doesn't
exist. Exposure separates *"everyone fails this"* from *"nobody even tries this"*, which are
different problems with different fixes.

Status: ✅ **DESIGNED 2026-07-27** as `SkillCheckDisplayed` (`03`). All four gates above were
settled, three of them re-derived independently from first principles:

| gate | resolution |
| --- | --- |
| 1. does the panel know the checks + threshold at open time? | ⚠️ **still the one open feasibility question** — needs a read of `evidence_inspect.lua`. If only the top row of the 2×2 is buildable, say so rather than inferring the bottom. |
| 2. grain per-check | ✅ confirmed. **Plus a grouping key** (`display_group`) so "saw 3, chose 1" is distinguishable from "saw 1, declined 1" — without it, choosing well looks identical to ignoring, and it inflates 2.5 |
| 3. dedupe repeat opens | ✅ **emit every open; dedupe at QUERY time.** Deduping at emit destroys the "kept coming back to this check" hesitation signal. Same principle as `03`'s raw margin: derived values can be recomputed, raw ones cannot be recovered |
| 4. name it `displayed` | ✅ kept — rendered ≠ read |

### 3.3 Honesty about sample size

The current population is **one player, who is also the author**. Rates over n=1 are
anecdote. The platform is *designed* for population scale; the dataset today is a
single-player pilot.

The dashboard must therefore **always render sample size next to any rate**, and
should visually de-emphasize (not hide) rates below a small-n threshold. Rendering a
confident `70%` over two attempts is the kind of dishonesty that makes a portfolio
piece worse, not better.

---

## 4. The modules

Four modules, each defined by the author decision it drives. Module 1 is the headline;
**Modules 2 and 4 are what make Module 1 interpretable** — without exposure there is
no denominator, and without flow you cannot tell frustration from success.

Legend for the **Have?** column: ✅ answerable today · 🟡 partially (data exists, no
view) · ❌ needs new events.

### Module 1 — Friction & Difficulty
> *"Is this hard in the way I intended?"*

| # | Question | Decision it informs | Metric | Events required | Have? |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Which content has the highest failure rate? | where to look first | ranked **stuck score** (shrunk fail rate × log volume), with n | `ConfrontationAttempted` | ✅ |
| 1.2 | *How badly* do players fail — by a hair or by a mile? | tune threshold vs. redesign | distribution of **margin** (`skill_value − threshold`) | `SkillCheckResolved` | 🔵 designed |
| 1.3 | How many attempts precede a success? | is it deduction or brute force | attempts-to-first-pass, per player per check | existing (`ROW_NUMBER`) | ✅ API |
| 1.4 | What do players do *after* failing? | good friction vs. bad friction (§3.1) | next-event distribution after a fail | existing (`LEAD`) | ✅ API |
| 1.5 | Which failure *modes* dominate? | fix the specific confusion | `reason` breakdown | `ConfrontationAttempted.reason` | ✅ |
| 1.6 | Is anything effectively unpassable? | unwinnable-state bug hunt | checks with 0 passes and n ≥ threshold | existing | ✅ API |
| 1.7 | Do players who quit on a topic ever come back and beat it? | is `session_end` churn, or just bedtime | per **install**: topics with ≥1 unsolved session *and* ≥1 solved session | existing (`install_id`) | 🟡 query proven, no view |

**Why 1.1 is now ✅ (the ranking view, 2026-07-24 — Phase 4a).** "Where to look first" is not a
metric, it is an *ordering* — so answering it well needs a scoring function, not another bar
chart. `GET /stats/ranking` ranks every topic by an explicit **stuck score** = shrunk fail rate ×
log(attempts): shrinkage pulls a thin rate toward the global `C` so a topic failed once cannot
outrank one failed forty times, and log-damped volume makes a single attempt score zero. It is a
deliberate **heuristic, not a model** — the honest choice at n=1, where there are no labels to
learn from (`§3.3`). Crucially this **dissolves the population-of-one objection**: ranking what a
tool *shows* needs a scoring function, not a user population. Full design + verification state in
`07 §7`. ⚠️ Numbers stay anecdote until real players exist, like every rate here.

**Why 1.7 exists — it reinterprets 1.4's loudest signal.** `session_end` is currently our
*worst* post-failure bucket (§3.1), but it is ambiguous: "rage-quit for good" and "it was
midnight" produce identical rows. The discriminator is what happens in the player's *next*
session. If most `session_end` players return and solve it, the bucket is over-alarming and
should be de-emphasised in the UI. If they never play again, it is the most important number
on the dashboard. We cannot currently tell, and we are showing it as if we can.

**Why it looked impossible, and why it isn't.** Q1.3/1.4 use windows partitioned by
`session_id`, and every launch mints a fresh one — so a window *structurally cannot* see across
sessions. That is a property of the query, not of the data: `install_id` is persistent and sits
on every event, so the sessions of one install are joinable.

**The measurement design decision (2026-07-22), and it is the load-bearing one.** There are two
ways to ask this, and they are not equivalent:

| | **Ordered** — "failed, quit, *then later* solved" | **Set-based** ✅ chosen — "this install has both an unsolved and a solved session for this topic" |
| --- | --- | --- |
| Shape | window partitioned by `install_id` | plain aggregate over per-session rows |
| Ordering key | `ts` — because `seq` restarts per session | none needed |
| Trusts client clocks | **yes** (skew reorders sessions) | no |
| Rollup-safe | **no** — see below | **yes** |

The ordered version breaks the entire rollup correctness argument (`06`, rounds 3–4): that rests
on *partition by `session_id` + each launch mints a new one ⇒ a settled session's partition is
frozen forever*. Partition by `install_id` instead and a new session **can** change a prior
partition's answer, so nothing is ever settled and the incremental fold is invalid.

The set-based version has no such problem, because the cross-session aggregation happens **at
read time over `friction_attempts_rollup`** — whose rows are per-session and individually frozen.
An install's answer changes as sessions arrive, and that is fine: nothing about it was ever
persisted. This is the fine-grain payoff from `06` round 4 arriving earlier than expected — the
question is answerable *only* because we declined to collapse the session dimension away.

**✅ Prerequisite done (2026-07-22):** `friction_attempts_rollup.install_id` added and back-folded
(9,255 sessions, 1.36 s; row values unchanged — symmetric `EXCEPT` 0/0 — and 0 mismatches against
`events`). The query is proven and needs no `events` join and no window:

```sql
select suspect, topic,
       count(*) filter (where solved and unsolved)     as came_back_and_won,
       count(*) filter (where unsolved and not solved) as never_solved_any_session,
       count(*)                                        as installs
from (
  select install_id, suspect, topic,
         bool_or(attempts_to_pass is not null) as solved,
         bool_or(attempts_to_pass is null)     as unsolved
  from friction_attempts_rollup group by install_id, suspect, topic
) per_install
group by suspect, topic;
```

Note `bool_or` is associative but **not invertible** — same family as `max` (`06` round 4). That
is fine *here* precisely because it is computed at read from retained rows and never stored.

**Remaining: the dashboard view.** The number is not meaningful until real players exist (§3.3).

**Honest limits, both of which must ship with the metric:**
- `install_id` is an *install*, not a person: a reinstall splits one player in two, a shared
  machine merges two players into one. It is the right grain available under the identity model
  (`02`, anonymous UUIDs only, no accounts) — but it is a floor on precision, not a detail.
- With a population of one (the author, all `env='dev'`) this number means nothing yet. It is
  gated on real players by §3.3, like every other rate here.

**Why margin is the star (1.2):** pass/fail says *that* it failed; margin says *by how
much*. Failed-by-2 across the board means the threshold is one point off — a five-minute
fix. Failed-by-30 means the player brought the wrong build and no amount of tuning
helps. Identical failure rates, completely different work.

### Module 2 — Content Coverage & Discovery
> *"Is anyone even seeing what I built?"*

The module authors most consistently underestimate, and the one with the highest
"oh no" density. Hours of work on an evidence branch nobody ever opens.

| # | Question | Decision it informs | Metric | Events required | Have? |
| --- | --- | --- | --- | --- | --- |
| 2.1 | What content is never discovered? | cut it, or signpost it | exposure count per content id, incl. **zeroes** | `EvidenceCollected`, `ConfrontationTopicEntered` | 🔵 designed |
| 2.2 | Of players who reach X, how many engage? | is the hook working | engaged ÷ exposed | `ConfrontationTopicEntered` ÷ `ConfrontationAttempted` | 🔵 designed |
| 2.3 | Which optional/alternate routes get used? | is the branching worth it | route share | exposure + route id | ❌ |
| 2.4 | Do players find the evidence needed for a check they failed? | discovery problem vs. reasoning problem | possession-at-attempt | `EvidenceCollected` × `ConfrontationAttempted.evidence_ids` | 🔵 designed |
| 2.5 | **Is the bespoke failure prose ever read?** | **where to spend authoring bandwidth** | declined ÷ displayed, split by threshold-met (§3.2a's 2×2) | `SkillCheckDisplayed` ÷ `SkillCheckResolved` | 🔵 **designed 2026-07-27** |

**2.5 is new (2026-07-25) and is the most unusual question in the inventory** —
it is about where to spend *human effort*, not where players struggle. If players who cannot pass a
check mostly never attempt it, the hand-written failure branches are largely unread and that
bandwidth belongs elsewhere. Blocked on §3.2a's exposure mechanism.

**2.4 is the sharpest question in this module.** A failed confrontation where the
player never found the required evidence is a *discovery* bug; the same failure with
the evidence in hand is a *reasoning* problem. Indistinguishable today.

**Zeroes require a content manifest.** You cannot count what never fired. Answering
2.1 means the mod must declare what content *exists* (a static list) so the dashboard
can diff it against what was seen. Design note, not a blocker.

### Module 3 — Approach & Build Fit
> *"How are players solving this, and can they solve it at all?"*

| # | Question | Decision it informs | Metric | Events required | Have? |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Which archetypes/routes do players take? | which build the mod implicitly assumes | share by `skill_route` | `SkillCheckResolved.skill_route` | 🔵 designed |
| 3.2 | Can a build without the "expected" skill finish? | accessibility of the critical path | completion rate by route | `SkillCheckResolved` + progression events | ❌ (needs 4.2) |
| 3.3 | Which skills/attributes are actually gated on? | is the design as varied as intended | check count by `skill` / `stat_type` | `SkillCheckResolved` | 🔵 designed |
| 3.4 | Do players gravitate to one solution when several exist? | are alternatives real or decorative | solution share per multi-route check | `SkillCheckResolved` + `require` | 🔵 designed |
| 3.5 | **Do players reach for consumables to clear a stat gate, and which ones?** | is the gate passable by preparation, or only by build | boosted ÷ passed, by `item_id` | `ItemConsumed` + `SkillCheckResolved.base_value` | 🔵 **designed 2026-07-27** |
| 3.6 | ⭐ **Does the game contain an accessible remedy for this gate at all?** | **add content, or retune the threshold** | corpus `record_effects` filtered to the gated stat, cross-referenced with what players actually used | `SkillCheckResolved` **× the corpus** (`11`) | 🟢 **mechanical half BUILT 2026-07-28** — `GET /stats/sufficiency` (`05`). Behavioural half still needs `ItemConsumed`; `reachable` is `UNKNOWN` pending `11 §13` |

⚠️ **UPDATE 2026-07-27 — "accessible" is NOT computable from the corpus alone.** `game_records`
stores name/type/text and `record_effects` stores effects; there is **no placement, no value, no
vendor data**. (An earlier version of this note compared against a personal 12-file load order and
claimed two-thirds of the world was missing; that was wrong. The corpus describes **the stable base
every author shares plus the mod being measured** — one author's mod list is not part of the
product. See `11 §13`.) So the honest claim today is *"N items mechanically close this gap"*,
**not** *"players can reach one"*.

✅ **CORRECTED 2026-07-28 — the expansion gap is CLOSED.** The note above previously said the
corpus covered only `Morrowind.esm`, missing Tribunal and Bloodmoon. Since the ordered multi-plugin
merge (2026-07-27 evening) the corpus is **base + Tribunal + Bloodmoon + CCFF — 45,542 records /
3,463 effects**, verified `verify-corpus`-green locally *and* in prod. The **placement** gap is the
one that remains, and it is the one that matters here.

`11 §13` designs the fix: survey the **running game**, which has already merged the load order.
Until that ships, **the UI must render reachability as UNKNOWN — never inferred.** This is the
single place an LLM would fabricate most convincingly (*"sold by most apothecaries"*): fluent,
plausible, probably even true, unverifiable from our data, and **indistinguishable from a computed
fact**. Every other failure this project has hit had a tell; that one has none.

**3.6 is the question 4c exists to answer, and it is the only one here that leaves the telemetry
database.** Every other row is a `GROUP BY` over events. This one joins *what players did* to
*what the game contains* — `record_effects` already holds all 2,960 magic effects across 35 targets
(all 8 attributes, all 27 skills), so "what could possibly fortify Personality, and is any of it
reachable?" is a btree lookup we can already run (`11 §6`).

⭐ **Note the inversion that makes it worth building:** every other question in this inventory can
only say *players are failing*. 3.6 can say **why the failure is not the player's fault** — a gate
with no accessible remedy in the content is a design gap, and the fix is authoring, not tuning.
That is a recommendation about the *product*, derived from telemetry plus content, and it is the
honest justification for reaching past a heuristic (`4c`).

⚠️ **3.5 and 3.6 both require distinguishing a boosted stat from a natural one**, which
`SkillCheckResolved` cannot do today: `skill_value` is the *modified* value, so 42 natural and
30+12 are identical in the table. Resolved additively — see `03`.

**Why this module matters:** it catches *"did I accidentally build this for my own
character?"* — the most common blind spot in solo mod authorship, and invisible when
the author is also the only tester.

### Module 4 — Flow & Pacing
> *"Where does the mod lose people?"*

| # | Question | Decision it informs | Metric | Events required | Have? |
| --- | --- | --- | --- | --- | --- |
| 4.1 | Where do players stop playing? | the drop-off cliff | last event / area before session end | existing (`AreaEntered` + session) | 🟡 |
| 4.2 | How far through the mod do players get? | completion funnel | funnel by milestone | **progression/milestone events** | ❌ |
| 4.3 | How long between milestones? | pacing — is act two a slog | elapsed time per stage | milestone events + `ts` | ❌ |
| 4.4 | Do players return after a break? | is the mod re-entered or abandoned | sessions per `install_id`, gaps | existing | 🟡 |
| 4.5 | Where do players *backtrack*? | lost / unclear objective | area revisit patterns | `AreaEntered` (sequence query) | 🟡 |

**Session-end caveat (4.1):** we have no `SessionEnded` event, and we largely *cannot*
have a reliable one — a crash, an alt-F4, and a clean quit are indistinguishable from
the log. "Session end" is therefore **inferred** as "last event bearing that
`session_id`," which is honest but fuzzy: it is really *last observed activity*. Any
view built on it must say so.

---

## 5. What the inventory says to build

Reading the **Have?** column top to bottom, the gaps rank cleanly:

1. ~~**Sequence-aware queries**~~ — **query layer done 2026-07-20** (`GET /stats/friction`,
   `07 §4`): 1.3 / 1.4 / 1.6 answered from rows already in Postgres, zero new events.
   **Dashboard view shipped 2026-07-20** (`07 §4a`), with the §3.3 sample-size rule
   enforced in the UI (`07 §4b`). **Remaining: 4.1 / 4.5** (same technique, `AreaEntered`).
2. ~~**Skill-check event with raw value + threshold**~~ — **DONE 2026-07-20**
   (`SkillCheckResolved` + `PuzzleAttempted`, verified live; `GET /stats/skills` +
   dashboard view, `07 §5b`/`§5d`). Q1.2, Q3.1, Q3.3 answered.
3. **Exposure events — DESIGNED 2026-07-20** (`03`): `ConfrontationTopicEntered`
   (the denominator), `ConfrontationExited`, `EvidenceCollected`, plus `evidence_ids` /
   `claim` as additive fields on `ConfrontationAttempted`. All four seams verified as
   single call sites in CCFF. **Not yet emitted.** `ConfrontationOpened` was proposed
   and trimmed — derivable from `ConfrontationExited` (`03`). Counting *zeroes* (2.1)
   still needs the content-manifest design below.
4. **Milestone/progression events.** Unlocks 4.2/4.3.
5. **Sample-size discipline in the UI** (§3.3) — cheap, and it makes everything above
   honest.

Note what changed: the CCFF skill-check work we were about to start was **#2, not #1**.
The inventory reordered it, which is the point of writing one.

---

## 6. Rules for this doc

1. A question earns its place by naming the **decision** it informs. "Interesting to
   know" is not a decision.
2. An event earns its place in `03` by citing a question **here**. Update this doc
   first, then the registry.
3. Prefer questions answerable by **sequence** over questions needing new events —
   cheaper and already collected.
4. Every metric ships with its **denominator and n**. A rate without a sample size is
   not a metric.
5. Modules are containers, not a taxonomy to defend. Add a fifth when a real question
   won't fit — don't force it.

---

## 7. What this doc does NOT govern — the scope boundary (recorded 2026-07-27)

`/search` (doc `11`, dashboard `07 §8`) shipped without a row here, and that is **correct**, not
an oversight. Recording it so a future session does not try to retrofit one.

This inventory governs **questions about player behaviour**, answered from telemetry. Every rule in
§6 assumes that shape: a question names a decision, an event cites a question, a metric ships with
a denominator and an `n`.

Corpus search is a different kind of surface. It reads the **game's own content** — dialogue,
quests, items, spells, cells — which is fixed data shipped with the game, not something players
generate. There is no denominator, no sample size, and no event to justify, because nothing is
being measured. It is a **lookup tool** for the mod developer, not an analytics answer.

⚠️ **The distinction matters at the join.** `11 §3` grades `AreaEntered.area` → `game_records`
(named `CELL`s) as the platform's one exact join. When that join is used to rank content *by what
players actually engage with*, the result **is** an analytics question and **does** belong here,
with a denominator like any other. Searching the corpus is not; ranking it by telemetry is.

Rule 6 for §6: **a surface earns a row here when it measures players.** Reading game data does not.

## 8. Q3.6 read side shipped (2026-08-09)

The mechanical half went live 2026-07-28 (`/stats/sufficiency`) and was **invisible** — no view
rendered it. `/gaps` (`07 §9`) closes that, and Phase 4c (`12`) adds the generated layer on top.

⭐ **The inventory gained a distinction it did not have.** Q3.6 asked "does the game contain an
accessible remedy?" and stopped at yes/no. The pair *(verdict, signposting)* splits the yes:

| | Author's next move |
| --- | --- |
| `remedy_exists` + `NOT_SIGNPOSTED` | the content already exists — **write one hint line** |
| `remedy_exists` + `SIGNPOSTED` | players are being told and still failing — look elsewhere |

Those lead to opposite work, and no query can separate them: the difference is whether a passage of
prose *points at* a remedy, which is a judgement about text. That is the whole justification for
reaching for a model here, and it is the only place in this inventory where one is justified.

⚠️ **A gate is `(check_id, stat, stat_kind, threshold)`, not `check_id`** (`12 §6`). Any future
question keyed on a check rather than a gate will silently aggregate sixteen different gates with
disagreeing verdicts.
