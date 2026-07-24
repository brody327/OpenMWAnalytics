# 08 — Instrumentation Model (how mechanics become events)

**Status:** 🟢 model decided; public SDK **built 2026-07-18** (single validated
`OMWA_Track` ingress + require-able `track.lua` helper; first consumer = CCFF's
`ConfrontationAttempted`). This doc records *how* a game/mod mechanic gets turned
into an `AreaEntered`-style event, and the "mod vs platform" decision it implies.
See §5 for the shipped SDK; §3's raw-`sendGlobalEvent` example is now superseded by
the helper but kept for the underlying-mechanism explanation.

---

## 1. The hard constraint: sandbox isolation

OpenMW runs **every script in a separate sandbox** with no access to the OS *and no
access to other scripts' internals*. There is **no monkey-patching**: you cannot
reach into another mod's script to wrap a function or read a variable. This is
deliberate (the API is designed to be multiplayer-compatible: global = server,
local = client). Everything below follows from this one fact.

---

## 2. Two kinds of instrumentation

> **Auto-instrumentation** — observe a mechanic from the *outside* through hooks the
> engine already exposes. No cooperation from the observed code.
> **Manual instrumentation** — the code itself calls a `track()`-style API to report
> what it's doing. Requires a code change in the thing being measured.

OpenMW supports both, for different targets:

| Mechanic | Passive capture? | Mechanism |
| --- | --- | --- |
| **Built-in engine concepts** — skill use, combat, death, item use, activation, crime, dialogue lines, cell/teleport | ✅ no cooperation needed | Engine handlers (`onDied`, `onActivated`, `onConsume`, `onTeleported`, …) + built-in **interfaces** (`SkillProgression`, `Combat`, `Crimes`, `Activation`, `ItemUsage`) |
| **A mod's own custom logic** — puzzle state machines, bespoke accusation minigames, custom skill-check rolls | ❌ opaque from outside (sandbox) | The mod must **emit to us**, or expose an interface we consume |

Worked examples:
- **Skill checks** — engine skill system → `I.SkillProgression.addSkillUsedHandler` /
  `addSkillLevelUpHandler` (fully observable, no other mod needed). A quest mod's
  custom dice roll → opaque → must emit.
- **Confrontations / accusations** — *partial* passively via the `Crimes` interface +
  the `DialogueResponse` event (fires on specific greeting/topic/voice lines). A
  mod's **custom** accusation UI → opaque → must emit.
- **Puzzles** — no engine concept of "puzzle" → almost always custom → **must emit**.

---

## 3. The seam already exists: `OMWA_Emit`

The player→global forwarding built for `AreaEntered` (`03`) is exactly the
manual-instrumentation entry point. Any script — ours or a third party's — reports a
mechanic with one line:

```lua
core.sendGlobalEvent('OMWA_Emit', { type = 'PuzzleSolved', data = { id = 'blue_door' } })
```

The global emitter (`telemetry.lua`) owns identity + the per-session `seq` stream, so
callers get correct envelopes for free. We built the pipe a platform needs before we
needed it.

---

## 4. Where the tracking code lives (the "shift" this raises)

Only the **custom third-party** case forces code out of our mod:

| Target | Tracking code lives in | OMWA is… |
| --- | --- | --- |
| Built-in mechanics | **our mod** — observer scripts auto-attached via omwscripts flags (`PLAYER`, `NPC`, `CREATURE`, `CUSTOM`) that subscribe to engine hooks/interfaces and forward via `OMWA_Emit` | self-contained mod |
| Another mod, *if its mechanic surfaces through engine events/interfaces/dialogue* | **our mod**, as a mod-specific **adapter** script | self-contained mod |
| Another mod's **pure-internal** custom logic | **inside that mod** — author adds our `track()` call | a **platform / SDK** others integrate with |

That last row is the graduation from *"a mod"* to *"a telemetry platform other mods
depend on"* — "build platforms, not features" at ecosystem scale.

---

## 5. Decision & sequencing

**Decided + shipped (2026-07-18):** once CCFF became a real third-party consumer
(`ConfrontationAttempted`, `03`), the deferred SDK was extracted *from* that working
integration rather than designed ahead of it. Delivered:
1. **`OMWA_Track`** is the single public wire event; the old internal `OMWA_Emit` is
   **retired** — first-party events (`AreaEntered`) go through the same path, so
   there is one ingress and one trust policy, nothing unvalidated.
2. **`scripts/omwanalytics/track.lua`** — a `require`-able helper exposing
   `track(type, data)` that wraps the `sendGlobalEvent`. It stays an *event* (not an
   openmw `interface`) because interfaces don't cross the local↔global script-context
   boundary that instrumentation→collector must. Third parties **guard the require**
   (`pcall(require, …)`) so an absent analytics mod is a no-op, not a load error.
3. **Trust boundary at the emitter:** `telemetry.lua` re-validates every `OMWA_Track`
   event (type is a non-empty string; `data` is a JSON-encodable table; caps:
   ≤32 keys, ≤2048 serialized bytes) and **drops + logs** violations without
   consuming `seq`. The helper runs in the caller's untrusted context, so its
   client-side check is DX only — enforcement lives here, where identity/`seq`
   already centralize.
4. `03_EVENT_REGISTRY.md` is now the **public tracking plan / contract**, not a
   private nicety.

**Still open (auto path):** a `SkillProgression`-based skill event (`SkillCheckFailed`
/ skill-use) to exercise **passive/auto** instrumentation with a real engine hook —
zero other-mod cooperation. Everything shipped so far is the *manual* path.

---

## 6. Open questions (deferred)
- Interface vs. event for the public API (versioned `interface` table vs. a global
  event) — events are looser/decoupled; interfaces are versioned + discoverable.
- Payload size/quota policy per emitting mod (abuse / runaway loops).
- How a third-party mod declares its event types into the registry (self-describing
  vs. curated).

---

## 7. The SDK is now a factory — mods declare their id (2026-07-23)

⚠️ **Breaking change to the public SDK surface.**

```lua
-- before
local track = require('scripts.omwanalytics.track')
-- after
local track = require('scripts.omwanalytics.track')('ccff')
```

`track.lua` no longer *is* the tracker; it *returns* one, bound to the calling mod's id. The id
names the **content domain** the events describe (`02 §2a`) — which is why this project's own
`player.lua` passes `'base'`, not a mod name: it emits about unmodded engine behaviour and
authors no content.

### Why declared, and not derived — verified, not assumed

Two candidate automatic mechanisms, both closed:

1. **Log attribution fails.** Every mod funnels through one global emitter, so the line is always
   `Global[scripts/omwanalytics/telemetry.lua]`. The prefix identifies who called `print()`, not
   who caused the event.
2. **Caller introspection is impossible.** OpenMW's sandbox allows only `coroutine, math, string,
   table, os` — there is **no `debug` library**, so `debug.getinfo` does not exist.

Declaration is the only mechanism available. This is a constraint, not a preference.

### Why bound at `require`, not passed per call

A per-call id must be repeated at every call site (CCFF has eight), and one missed argument
silently mislabels a slice of the data — a bug that surfaces months later as a chart that is
quietly wrong. Bound once, forgetting it is a **load-time error**. This is the "client instance"
pattern every analytics SDK uses.

### Why a hard break rather than a backward-compatible overload

`track('ccff')` and `track('MyEvent')` are both a single string argument, with nothing to
distinguish a mod id from an event name. **An API where two meanings share one signature cannot
be disambiguated by documentation** — so a clean break was the honest option.

### Trust and validation

Self-declared and **unverified**, exactly like `env`. A mod may claim any id. Format is validated
(`[a-z0-9][a-z0-9._-]`, ≤64 chars, lowercased/trimmed) at *both* the Lua emitter and the API,
because the emitter runs in another author's untrusted context. A malformed id normalises to
`'unknown'` rather than dropping the event.

The factory itself **errors** on a missing id, unlike everything else here, which degrades
quietly. That asymmetry is deliberate: a bad id is a mistake made once at load by the author who
can fix it immediately, so a hard error is cheap and unmissable. A bad *event* happens at runtime
in a player's game, where crashing a session over telemetry would be indefensible.

### Consumers updated

`player.lua` → `'base'`; CCFF's four guarded requires (`confront_panel`, `evidence_bridge`,
`evidence_inspect`, `evidence_player`) → `'ccff'`.

⚠️ **NOT YET VERIFIED IN-GAME.** This change sits on the emit path for *every* event, so if it is
wrong all telemetry stops silently. One launch plus a confrontation attempt verifies it
(`/verify-pipeline`). Luacheck passes with 0 errors, which proves syntax, not behaviour.
