---
description: Add a new telemetry event end to end — question, registry entry, emitter, lint, verify, read side. Usage: /add-event <EventName or a description of what to capture>
---

Add a new event to the OpenMW Analytics platform: "$ARGUMENTS".

This is a **design-first** workflow. Do not open by writing Lua. Each step gates the next.

---

## 1. Justify it — an event without a question does not get built

Read `design docs/10_ANALYTICS_QUESTIONS.md` and name the **question** this event answers, in the form: *decision the mod author needs to make → question → metric → this event*.

- If no question in `10` covers it, either add the question row first (with the decision it informs) or **stop and say the event isn't justified yet.** "Interesting to know" is not a decision.
- If the question is already answerable from events we already emit, **it is a query, not an event.** Say so. (`ConfrontationOpened` was cut on exactly these grounds — see `03`.)

## 2. Design the payload in `03_EVENT_REGISTRY.md` — before any code

Conventions (`02`): `type` is **PascalCase, noun + past-tense verb**; `data` keys are **snake_case**; caps are ≤32 keys / ≤2048 bytes.

Decide and write down:

- **Grain** — what exactly is one event? Fire at the coarsest grain that still answers the question.
- **Raw vs. derived** — store raw inputs, derive in SQL. *Precompute at write time only what you cannot reconstruct at read time.* (Margin is derived from `skill_value` + `threshold`; re-entries are kept because they can't be recovered.)
- **Fields that change how other fields are read** — e.g. `require` determines what a negative margin *means*. Such a field is mandatory, not optional metadata.
- **Anything deliberately NOT stored** — puzzle solutions, display text, derivable booleans. Write down why.

## 3. Find the seam

Prefer **one choke point** over many call sites — it captures future cases for free. Verify by reading the code, not by assuming:

- Does the site already **dedupe**? (Placing the emit after an existing early-return can give first-discovery grain for free.)
- Is it GLOBAL or PLAYER context? Both work; `core.sendGlobalEvent` is restricted only in *load* scripts and in menu scripts while the game isn't running.
- Can the site be reached when **nothing actually happened**? If so the emit needs a guard, or it invents rows. A phantom row is worse than a missing one — it looks real.
- Does the choke point actually *know* the fields you specced? Funnels are often context-poor: one site buys coverage and costs context.

## 4. Emit (third-party mods: obey `scripts/ccff/CLAUDE.md`)

Guarded require + `pcall` at every call site — telemetry must never break gameplay, and a bare `require` of an absent module **raises**:

```lua
local omwaTrack
do
    local ok, mod = pcall(require, 'scripts.omwanalytics.track')
    if ok then omwaTrack = mod end
end
-- ...
if omwaTrack then pcall(omwaTrack, 'EventName', { key = value }) end
```

⚠️ **Never send an empty Lua table as an array field.** `{}` and `[]` are the same value in Lua and the encoder emits `{}` — a JSON *object* — which breaks `jsonb_array_elements`. **Omit the key instead.**

## 5. Lint (no local Lua toolchain — use Docker)

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/Documents/My Games/OpenMW/data/dev-mods/<REPO>:/data" -w /data pipelinecomponents/luacheck luacheck scripts/ccff/<file>.lua
```

`MSYS_NO_PATHCONV=1` is required or Git Bash mangles the mount path. Record warning counts **before and after**; you must add none. For the OMWA repo add `--std lua51`.

Lint proves it parses. It cannot prove a guard is right — emits are `pcall`-wrapped, so logic errors are **silent**.

## 6. Verify in-game — run `/verify-pipeline`

State plainly what the test run must *do* in-game to exercise the new path, including any edge case (a fail as well as a pass, an unusual branch). An event that never fired is **untested, not verified** — do not mark it verified.

## 7. Read side

Add or extend a `/stats/*` endpoint. Aggregate in SQL; never ship raw rows.

⚠️ **Adding an event type is a change to every sequence query.** `LEAD`-based views are coupled to the *set* of types in the stream — a new type with no `CASE` branch falls into `other` and may be silently dropped. Review `api/src/stats/friction.ts` whenever the registry grows (`07 §4c`).

Verify SQL against **seeded synthetic rows in a transaction**, then `rollback` — never leave test rows in the events table:

```sql
begin;
insert into events (session_id, seq, install_id, type, v, ts, data) values (...);
-- run the query
rollback;
```

## 8. Update the docs and report

- `03` — status, and any discrepancy between the design and what the code actually allowed.
- `10` — flip the question's "have it today?" cell.
- `07` — if a view or endpoint changed.

Report: files changed, what was verified **and how**, what is still unexercised, and any assumption that turned out false.
