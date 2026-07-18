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
