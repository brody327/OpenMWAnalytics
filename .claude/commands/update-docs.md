---
description: End-of-session documentation update for OpenMW Analytics — targeted updates to the design docs affected by what actually changed.
---

End-of-session documentation update for the OpenMW Analytics platform.

Run `git log --oneline -10` and `git diff HEAD --stat` to see what changed this session (add `git diff HEAD~N..HEAD` if the work spans commits). Then read **only** the docs the change map says are affected and make targeted updates.

Do not update docs unaffected by this session's changes. Do not rewrite a doc wholesale when a paragraph will do.

---

## Doc map — which changes affect which docs

| If this changed… | Update these |
| --- | --- |
| A new event `type` or payload field | `03_EVENT_REGISTRY.md`, and the question's row in `10_ANALYTICS_QUESTIONS.md` |
| A new dashboard question or module | `10_ANALYTICS_QUESTIONS.md` (question rows + the gap ranking in §5) |
| `api/src/stats/*` — a query or endpoint | `07_DASHBOARD.md` |
| `dashboard/` — a view, chart, or degradation behaviour | `07_DASHBOARD.md` |
| `api/src/events/*`, Zod schema, validation | `05_API_DESIGN.md` |
| Schema, indexes, upsert behaviour | `06_DATA_MODEL.md` |
| `shipper/ship.mjs` — offset, truncation, retry | `04_SHIPPER_DESIGN.md` |
| `mod/scripts/omwanalytics/*.lua` — emitter, SDK, validation | `08_INSTRUMENTATION.md` (+ `03` if the wire contract moved) |
| Instrumentation added to a **third-party** mod | `03_EVENT_REGISTRY.md`, `08_INSTRUMENTATION.md`, and that mod's own `CLAUDE.md` |
| Hosting, k8s, DNS/TLS, CI | `09_DEPLOYMENT.md` |
| Anything that changes the end-to-end picture | `01_ARCHITECTURE_OVERVIEW.md`, `00_README_INDEX.md` status table |

## Rules

1. **Record a decision where it belongs first**, then reflect impacts elsewhere. Don't duplicate the reasoning — cross-reference it.
2. **Only write down decisions that were actually made.** Design docs are the source of truth, not a scratchpad for options considered.
3. **Never upgrade a status you did not witness.** "Emitted" ≠ "verified live". An event that never fired during a test run is *untested*, not working. Say which.
4. **Record what broke and why**, not just what shipped. The gotchas (`07 §4c`, the jsonb empty-array trap, the shipper's EOF start) are the highest-value content in these docs — they are what stops the next session re-deriving them.
5. If an implementation detail conflicts with a doc, **do not silently pick a new answer**: preserve the documented design, make the smallest adjustment, and flag the ambiguity.

## Also consider updating

- **`00_README_INDEX.md`** — the status column and "Next candidates" list, if the roadmap moved.
- **Memory** (`MEMORY.md` + the memory dir) — for facts that must survive into a future session: verification state, decisions with their reasoning, and pending work. Prefer updating an existing memory file over adding a near-duplicate.
- **`LEARNING_LOG.md`** — concepts taught or quizzed this session.

## Report

List each doc touched and the one-line reason. Explicitly name anything left **unverified or unexercised**, so the next session starts with an accurate picture rather than an optimistic one.
