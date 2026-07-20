# 03 — Event Registry (the tracking plan)

**Status:** 🟡 in progress. **Live:** `AreaEntered`, `ConfrontationAttempted`.
**Verified live 2026-07-20:** `ConfrontationTopicEntered`, `ConfrontationExited`,
`EvidenceCollected` (9 events vs 9 discovery log lines — exact 1:1, and the first
**global-context** SDK consumer working), + `evidence_ids` and `claim_index` on
`ConfrontationAttempted` (arrays of length 1–3 land as jsonb `array`; `claim_index` as
`number`; `reason` correctly omitted on pass). **Designed, not implemented:**
`SkillCheckResolved`, `PuzzleAttempted`. **Retired + confirmed gone from the log:**
`SpikeStarted`, `Heartbeat`.

This is the **governed vocabulary** half of the "generic transport, governed
vocabulary" split (`02 §6`). The transport accepts *any* `type`; this doc decides
which `type`s are *canonical*, what their `data` means, and when they fire. It is
the analytics equivalent of a **tracking plan**: the contract between the emitter
(mod) and every consumer (dashboard queries). Adding an entry here is a product +
schema decision, **not** a pipeline code change.

⚠️ **Events are justified by questions, not by capturability.** Before adding a
`type` here, name the question it answers in `10_ANALYTICS_QUESTIONS.md`. The two
events below predate that doc and were designed bottom-up; their "Question it
answers" lines have since been mapped onto the inventory.

## Conventions (recap of `02`)

- **`type`**: `PascalCase`, noun + past-tense verb (`AreaEntered`, `QuestCompleted`).
- **`data` keys**: `snake_case`; keep the shape tight; **consumers ignore unknown
  fields**, so new fields are added *additively*. An incompatible reshape means a
  new `type` (e.g. `AreaEntered2`), never a silent change of meaning.
- **Grain discipline**: an event should fire at the coarsest grain that still
  answers its question. High-frequency, low-information events are a **cardinality**
  problem — they bloat storage and drown signal. Pick the grain deliberately.

---

## ~~System events~~ — RETIRED 2026-07-20

`SpikeStarted` (once per context start) and `Heartbeat` (every 5s) were dev-visibility
placeholders from the ingestion spike. **Both are removed** from `telemetry.lua`.

**Why they had to go — a real cost, not tidiness:**

- They **answered no product question**, which is now disqualifying (`10 §1`).
- They **corrupted sequence analysis.** `Heartbeat` fired every 5s, so the row
  following almost any real event was a heartbeat — `LEAD()` over the stream reported
  *"players respond to failure by idling."* An instrumentation artifact presented as
  behaviour. Local data was 1049 heartbeats against 11 real events (`07 §4`).
- They conflated **platform liveness** (an ops concern — `/health`, monitoring) with
  **product telemetry**. Proving the pipeline breathes by injecting synthetic rows into
  the event log is the wrong tool for the job.

**What was genuinely lost:** true *session duration*. Real events only bound "last
observed activity," so a player idling in a menu before quitting dates the session end
early. If Module 4 pacing (`10` Q4.3) needs this, the answer is a deliberate **coarse**
`SessionPinged` (60s+) justified by that question — not a 5-second dev relic. Sessions
already played cannot be back-filled.

⚠️ **The event log is append-only: removing the emitter does not remove history.**
Existing `Heartbeat` / `SpikeStarted` rows remain in Postgres, so consumers doing
sequence work must keep excluding them (`friction.ts` does). Deletion of historical
rows is a separate decision, not taken.

---

## `AreaEntered`

**Question it answers:** *Where do players spend their time?* — most-entered areas,
last area before a session ends (drop-off), whether a given area is ever visited.

**Grain — meaningful area (decided 2026-07-15):** fires only when the player
enters a *new meaningful area*, defined as:

| Player is… | `area` = | `interior` |
| --- | --- | --- |
| outside (exterior cell) | the cell's **region id** (`cell.region`) | `false` |
| inside (interior cell) | the **cell name** (`cell.name`) | `true` |

**Why this grain (and not "every cell"):** Morrowind exteriors are a seamless grid
of mostly *unnamed* cells (`cell.name` empty; only `gridX/gridY`). Firing per cell
would emit a firehose of `{gridX,gridY}` noise as the player walks. The **region**
is the meaningful exterior unit; the **named cell** is the meaningful interior unit.
Walking Balmora → Seyda Neen (both West Gash) emits **nothing**; crossing into
Ascadian Isles emits one event. Low volume, every row answers the question.

**Trigger / detection:** a player-context script (`scripts/omwanalytics/player.lua`)
polls `self.cell` (~4×/s) and compares an `interior:area` key to the last one; on
change it calls `track('AreaEntered', …)` (the `track.lua` SDK helper, which sends
`OMWA_Track`) to the global emitter, which assigns the `seq`/identity envelope —
first-party dogfooding of the same path third parties use. Polling (not
`onTeleported`) is required because seamless
exterior walking never fires a teleport. *Regionless exterior cells and unnamed
interiors are skipped* (we can't name a meaningful area, so we emit nothing rather
than noise).

**`data` shape:**

| Key | Type | Meaning |
| --- | --- | --- |
| `area` | string | region id (exterior) or cell name (interior) — the human-facing area label |
| `interior` | bool | `true` = named interior, `false` = exterior region |

**Wire example:**
```
OMWA1 {"v":1,"type":"AreaEntered","seq":7,"install_id":"e2a9…","session_id":"c443…","ts":1784126869000,"data":{"area":"Balmora, Guild of Mages","interior":true}}
```

**Notes / evolution:**
- `02 §8`'s inline example used `{cell, region, interior}` illustratively; **this
  doc is authoritative** for the payload. We collapsed to `{area, interior}` because
  a single semantic `area` label is what the "where do players spend time" query
  groups by; raw `region`/`cell` split can be added *additively* later if a query
  needs it.
- Display-name polish for region ids (`"west gash region"` → `"West Gash"`) is
  deferred to the dashboard layer; the id is stable and query-safe as stored.
- Possible later companion: `AreaExited` / dwell-time, if a "time spent per area"
  metric needs explicit exit events rather than deriving from the next `AreaEntered`.

---

## `ConfrontationAttempted`

**First third-party event (defined + verified live 2026-07-17).** Emitted by a *separate* mod —
`TheContrivedCaseOfFlordiusFastus` (CCFF) — not by our own scripts. This is the
`08 §4` "another mod's pure-internal custom logic" case made real: CCFF's
confrontation is a **bespoke deduction contest** (not an engine skill roll), so it
is opaque to passive capture and must **emit to us** over the `OMWA_Emit` seam. It
is the forcing function for a future public SDK (still deferred — see `08 §5`).

**Question it answers:** *Where do players get stuck in confrontations?* — pass rate
per suspect/topic, which failure modes dominate, how many attempts precede a break.

**Grain — one event per *committed* attempt (decided 2026-07-17):** fires exactly
when the player commits a check — a **fact jab** (`presentFactCard`) or a
**pattern** case (`makeCase`) — capturing *both* pass and fail. It does **not** fire
on mid-attempt UI (claim selection, adding/removing a board piece, opening the
ledger). Failed attempts are the point: they carry the difficulty/funnel signal.

**Trigger / detection:** CCFF's `scripts/ccff/confront_panel.lua` (a PLAYER script)
calls `track('ConfrontationAttempted', …)` via a **guarded** `require` of the
`scripts.omwanalytics.track` SDK helper (which sends `OMWA_Track`). The global event
crosses the mod boundary through OpenMW's shared global-event namespace and lands in
our `telemetry.lua`, which re-validates it (type/shape + key/size caps) and assigns
the identity + `seq` envelope. If OMWA is not installed the guarded require yields
nil and the calls are no-ops (fire-and-forget, no load error).

**`data` shape:**

| Key | Type | Meaning |
| --- | --- | --- |
| `suspect` | string | suspect id (e.g. `titania`) |
| `topic` | string | topic id within that suspect (e.g. `name_at_scene`, `crime_scene`) |
| `kind` | string | `fact` (single self-evident card) or `pattern` (claim + evidence set) |
| `passed` | bool | did the committed attempt land |
| `reason` | string | **fail only** (omitted on pass): `wrong_evidence`, `wrong_claim`, `missing_requirement`, `irrelevant_evidence`, `missing_required_tag`, `insufficient_support` |

**Wire example:**
```
OMWA1 {"v":1,"type":"ConfrontationAttempted","seq":12,"install_id":"e2a9…","session_id":"c443…","ts":1784260000000,"data":{"suspect":"titania","topic":"crime_scene","kind":"pattern","passed":false,"reason":"missing_required_tag"}}
```

**Notes / evolution:**
- `passed` is a bool so pass-rate is `avg(passed::int)`; `reason` is CCFF's own
  vocabulary (it owns this event's `data`), safe to extend additively.
- No API/DB change: generic transport stores a new `type` with zero DDL, `data` in
  JSONB. Proven by `AreaEntered`.
- This event — a *foreign* mod writing tracking calls into its own source — was the
  forcing function for the public SDK, now **built (2026-07-18, see `08 §5`)** and
  extracted *from* this integration: `OMWA_Track` single validated ingress + the
  `track.lua` helper + emitter-side payload validation. CCFF was refactored from the
  raw `sendGlobalEvent` to the guarded helper as the SDK's first consumer.

### Additive fields (added 2026-07-20 — NOT yet verified live)

`presentFactCard(id)` already holds the presented id, and `makeCase()` already builds
`laid` (the full evidence array) plus the chosen claim — **all of it is in scope at the
existing 8 call sites and none of it is currently emitted.**

| Key | Type | Meaning |
| --- | --- | --- |
| `evidence_ids` | string[] | evidence presented on this attempt — one id for `fact`, the laid board for `pattern` |
| `claim` | string | **`pattern` only**: the claim the player chose |

**Additive fields, not a new event** — the grain is unchanged (one per committed
attempt), and `02`'s rule is that consumers ignore unknown fields, so adding to `data`
is backward compatible. A *reshape* would need a new `type`; this is not one.

**Why it matters:** it turns `reason: 'irrelevant_evidence'` from *"they were wrong"*
into *"they were wrong with **this** card"* — the difference between knowing a check is
hard and knowing which specific piece misleads people. Serves `10` Q1.5, and combined
with `EvidenceCollected` it is half of Q2.4.

---

## `ConfrontationTopicEntered`

**Status:** 🟢 **VERIFIED LIVE 2026-07-20.** Third-party (CCFF).

**Question it answers:** `10` Q2.1 / Q2.2 — *which topics do players actually engage,
and of those who engage one, how many commit an attempt?* **This is the denominator
event for `ConfrontationAttempted`.**

**Why it exists (the denominator problem, `10 §3.2`):** every event we emit today is an
*engagement* event — it fires when a player **does** something. A pass rate computed
only over attempts cannot distinguish *"nobody passes this topic"* from *"nobody tried
this topic,"* which demand opposite fixes. A rate needs a denominator, and the
denominator must match the **grain of its numerator**: attempts are per *topic*, so
exposure must be per topic too — suspect-level exposure would not divide correctly.

**Grain — one event per topic entry, *including re-entries*.** Deliberately **not**
deduped at the emitter. "Distinct topics entered per session" is one `DISTINCT` away at
read time, whereas re-entry counts (how many times a player circles back to a topic
before committing) cannot be recovered if we drop them at emit. **Precompute at write
time only what you cannot reconstruct at read time** (`07 §4`).

**Trigger / detection:** `confront_panel.lua` `enterTopic(topic)` (~line 668) — one call
site, fires for every topic raised from the hub.

**`data` shape:**

| Key | Type | Meaning |
| --- | --- | --- |
| `suspect` | string | suspect id (`activeId`) |
| `topic` | string | topic id |
| `kind` | string | `texture` \| `fact` \| `pattern` |

**⚠️ `kind` is load-bearing, not decoration.** `enterTopic` handles three kinds, and
**`texture` topics are non-contestable** — they print their body and return, so they can
*never* produce a `ConfrontationAttempted`. Including them in the denominator would
silently deflate every engagement rate. Consumers computing Q2.2 **must** filter to
`kind IN ('fact','pattern')`.

---

## `ConfrontationExited`

**Status:** 🟢 **VERIFIED LIVE 2026-07-20.** Third-party (CCFF).

**Question it answers:** `10` Q1.4 — *did the player leave this confrontation solved or
abandoned?* Replaces a fragile **inference** with a fact.

**Why it exists:** `/stats/friction` currently infers abandonment from what event
happens *next* (`next_action = 'left_area'`), which cannot tell *"stormed off in
frustration"* from *"walked two rooms over to fetch the evidence they just realised they
needed."* Opposite readings, identical data. An explicit exit carrying an outcome
collapses abandonment rate to a plain `GROUP BY` and removes the ambiguity.

**Grain — one event per closed confrontation visit.**

**Trigger / detection:** `confront_panel.lua` `closePanel` (~line 1136). ⚠️ **Guard
required:** `closePanel` is invoked from four sites and is written to be safe when
nothing is open (`if panel then panel:destroy()`). The emit must be conditional on a
panel having actually been open, or spurious closes produce **phantom exits** — visits
that never happened.

**`data` shape:**

| Key | Type | Meaning |
| --- | --- | --- |
| `suspect` | string | suspect id (`activeId`, still set at close) |
| `completed` | bool | `isCompleted()` — every position broken, i.e. the suspect is finished |

**Also serves as the suspect-level exposure marker** — see the trim note below.

**Known leak:** a session that ends with the panel still open (crash, alt-F4) emits no
exit. Same family as the inferred-session-end caveat in `10` module 4; the visit is
simply absent rather than miscounted.

---

## `EvidenceCollected`

**Status:** 🟢 **VERIFIED LIVE 2026-07-20.** Third-party (CCFF).

**Question it answers:** `10` **Q2.4 — the sharpest question in the inventory:** a failed
check where the player never found the required evidence is a **discovery** bug; the
same failure with the evidence in hand is a **reasoning** problem. Opposite fixes,
indistinguishable today. Paired against `ConfrontationAttempted.evidence_ids`, this
separates them. Also answers Q2.1 (what is never discovered).

**Grain — one event per evidence id, on FIRST discovery only.**

**Trigger / detection:** `evidence_bridge.lua` `discover(id, silent)` (~line 132), placed
**after** the already-known early-return at ~line 141. Every discovery path converges
here (`discoverMany` loops it; the direct / batch / bridge-value handlers all route
through it), and the existing dedup gives first-discovery grain **for free** — no guard
to write. The cleanest seam in the CCFF codebase.

**⚠️ First GLOBAL-context SDK consumer.** Every prior `track()` caller has been a
player/local script. `evidence_bridge.lua` is a **global** script; verified against the
offline 0.51 docs (`Package openmw.core.txt`) that `core.sendGlobalEvent` is restricted
only in *load* scripts and in menu scripts while the game is not running — global
scripts may call it. `track.lua`'s header comment ("any LOCAL / PLAYER / MENU script")
is narrower than reality and should be corrected when this lands.

**`data` shape:**

| Key | Type | Meaning |
| --- | --- | --- |
| `evidence_id` | string | the evidence id discovered |

**No `source` field, deliberately.** `discover(id, silent)` knows *what* was found but
not *how* (inspect panel / proximity / dialogue / item use) — that context lives in the
callers upstream. This is the standing tradeoff of choke-point instrumentation:
**one site buys total coverage and costs context.** Q2.4 only needs *whether* the player
had the evidence, so id-only ships first; `source` is an additive field later if a
question demands it, at the cost of threading a parameter through every call path.

**Data-hygiene note:** the `CCFF_ResetFoundEvidence` dev path clears the found set, so
testing with it produces impossible re-discoveries. CCFF also keeps an internal
`evidence_discovered` counter via `CCFF_TrackStat`; it is not exported, so this
duplicates nothing.

---

## `SkillCheckResolved`

**Status:** 🟡 **implemented 2026-07-20, lint-clean, NOT yet verified live.**
Third-party (CCFF). Read side: `GET /stats/skills` (`07 §5`).

**Questions it answers:** `10` **Q1.2 (margin)** and **all of Module 3** (Approach &
Build Fit) — which stats the mod actually gates on, which archetypes players bring, and
whether a build without the "expected" skill can finish.

**Grain — one event per resolved stat check**, whether the player chose to take it or
walked into it. *Decided 2026-07-20:* the unit is **a check resolving**, and opt-in-ness
is an *attribute* of the check, not a different kind of event — a passive check was
still attempted, the player just didn't opt in. Hence one type with a mandatory
`trigger` discriminator rather than two types.

⚠️ **Friction queries MUST filter `trigger = 'inspect'`.** A failed *passive* check is
not friction — the player never knew it happened, so it carries no frustration signal.
Including passive rows in a difficulty metric would corrupt it with checks nobody chose
to take. This is the cost of the one-event model, and it is paid by discipline in the
query layer.

**Trigger / detection — two seams, one event:**

| `trigger` | Seam | Context |
| --- | --- | --- |
| `inspect` | `evidence_inspect.lua` `handleAction`, the `skill_check` branch (~2118–2259) | GLOBAL |
| `environment` | `evidence_player.lua` `CCFF_PassiveTriggerFired` (~2032) | PLAYER |

**⭐ One choke point covers every inspect check** — contrast `ConfrontationAttempted`,
which needed 8 call sites. Any check CCFF adds later is captured for free.
*(`environment_trigger.lua` itself is **not** a seam: it only reads config and hands off;
the PLAYER script does the evaluating.)*

**Implementation note — the passive silent-fail gap (found 2026-07-20).** The passive
multi-stat path tracked only `bestPass` (met the full threshold) and `bestAware` (met the
`awareness_threshold`). When **neither** is set — every stat below even the awareness floor —
the original code retained **no deciding stat at all**: the per-stat value is scoped to the
loop and discarded, because gameplay needs nothing in that case. Telemetry does. Resolved
with an additive `bestAny` tracker (highest value across all stats regardless of threshold),
read **only** by the emit and never by gameplay logic — mirroring the "highest-value failer
if all fail" rule the inspect seam's OR check already uses. Winner precedence:
`bestPass or bestAware or bestAny`.

**No `weird_success_chance` equivalent exists on the passive path**, so `threshold_passed`
always equals `passed` for `trigger = 'environment'`. The passive multi-stat check is
always OR, so it reports `require = 'any'`.

**Not fired at all** when `pass_evidence` is already found — the handler returns before any
stat is read, so no check was ever *resolved*. Correct per this event's grain.

**`data` shape:**

| Key | Type | Meaning |
| --- | --- | --- |
| `trigger` | string | `inspect` (player-initiated) \| `environment` (passive) — **mandatory** |
| `check_id` | string | which check: `recordId:actionId` for inspect, trigger object id for environment |
| `skill` | string | the deciding stat |
| `stat_type` | string | `skill` \| `attribute` — checks span both |
| `skill_value` | int | the player's modified value, **raw** |
| `threshold` | int | the value needed, **raw** |
| `passed` | bool | what the player experienced (post-override) |
| `threshold_passed` | bool | whether the roll *honestly* cleared the bar (pre-override) |
| `require` | string | `any` (OR) \| `all` (AND) — **omitted on single-stat checks** |
| `skill_route` | string | CCFF's archetype counter key, when set |

### Why margin is stored raw, not computed

`skill_value` and `threshold` ship as raw integers; **margin is derived in SQL**
(`skill_value - threshold`). A derived field can always be recomputed from raw values;
raw values can never be recovered from a precomputed margin. Same principle as
`ConfrontationTopicEntered`'s re-entries: precompute at write time only what you cannot
reconstruct at read time.

Margin is the highest-value field in this event. Pass/fail says *that* a check failed;
margin says *by how much*. **Failed by 2 across the board = the threshold is one point
off (a five-minute fix). Failed by 30 = the player brought the wrong build and no tuning
helps.** Identical failure rates, completely different work.

### ⚠️ `require` changes what margin MEANS

Multi-stat checks keep only a single "winner", selected differently per mode
(`evidence_inspect.lua` 2146–2183):

| Mode | Winner is… | So a negative margin means… |
| --- | --- | --- |
| AND, passed | weakest link (smallest surplus) | — |
| AND, failed | **worst** blocker (largest deficit) | your *worst* stat was N short |
| OR, failed | **highest-value** failer (smallest deficit) | your *best* stat was N short |

Same number, opposite readings. `require` is therefore not optional metadata — **margin
is uninterpretable without it.**

### `threshold_passed` — recording a distinction the fiction hides

`weird_success_chance` (`evidence_inspect.lua` ~2203) can flip a genuine threshold
*failure* into a full pass on a low-probability roll (0.0005 on the Jeanus lockbox),
deliberately indistinguishable in-game: same evidence, same callback, same "Passed"
header. **Decided 2026-07-20: telemetry records both.** `passed` preserves the player's
experience; `threshold_passed` preserves the honest roll. Difficulty tuning reads the
latter — a fluke counted as a real pass would silently inflate the pass-rate of exactly
the hardest checks, the ones most in need of accurate data. The illusion stays intact
in-game; the author is simply not lied to by their own dashboard. (`was_fluke` is
**not** stored — it is exactly `passed AND NOT threshold_passed`, derivable.)

---

## `PuzzleAttempted`

**Status:** 🟡 **implemented 2026-07-20, lint-clean, NOT yet verified live.** Third-party
(CCFF).

**Question it answers:** `10` Q1.1 / Q1.3 / Q1.6 applied to **puzzles** rather than
skill checks — combination locks and their kin, where no stat is involved at all.

**Why a separate type from `SkillCheckResolved`:** a `dial_check`
(`evidence_inspect.lua` ~2261) shares almost nothing with a stat check — no stat, no
threshold, no margin, just a combination guess against a solution. Folding it in would
produce rows that are null in more than half their columns and force a `WHERE` on every
skill-check query. **Different payload shape ⇒ different type**, per `02`.

**Grain — one event per committed dial submission** (pass and fail both).

**Trigger / detection:** `evidence_inspect.lua` `handleAction`, the `dial_check` branch
(~2261–2283). One call site.

**`data` shape:**

| Key | Type | Meaning |
| --- | --- | --- |
| `puzzle_id` | string | `recordId` of the puzzle object |
| `action_id` | string | which action on it |
| `passed` | bool | did the submitted combination match |

**Deliberately NOT stored: the submitted combination.** It is the *answer* to the
puzzle; a public dashboard is the wrong place for it, and "how wrong were they" is not a
question we have committed to answering. Attempts-to-first-pass (the same `ROW_NUMBER`
technique as `07 §4`) carries the difficulty signal without spoiling anything.

---

## Correction: `skill_check_tiered` does not exist

`evidence_inspect.lua`'s header comment documents a `skill_check_tiered` action type
with a `tiers` array. **Verified 2026-07-20: it is vestigial** — zero actions declare
it, `.tiers` is referenced nowhere, and `handleAction` has no branch for it. Earlier
planning notes that treated tiered checks as a live dimension were wrong. The real
second check type is `dial_check`.

---

## Trimmed from this set: `ConfrontationOpened`

Proposed and **cut before implementation** (2026-07-20), recorded because the reasoning
generalises.

The intent was suspect-level exposure ("did the player ever engage this suspect at
all"). It is **derivable**: every panel visit ends in exactly one `ConfrontationExited`,
which already carries `suspect` — so counting distinct suspects with an exit answers it
without a fifth event. Even the interesting case, *opened and left without touching a
topic*, is visible as an exit with **no** preceding `ConfrontationTopicEntered` for that
suspect in the session.

The one thing lost is a visit that never closes (crash with the panel open), which the
open-event would have caught. Judged not worth a whole event type at this stage.

**The general rule:** an event that is reconstructible from events you are already
emitting is not a new event — it is a query. Add it only when the reconstruction becomes
unreliable or expensive.
