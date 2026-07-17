# 08 — Instrumentation Model (how mechanics become events)

**Status:** 🟡 model decided; public SDK **deferred** (YAGNI — one consumer today).
This doc records *how* a game/mod mechanic gets turned into an `AreaEntered`-style
event, and the "mod vs platform" decision it implies. No implementation beyond the
existing seam is committed here.

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

**Decided now:**
- The instrumentation model above (auto for built-in, cooperative-emit for custom).
- Keep `OMWA_Emit` as the **internal seam**; do **not** publish a public SDK yet
  (one consumer = us; premature generalization).
- The next event should exercise the **auto path**: a skill event via
  `SkillProgression` (`SkillCheckFailed` / skill-use) — a real sanctioned hook,
  zero other-mod cooperation, answers a genuine question. (Candidate for `03`.)

**Deferred until a real third-party consumer exists:** promote the seam to a public
contract —
1. Rename/alias `OMWA_Emit` → a stable public event (e.g. `OMWA_Track`) + ship a
   `require`-able helper `scripts/omwanalytics/track.lua` exposing `track(type, data)`.
2. `03_EVENT_REGISTRY.md` becomes a **public tracking plan** (governance = API
   contract, not a nicety).
3. **Trust boundary:** third-party payloads are semi-untrusted → validate at the
   emitter (type is string; cap `data` size / key count; drop garbage). Ties to the
   data-quality concerns in the learning profile. The emitter already centralizes
   identity/`seq`, so that stays clean.

---

## 6. Open questions (deferred)
- Interface vs. event for the public API (versioned `interface` table vs. a global
  event) — events are looser/decoupled; interfaces are versioned + discoverable.
- Payload size/quota policy per emitting mod (abuse / runaway loops).
- How a third-party mod declares its event types into the registry (self-describing
  vs. curated).
