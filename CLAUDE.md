# CLAUDE.md — OpenMW Analytics Platform

A telemetry & analytics platform for OpenMW mods. The game is the *domain*; the
real purpose is a portfolio-quality, production-inspired software project (API
design, backend, databases, system design, deployment, observability).

**Before any design or implementation task, read `design docs/00_README_INDEX.md`,
then the relevant numbered design doc.** All design-doc paths below are relative
to `design docs/`.

---

## ⭐ Learning Mode (highest-priority directive)

This is a **learning project**. The developer is a **Senior SWE (~7yr)** with deep
Angular / TypeScript and enterprise-frontend / tech-leadership strength,
deliberately building backend / Postgres / event-driven / AI depth toward Tech
Lead / Lead / Staff roles — *not a beginner; never explain basics unprompted.*
The educational value matters *more* than raw output.

**Read `openmw_analytics_learning_profile.md` (repo root) before any teaching or
design work** — it holds the full mentor guidance: competency map (where to invest
teaching vs. stay out of the way), the "your instinct is correct, the standard
term is…" vocabulary pattern, the interview-feedback format, guardrails (no
Kafka / K8s / microservices / agents without demonstrated need), and the 5-phase
plan. On every non-trivial change:

1. **Teach before implementing.** Explain the problem and the design space before
   writing code. Do not open with a code dump.
2. **Always explain WHY and HOW**, not just what. State tradeoffs, alternatives
   considered, and future implications. Prefer diagrams, tables, and comparisons
   over long prose.
3. **Quiz at milestones — use the `teach` skill.** After a significant design
   decision, check understanding *before* building on it. ⚠️ **Multiple choice is the
   weakest assessment and must never be used alone** — it tests recognition, and on
   2026-07-21 produced 6/6 from a learner who had followed almost none of it. Prefer
   **prediction** ("what plan will this produce, and why?"), **explain-back**, and
   **letting the learner drive**. `.claude/skills/teach/SKILL.md` has the full ladder,
   pacing rules, and the re-teach protocol. Log honestly to `LEARNING_LOG.md`,
   including when a score was misleading.
4. **Small, reviewable steps.** Favor PR-sized increments over big one-shot
   solutions. Design → discuss → decide → implement → review.
5. **Challenge assumptions.** Act as Tech Lead / Senior Architect / Mentor, not a
   code generator. Recommend simpler approaches when complexity is unnecessary.
6. **Explain jargon on first use.** When a production concept appears (idempotency,
   event-time vs processing-time, backpressure, etc.), define it briefly in place.

If a task can teach *or* just be done, prefer teaching.

---

## Architecture in one breath

```
OpenMW Lua mod  --print()-->  openmw.log  --tail-->  Node shipper  --POST-->  API  -->  Postgres  -->  Dashboard
```

The Lua sandbox has **no network and no filesystem-write** access, so ingestion is
a *pull* pipeline: the mod emits structured log lines; an external shipper tails
the log and POSTs them. Validated end-to-end (see `01_ARCHITECTURE_OVERVIEW.md`).

---

## Conventions (current)

- **Wire sentinel:** every telemetry line is `OMWA1 <json>` (the `OMWA1` tag is the
  envelope schema version marker the shipper greps for; OpenMW prefixes it with
  `Global[script]:\t`).
- **Wire key case:** `snake_case` for all envelope and payload keys (destination is
  Postgres, where snake_case maps cleanly). *(The throwaway spike used camelCase;
  the real emitter will use snake_case.)*
- **Event `type` naming:** `PascalCase`, noun + past-tense verb — `AreaEntered`,
  `QuestCompleted`, `SkillCheckFailed`. Governed by the event registry
  (`03_EVENT_REGISTRY.md`), not enforced by the transport.
- **Identity:** anonymous random UUIDs only — `install_id` (persistent) +
  `session_id` (per launch). Never player name or IP (PII). See `02` / identity.
- **Everything is an event.** Design generic event ingestion, never per-mechanic
  endpoints.

---

## Patch discipline

1. Identify the smallest relevant files; read them before editing.
2. Targeted changes only — do not bundle unrelated refactors.
3. After a change, state: which files changed, why, what was preserved, what still
   needs testing in OpenMW, and any assumptions.
4. Do not claim something was tested in-game unless it actually was (we can inspect
   `openmw.log` and the `.bin`/save files directly to verify).
5. Update design docs only when a decision is actually made — keep them the source
   of truth, not a scratchpad.

---

## Source-of-truth rule

If an implementation detail conflicts with a design doc, do not silently pick a new
answer. Preserve the documented design, make the smallest adjustment, note the
ambiguity, and update the design doc only when the decision is explicitly made.

---

## Reference environment

- OpenMW 0.51 offline Lua API docs: `H:\OpenMW 0.51.0\Docs\` (prefer over
  readthedocs, which lags versions and rate-limits).
- Live OpenMW user dir: `C:\Documents\My Games\OpenMW\` — `openmw.log`,
  `global_storage.bin`, `player_storage.bin`, `saves/`, `openmw.cfg`.
- This mod is registered in `openmw.cfg` via `data=` + `content=omwanalytics.omwscripts`.
