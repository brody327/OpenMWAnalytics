# 03 — Event Registry (the tracking plan)

**Status:** 🟡 in progress. **Live:** `AreaEntered`, `ConfrontationAttempted`.
**Verified live 2026-07-20:** `ConfrontationTopicEntered`, `ConfrontationExited`,
`EvidenceCollected` (9 events vs 9 discovery log lines — exact 1:1, and the first
**global-context** SDK consumer working), + `evidence_ids` and `claim_index` on
`ConfrontationAttempted` (arrays of length 1–3 land as jsonb `array`; `claim_index` as
`number`; `reason` correctly omitted on pass).
**Verified live 2026-07-27:** `ItemConsumed` (first-party, `mod_id='base'`, incl. the quick-keys
path `ItemUsage` could not have seen), `SkillCheckDisplayed` (3 checks per open, hover repaints
correctly silent, `check_id` joins exactly to `SkillCheckResolved`), and `SkillCheckResolved`'s
additive **`base_value` / `stat_modifier` / `stat_damage`** — proven on an attribute check where
Skooma carried the player from base 20 to 40 against a threshold of 40, i.e. *the boost was the
only reason it passed*. **Designed, not implemented:** `PuzzleAttempted`.
**Retired + confirmed gone from the log:** `SpikeStarted`, `Heartbeat` — but see `06`
`shipper_state`, which reinstates *ops* liveness as a **single-row table**, never an event.

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
| `base_value` | int | **additive 2026-07-27** — the player's *unmodified* stat. See below |
| `stat_modifier` | int | **additive 2026-07-27** — net modifier on the deciding stat (`+` fortify, `−` drain) |
| `stat_damage` | int | **additive 2026-07-27** — damage on the deciding stat |

### `base_value` / `boost_magnitude` — why both, and why neither is inferred (2026-07-27)

`skill_value` is the player's **modified** value, so a natural 42 and a `30 + 12` are identical in
the table today. Questions `10` **3.5** and **3.6** both need them separated.

**`base_value` follows this doc's own raw-over-derived rule.** Do not emit `used_booster` — that
bakes a judgment in at write time. Emit the raw unmodified stat and derive everything:

| derived in SQL | meaning |
| --- | --- |
| `skill_value - base_value` | how much boost was in play |
| `base_value < threshold AND skill_value >= threshold` | ⭐ **the boost is the ONLY reason this passed** |
| `base_value >= threshold` | they'd have passed anyway; the potion was wasted |

**The boost is read, not reconstructed — and the mechanism changed once it was verified.** The
first design (2026-07-27, morning) used
`Actor.activeEffects(p):getEffect(core.magic.EFFECT_TYPE.FortifyAttribute, '<stat>')`. **Superseded
the same day:** the 0.51 docs show `SkillStat` and `AttributeStat` each expose **four** fields —
`base`, `modified`, `modifier`, `damage` (`Package openmw.types.txt:1789`, `:425`). So
`.modifier` **is** the net boost, directly:

| vs. `activeEffects` | why the stat fields win |
| --- | --- |
| covers **every** source | fortify from a potion, spell, birthsign or enchantment all land in `.modifier`; querying one `EFFECT_TYPE` would miss the others |
| distinguishes fortify from **drain** | `.modifier` is signed and `.damage` is separate — a drained stat is a *different* story from an unboosted one, and one effect-type query cannot see it |
| one read, no enumeration | no guessing which `EFFECT_TYPE` constant applies to a skill vs an attribute |

⚠️ **Coerce with `tonumber()`.** CCFF's own code warns (`evidence_inspect.lua:1853-1855`) that these
stat fields may return **userdata with a `__tonumber` metamethod, not a plain Lua number**. Every
existing read in that mod wraps them; a new one must too, or the JSON payload will be malformed in
a way that looks like a missing field.

⚠️ **Base is not in scope at the emit site**, so it has to cross the player→global boundary.
Implemented 2026-07-27 as **one map of records**, `statDetail = { [stat] = { base, modifier,
damage } }`, sent from both click payloads (`inspect_panel.lua` multi-stat and single-stat) and
threaded through `handleAction`'s signature and its dispatch.

**Why one grouped map and not three parallel ones** (`statBase` / `statModifier` / `statDamage`):
the three numbers are only meaningful together, and parallel maps would have to be kept in sync by
convention at every call site — a fourth field later means a fourth map rather than a key. The
learner's framing: *consistency with the existing `statValues` shape is worth something, but not
when the data's own structure argues otherwise.* `statValues` is left untouched, so nothing
existing can break.

⚠️ **Telemetry-only, and gameplay must never read it.** `handleAction` takes
`providedStatDetail` purely to emit; a missing or empty table therefore cannot change what the
player experiences.

⚠️ **Each field is written only if present — never defaulted to 0.** A `stat_modifier` of 0 is a
*claim* ("unboosted"), and defaulting would make it indistinguishable from "the player script
didn't send it." Absent means unknown.

⚠️ **A rejected design, recorded because it looks correct.** The obvious cheaper route is to skip
both fields and reconstruct causality from event order: *"they consumed a +20 potion, then passed a
check they previously couldn't."* It fails silently in at least four ways —

| # | blind spot | what you'd wrongly conclude |
| --- | --- | --- |
| 1 | two sources stack (potion + enchanted ring) | credits the wrong item |
| 2 | non-item fortifies (spell, birthsign) or a **Drain** from disease | delta points the wrong way |
| 3 | the base value legitimately changed (level-up, training, skill book) | reads real progression as a potion |
| 4 | the potion **expired** before the check | a consume event with no effect behind it |

> **The rule: do not reconstruct what you can observe.** Reconstruction always yields a plausible
> number, which is what makes it dangerous. The timestamp join still has a job — *attributing which
> item* supplied the boost, where being occasionally wrong is acceptable because the primary fact
> is already known directly.

---

## `SkillCheckDisplayed`

**Status:** ✅ **VERIFIED LIVE IN PROD 2026-07-28.** Third-party (CCFF).
⚠️ **The emitting code is still UNCOMMITTED in the CCFF working tree** (0 occurrences of
`emitChecksDisplayed` in `HEAD`). It works and is one `git checkout` from being lost.

**First real rows, same play session** — the panel flipping under a buff, on one check:

| # | event | payload |
| --- | --- | --- |
| 1 | `SkillCheckDisplayed` grp 4 | `ccff_attic_vent_in:open`, `threshold_met: false` |
| 2 | `ItemConsumed` | `potion_skooma_01` |
| 3 | `SkillCheckDisplayed` grp 5 | same check, `threshold_met: true` |
| 4 | `SkillCheckResolved` | `base_value 20`, `stat_modifier +20`, `skill_value 40`, `threshold 40`, **passed** |

⭐ **A controlled pair arrived on the same check, same character** — `stat_modifier 0` ⇒ value 20 vs
threshold 40 ⇒ **failed**; `stat_modifier +20` ⇒ value 40 ⇒ **passed**. The only varying term is the
boost, so causation is structural rather than inferred. *(A temporal-window join — the approach
considered and rejected — could not have distinguished this from a healing potion drunk nearby.)*

⚠️ **`display_group` IS NOT DENSE — the observed run went 1, 3, 4, 5.** The counter increments once
per real panel open, but events emit only for actions that are *checks*, so a panel containing no
check silently consumes a number. **The read side must never infer "panels seen" from
`max(display_group)` or from counting distinct values** — it can only group checks shown together.

✅ **FEASIBILITY GATE CLOSED 2026-07-27 — the full 2×2 IS buildable, from the PLAYER context only.**

⭐ **The deciding finding: the panel renderer already computes threshold-met at display time**, for
both skills and attributes, because that is what colours each row gold vs dim
(`inspect_panel.lua:811-827` reads the stats, `:909-915` and `:1022` compare them). The player is
*literally shown* whether they can pass. Nothing new has to be computed — it has to be recorded.

⚠️ **Emit from the player, never from `evidence_inspect.lua`.** The global script has **no
attribute access at all** and its own comment (`:2042-2044`) declares player stats unreliable
there; stat values are pushed in from the player at click time. A global emit yields only the top
row of the 2×2.

**Lowest-friction site:** `evidence_player.lua:1958-1960` (the `CCFF_ShowInspectPanel` handler) —
it already has the guarded `omwaTrack` require and `self` in scope. ⚠️ It does **not** see the
Back-refresh path, handled separately at `evidence_player.lua:2234`.

### ⚠️ Three false-display filters, or the denominator inflates without bound

`showInspectPanel` is not only called for real opens:

| case | signal | why it must be excluded |
| --- | --- | --- |
| **hover repaint** | `isRebuild = true`, **debounced 0.05 s** (`inspect_panel.lua:1235-1240`) | ~20 events/second of hovering. This alone would make Q2.5 meaningless |
| Back-button refresh | also `isRebuild = true` (`:1193`) | checks genuinely reappear; counting it double-counts one decision |
| dial-check **result** panel | `isRebuild = nil` but `data.result_header ~= nil` (`:268`) | `dial_check` rebuilds the full action list (`evidence_inspect.lua:2364-2365`), so remaining checks look freshly displayed |

The first is the dangerous one: it produces an enormous, plausible, entirely wrong number, with no
error and no missing rows — the failure mode this registry keeps recording.

**Questions it answers:** `10` **Q2.5** (is the bespoke failure prose ever read → where to spend
authoring bandwidth) and **Q3.2a**'s exposure denominator. Q2.5 is the inventory's only question
about where to spend *human effort* rather than where players struggle.

**Grain — one event per check displayed**, never per panel. Three checks on one panel = three
events. A panel-level event was explicitly rejected: most panels contain no check at all, so it
would fire constantly and answer nothing (*"events are justified by questions, not by
capturability"*).

**Dedupe policy: none at emit time.** Every panel open emits. Deduping here would destroy the
"kept coming back to this check" hesitation signal, and the decline rate can be deduped at query
time — raw values cannot be recovered, derived ones can always be recomputed.

**`data` shape:**

| Key | Type | Meaning |
| --- | --- | --- |
| `check_id` | string | same id space as `SkillCheckResolved.check_id`, so the two join |
| `display_group` | string | ⭐ groups checks shown **together**. See below — this is not optional |
| `threshold` | int | the value needed, raw |
| `skill` | string | the gated stat |
| `stat_type` | string | `skill` \| `attribute` |
| `threshold_met` | bool | ⚠️ **omit entirely if the panel cannot know it** — never default it to `false` |

### ⚠️ `display_group` is what keeps Q2.5 honest

Without it, a player who sees three checks and deliberately picks the one they can pass produces
**two declines** — indistinguishable from someone who saw one check and walked away:

| what happened | without `display_group` | with it |
| --- | --- | --- |
| saw 1, walked away | 1 decline | 1 decline, group size 1 |
| **saw 3, chose the passable one** | **2 declines** | 2 declines, group size 3 — *engaged well* |

Those are opposite findings, and the second is a player behaving exactly as designed. Since Q2.5
feeds a conversation about reallocating a writer's time, inflating it is the expensive failure.

---

## `ItemConsumed`

**Status:** ✅ **VERIFIED LIVE IN PROD 2026-07-28** (`b59eaa5`). First real row:
`{"item_id":"potion_skooma_01","item_type":"potion"}`, drunk between two `SkillCheckDisplayed`
events that flipped `threshold_met` false → true on the same gate. **The `onConsume` seam fired
from ordinary play**, which is what the `ItemUsage` analysis below predicted and what no amount of
code review could have established. **First-party** — emitted by our own platform PLAYER script
(`mod/scripts/omwanalytics/player.lua`), `mod_id = 'base'`.

**Questions it answers:** `10` **Q3.5** (do players reach for consumables to clear a stat gate) and
it supplies the behavioural half of **Q3.6** (is there an accessible remedy at all).

⭐ **Why this is NOT a CCFF event.** Drinking a potion is a **base-game mechanic**, agnostic to
which mod is watching — exactly like `AreaEntered`. Putting it in CCFF would scope a platform
capability inside one consumer and make it useless to every other mod. It also removes the
dependency on CCFF's instrumentation, which is still unverified in-game.

**Seam: the `onConsume(item)` engine handler**, on a PLAYER local script.

⚠️ **`ItemUsage` is the wrong seam and would have failed silently.** The obvious candidate —
`I.ItemUsage.addHandlerForType` — cannot intercept actions from mwscripts, from the AI (*"drinking
a potion in combat"*, per its own docs), or **from the quick-keys menu**, which is how players
actually drink potions mid-dialogue. An event built on it would look completely functional while
systematically missing the dominant path: fewer rows, no error, plausible numbers. `onConsume` sits
downstream of *why* the item was consumed and has no such hole.

**`data` shape — deliberately tiny:**

| Key | Type | Meaning |
| --- | --- | --- |
| `item_id` | string | the record id (`Potion.record(obj).id`) |
| `item_type` | string | `potion` \| `ingredient` |

⭐ **The payload carries no effects, on purpose.** `record_effects` (`11`) already holds every
magic effect for all 34,810 game records, so what the item *does* is a join, not a field. This is
the telemetry × corpus synthesis `10 §3.6` is built on, and it keeps the event at the coarsest
grain that still answers its question.

⚠️ **Two honest limits:** player-brewed alchemy potions have generated ids absent from the corpus,
and an item from another mod is absent unless that mod's `.esm` was ingested. Both degrade to
"unknown item" — a join miss, not an error.

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

---

## ✅ `ItemConsumed` — VERIFIED IN-GAME 2026-07-27

Three consumes, three events, nothing extra. Log lines confirmed in `openmw.log`:

| # | action | `item_id` | `item_type` | seq |
| --- | --- | --- | --- | --- |
| 1 | potion from inventory | `potion_skooma_01` | `potion` | 9 |
| 2 | ingredient | `food_kwama_egg_01` | `ingredient` | 10 |
| 3 | ⭐ potion from the **quick-keys hotkey** | `potion_skooma_01` | `potion` | 15 |

⭐ **Test 3 is the one that mattered, and it was chosen because it could not pass under the failure
we feared.** The rejected `ItemUsage` seam cannot observe quick-key usage; had we built on it, this
consume would have produced *nothing*, with no error. Firing here proves the seam choice
empirically rather than from documentation.

Also confirmed: `mod_id = 'base'` (platform attribution, not `ccff`), ids lowercase as documented,
`item_type` correctly separating `INGR` from `ALCH`, and exactly one event per consume.

### ⭐ The corpus join works — and immediately falsified a design decision

`lower(r.record_id) = item_id` against `game_records` + `record_effects`, first try:

| item | effects |
| --- | --- |
| `potion_skooma_01` (Skooma) | **Fortify Attribute `speed` +20 / 60 s** *and* **Drain Attribute `agility` −20 / 60 s** |
| `food_kwama_egg_01` (Small Kwama Egg) | Restore Fatigue — empty `affected`/`magnitude`, the documented `INGR` shape |

⚠️ **Skooma both helps and harms.** A check gated on **Agility** would have been reported as
*"no boost active"* by the morning's `activeEffects:getEffect(FortifyAttribute, 'agility')` design,
while the player was in fact **20 points worse** for having drunk it — a query returning nothing,
with nothing wrong. `.modifier` is signed and sees it. **A player self-sabotaging with a consumable
is a real finding for `10` Q3.5, and the shipped-that-morning design was blind to it.**

⚠️ **Doc `11 §6` said "Skooma has 3 effects"; the ingested corpus has 2.** Checked for systematic
truncation — records carry up to **8** effects with a natural distribution (1,627 × 1, 203 × 2,
62 × 3, 120 × 4, … 19 × 8) — so the parser is **not** dropping trailing effects. The doc's number
was most likely a casual pre-ingest illustration; corrected to the measured value. **Not fully
settled** — confirming Skooma's true count needs the 31 MB `esmtool` dump, which is not in the repo.
