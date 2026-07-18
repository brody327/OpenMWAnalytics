# 03 — Event Registry (the tracking plan)

**Status:** 🟡 in progress. First real event defined (`AreaEntered`).

This is the **governed vocabulary** half of the "generic transport, governed
vocabulary" split (`02 §6`). The transport accepts *any* `type`; this doc decides
which `type`s are *canonical*, what their `data` means, and when they fire. It is
the analytics equivalent of a **tracking plan**: the contract between the emitter
(mod) and every consumer (dashboard queries). Adding an entry here is a product +
schema decision, **not** a pipeline code change.

## Conventions (recap of `02`)

- **`type`**: `PascalCase`, noun + past-tense verb (`AreaEntered`, `QuestCompleted`).
- **`data` keys**: `snake_case`; keep the shape tight; **consumers ignore unknown
  fields**, so new fields are added *additively*. An incompatible reshape means a
  new `type` (e.g. `AreaEntered2`), never a silent change of meaning.
- **Grain discipline**: an event should fire at the coarsest grain that still
  answers its question. High-frequency, low-information events are a **cardinality**
  problem — they bloat storage and drown signal. Pick the grain deliberately.

---

## System events (not product telemetry)

These exist to prove the pipeline is alive; they answer no product question and
will be retired / reshaped once real events cover liveness.

| `type` | Fires | `data` | Purpose |
| --- | --- | --- | --- |
| `SpikeStarted` | once per script-context start | `{ note }` | liveness marker (legacy spike) |
| `Heartbeat` | every 5s | `{}` | live-stream visibility during dev |

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
change it `sendGlobalEvent('OMWA_Emit', …)` to the global emitter, which assigns the
`seq`/identity envelope. Polling (not `onTeleported`) is required because seamless
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
calls `core.sendGlobalEvent('OMWA_Emit', { type = 'ConfrontationAttempted', data =
… })`. The global event crosses the mod boundary through OpenMW's shared global-event
namespace and lands in our `telemetry.lua`, which assigns the identity + `seq`
envelope. If OMWA is not installed the event is simply unhandled (fire-and-forget).

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
- This event's existence — a *foreign* mod writing tracking calls into its own
  source — is the trigger to revisit the deferred public SDK in `08 §5` (rename
  `OMWA_Emit` → a stable `OMWA_Track`, ship a `track.lua` helper, add emitter-side
  payload validation for the semi-trusted caller). Deliberately **not** done yet:
  extract the SDK *from* this working integration, don't design it ahead of one.
