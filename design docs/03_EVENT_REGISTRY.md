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
