# 02 — The Event Envelope

**Status:** 🟡 in design. This is the single most important contract in the whole
platform: the shape of one telemetry event. Every downstream component — shipper,
API, database, dashboard — depends on it. Get it right and adding a new event type
later is a one-line change; get it wrong and we migrate a schema through five
components.

---

## 1. The core idea: Envelope vs. Payload

The central structural decision is to split every event into two layers:

- **Envelope** — *universal* metadata present on **every** event, regardless of
  type. The pipeline (shipper, API, DB indexes) operates on these fields without
  knowing what the event *means*.
- **Payload** (`data`) — the *event-type-specific* body. Its shape depends on
  `type` and is documented per-type in `03_EVENT_REGISTRY.md`.

```json
{
  "v": 1,                          ┐
  "type": "AreaEntered",           │
  "seq": 42,                       │  ENVELOPE  (universal — the pipeline reads these)
  "install_id": "e2a9…",           │
  "session_id": "1f5a…",           │
  "ts": 1752521538000,             ┘
  "data": { "cell": "Balmora", "region": "West Gash" }   ← PAYLOAD (type-specific)
}
```

**Why split?** It's the "build platforms, not features" principle in concrete form.
The API can validate, store, and index *any* event by reading only the envelope. It
never needs a branch per event type. Adding `SkillCheckFailed` tomorrow requires
**zero** pipeline changes — only a registry entry. The generic layer stays stable;
the variety lives in `data`.

**How the layers map downstream:** envelope fields become **columns** in Postgres
(indexed, queried, joined); `data` becomes a single **JSONB column** (flexible,
queried with `->`). More in `06_DATA_MODEL.md`.

---

## 2. Envelope fields (v1 proposal)

| Field | Type | Meaning | Why it's here |
| --- | --- | --- | --- |
| `v` | int | Envelope schema version | Lets us evolve the *envelope itself* safely (see §5). Also the `OMWA1` wire tag encodes it. |
| `type` | string | Event discriminator, `PascalCase` | The one field that decides what `data` means. |
| `seq` | int | Per-session monotonic counter (1,2,3…) | Ordering **and** gap detection **and** dedup key (see §4). |
| `install_id` | uuid | Anonymous install identity (persistent) | "How many distinct players?" |
| `session_id` | uuid | Anonymous per-launch identity | Sessions, funnels, abandonment. |
| `ts` | int | **Event time**: epoch **milliseconds** when it occurred, game-side | "When did the player do this?" (see §3). |
| `mod_id` | string? | Which mod's **content** this event is about; `base` = unmodded engine behaviour | Makes the platform multi-mod: per-mod views, filters, and the future tenancy boundary (see §2a). |
| `data` | object | Event-specific payload | The variety. |

### 2a. `mod_id` — the content domain (added 2026-07-23)

**Semantics: what the event is _about_, not what emitted it.** `AreaEntered` is emitted by our
own `player.lua` but describes unmodded engine behaviour, so it is **`base`** — there is no
`omwanalytics` mod id, because this project authors no content. `base` is deliberately *just
another id*, not a special case, so per-mod pages, filters and any future tenancy rule work
uniformly with zero branching.

**Why it is per-event, unlike `env`.** `env` is a per-batch header because the *shipper* knows
it. `mod_id` cannot be: one `openmw.log` interleaves events from every installed mod, so only
the emitter knows the origin of a given line.

**Why it must be DECLARED, not derived** — verified, not assumed:

- The log prefix is always `Global[scripts/omwanalytics/telemetry.lua]`, because every mod
  funnels through one global emitter. It identifies who called `print()`, not who caused it.
- OpenMW's Lua sandbox allows only `coroutine, math, string, table, os` — **no `debug`
  library**, so `track.lua` cannot introspect its caller.

There is no automatic mechanism. The mod states its id **once**, when it requires the SDK
(`require('scripts.omwanalytics.track')('ccff')`) — bound at require rather than passed per
call, so a missed argument is a load-time error instead of a silently mislabelled slice of data.

**Trust: self-declared and unverified**, exactly like `env`. A mod may claim any id; we validate
the *format* (`[a-z0-9][a-z0-9._-]{0,63}`, lowercased/trimmed) and nothing more.

**Optional on the wire, so `v` stays 1.** An older emitter that omits it still validates. `v`
marks **breaking** envelope changes; an additive optional field is not one. A missing or
malformed id normalises to `unknown` rather than 400-ing the batch — the id is metadata, and
losing real telemetry over a bad label is the worse failure (the same posture as `env`
defaulting to `prod`).

⚠️ **Known seam.** This is the *emitting* domain. `AreaEntered` fires inside cells that belong
to other mods — "Fastus Retreat" is CCFF content — so a `base` row can describe a modded
location. Correct cell→mod attribution needs a content manifest (doc 10); deferred, not solved.

The **shipper adds one field at the edge**, not present on the wire:

| Field | Added by | Meaning |
| --- | --- | --- |
| `received_at` | shipper | **Ingest time**: epoch ms when the shipper read the line. |

### Why identity on *every* event (not once per session)?
Repeating `install_id`/`session_id` on each line is redundant bytes. The
alternative — send identity once in a `SessionStarted` event and join server-side —
saves bytes but makes every event **depend** on a prior event surviving. Given
at-least-once delivery, log truncation, and dropped lines, **self-contained events
are far more robust**, and a few dozen bytes in a text log is free. We stamp
identity on every event for MVP; normalizing it away is a possible later
optimization, not a starting design.

---

## 3. The time problem (event-time vs. processing-time)

This is a genuine distributed-systems concept and it shows up immediately here.

The obvious clock, `core.getRealTime()`, returns **seconds since the game process
started** — a monotonic float (we saw `366130.41` in the spike). It is *great* for
ordering and durations **within a session**, but it is **not wall-clock**: you
cannot say "this happened on July 14 at 4:32pm" from it. The dashboard needs real
calendar time ("events per day", "when did sessions happen").

Fortunately the sandbox allows `os.time()` (part of the permitted `os` subset), so
the **mod can read real wall-clock epoch time**. So we capture two distinct times —
a standard pattern in real telemetry (Segment, Snowplow, Kafka/Flink):

| Time | Field | Whose clock | Answers |
| --- | --- | --- | --- |
| **Event time** (occurredAt) | `ts` | the game, at emit | *When did the player action happen?* |
| **Processing time** (ingestAt) | `received_at` | the shipper, at read | *When did we receive it?* |

**Why keep both?** Because they diverge, and the gap is *information*:
- Offline/buffered play, clock skew, and a paused game all make `ts` and
  `received_at` differ.
- `received_at − ts` = **event lateness**, an observability signal (how stale is our
  data? did a batch sit in the log for an hour?).
- Analytics ("what did players do on Tuesday") must use **event time**; pipeline
  health ("throughput, lag") uses **processing time**. Mixing them is a classic
  data-eng bug.

**Ordering note:** we deliberately do **not** order by `ts`. `os.time()` is
1-second resolution, so many events share a timestamp; and wall clocks can jump
backward (NTP, DST). Intra-session ordering uses **`seq`** (§4). `ts` is for
calendar placement, not sort order.

*(Deferred: a fractional `mono` field from `getRealTime()` for sub-second durations.
Not needed for MVP; `seq` + `ts` cover ordering and day-grain analytics.)*

---

## 4. Delivery & ordering contract

Because `print()` is fire-and-forget and the shipper can crash and re-read, the
pipeline is **at-least-once**: an event may be delivered **more than once**, never
zero times (assuming the log survives).

Consequences the whole system must honor:

- **Dedup key = `(session_id, seq)`.** This composite uniquely identifies an event
  within an install's session. The DB enforces it (unique constraint / upsert), so
  a re-sent line is harmless. *We deliberately do not mint a per-event UUID:*
  `(session_id, seq)` already gives us identity **and** ordering **and** gap
  detection, without leaning on the sandbox's weak RNG for uniqueness.
- **Ordering:** within a session, `ORDER BY seq`. Across sessions, `ORDER BY ts`.
- **Gap detection:** a missing `seq` inside a session ⇒ an event was dropped
  (`print` lost, log rotated mid-write). That's a measurable data-quality signal,
  not a silent hole. Free, because `seq` is dense.

> **Jargon:** *idempotency* — processing the same event twice has the same effect as
> once. Our upsert-on-`(session_id, seq)` makes ingestion idempotent, which is what
> makes at-least-once delivery safe.

---

## 5. Versioning strategy

- **`v` = envelope version.** Bump on a breaking change to envelope *structure*
  (rename/remove a field, change a meaning). The wire tag `OMWA1` carries it too, so
  a consumer can route by version before parsing. Additive fields (new optional
  envelope field) do **not** require a bump.
- **Payload versioning lives in the registry.** Each event `type`'s `data` shape is
  documented in `03_EVENT_REGISTRY.md`. If one event's payload must change
  incompatibly, we either add a field additively or introduce a new `type`
  (e.g. `AreaEntered` → `AreaEntered2`) rather than silently reshaping `data`.
- **Golden rule:** consumers **ignore unknown fields**. That single rule makes most
  changes additive and non-breaking.

---

## 6. Event `type` taxonomy: generic transport, governed vocabulary

A real tension: the brief demands *generic ingestion* ("never a hardcoded
SkillCheck endpoint"), but the dashboard demands *clean, consistent* data to answer
questions.

Resolution — decouple the two layers:

- **Transport is permissive.** The envelope does not constrain `type`; the API
  accepts any string. Adding an event type never touches pipeline code. (Generic.)
- **Design is governed.** We maintain an **event registry** (`03`) — the analytics
  equivalent of a *tracking plan* — defining canonical names + payload shapes, plus
  a naming convention: **`PascalCase`, noun + past-tense verb** (`AreaEntered`,
  `QuestCompleted`, `SkillCheckFailed`). (Clean.)

Best of both: the platform stays open, the data stays disciplined.

---

## 7. Wire format & key case

- Every line: `OMWA1 <compact-json>` (one event per line; the shipper matches the
  `OMWA1 ` marker).
- **`snake_case`** for all keys. Rationale: the destination is Postgres, where
  unquoted identifiers fold to lowercase, so `snake_case` maps to columns without
  quoting friction; it's also unambiguous across the Lua→JS→SQL boundary. *(The
  throwaway spike used camelCase; the real emitter aligns to snake_case.)*

---

## 8. Canonical v1 example

On the wire (one log line):
```
OMWA1 {"v":1,"type":"AreaEntered","seq":42,"install_id":"e2a9cd3e-…","session_id":"1f5afde8-…","ts":1752521538000,"data":{"cell":"Balmora, Guild of Mages","region":"West Gash","interior":true}}
```

After the shipper (what the API receives):
```json
{
  "v": 1,
  "type": "AreaEntered",
  "seq": 42,
  "install_id": "e2a9cd3e-5f67-4911-88c4-b71f15ad1a33",
  "session_id": "1f5afde8-3968-41c2-b820-895743e5da35",
  "ts": 1752521538000,
  "received_at": 1752521539117,
  "data": { "cell": "Balmora, Guild of Mages", "region": "West Gash", "interior": true }
}
```

---

## 9. Open decisions (to settle together)

1. **`ts` precision** — epoch **ms** (as proposed, sub-second via padding) vs plain
   epoch **seconds**. `os.time()` is second-resolution; ms is forward-looking but
   partly synthetic. *Leaning: ms, stored as int.*
2. **Batch envelope** — should the shipper POST events **one per request** or as a
   **batch array** with a small batch header? (Efficiency vs simplicity.) Likely
   batch; details belong to `04_SHIPPER_DESIGN.md`.
3. **`data` size cap** — do we bound payload size / key count at emit time to keep
   log lines sane? *Leaning: soft cap, documented in the registry.*

---

## 10. Check your understanding

See the checkpoint quiz (posed interactively after this doc). Results logged in
`LEARNING_LOG.md`. Key concepts to retain: envelope/payload split, event-time vs
processing-time, why `(session_id, seq)` is the dedup key, at-least-once +
idempotency, generic transport vs governed vocabulary.
