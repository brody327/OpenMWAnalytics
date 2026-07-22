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
| 1.1 | Which content has the highest failure rate? | where to look first | pass rate by topic / check, **with n** | `ConfrontationAttempted` | 🟡 |
| 1.2 | *How badly* do players fail — by a hair or by a mile? | tune threshold vs. redesign | distribution of **margin** (`skill_value − threshold`) | `SkillCheckResolved` | 🔵 designed |
| 1.3 | How many attempts precede a success? | is it deduction or brute force | attempts-to-first-pass, per player per check | existing (`ROW_NUMBER`) | ✅ API |
| 1.4 | What do players do *after* failing? | good friction vs. bad friction (§3.1) | next-event distribution after a fail | existing (`LEAD`) | ✅ API |
| 1.5 | Which failure *modes* dominate? | fix the specific confusion | `reason` breakdown | `ConfrontationAttempted.reason` | ✅ |
| 1.6 | Is anything effectively unpassable? | unwinnable-state bug hunt | checks with 0 passes and n ≥ threshold | existing | ✅ API |
| 1.7 | Do players who quit on a topic ever come back and beat it? | is `session_end` churn, or just bedtime | per **install**: topics with ≥1 unsolved session *and* ≥1 solved session | existing (`install_id`) | 🟡 query proven, no view |

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
