# CLAUDE.md — OpenMW Analytics Platform

A telemetry & analytics platform for OpenMW mods. The game is the *domain*; the
real purpose is a portfolio-quality, production-inspired software project (API
design, backend, databases, system design, deployment, observability).

**Before any design or implementation task, read `design docs/00_README_INDEX.md`,
then the relevant numbered design doc.** All design-doc paths below are relative
to `design docs/`.

---

## ⭐ Working agreement (highest-priority directive)

Agents on this repo are held to the same bar as a senior engineer opening a PR.
Output that merely runs is not the goal; output that can be *defended* is.

1. **Design before code.** State the problem and the design space first. Name the
   alternatives considered and why they were rejected — a decision without a
   discarded alternative has not been made, only arrived at.
2. **Explain WHY, not just what.** Tradeoffs and future implications belong in the
   comment or the design doc, next to the thing they justify. Prefer tables and
   comparisons over prose.
3. **Small, reviewable increments.** Design → discuss → decide → implement →
   verify. Not one large drop.
4. **Challenge the request.** Recommend the simpler approach when the complex one
   is not earned. **No new infrastructure or dependency without demonstrated
   need** — specifically no Kafka, no microservices, and no agent frameworks
   because they are fashionable.
5. ⭐ **A check is only worth what it can detect.** Before trusting any green
   check, ask: *would this also pass if the thing were broken?* If yes, it is
   decoration — find an observation the failure is structurally incapable of
   producing. This rule exists because nearly every serious defect in this
   project was hidden behind a check that could not fail (`09 §10`, `11 §12`).
6. **Measure before asserting.** Numbers in docs and comments are measurements,
   not estimates. If a figure cannot be produced on demand, do not write it down.
7. **Report faithfully.** If something is untested, say so. Never claim in-game
   verification that did not happen — `openmw.log`, the save files and the
   database can all be inspected directly.

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

## Secrets — never read them, and prefer not to have them here

Twice (2026-07-25, 2026-07-28) an agent grepped a secrets file for one value and
printed *live credentials* into the session transcript. The only control in place
was "the agent chooses not to", which is not a control. There are now three layers,
weakest last:

1. **Nothing that isn't consumed should live in the repo tree.** A file that isn't
   here cannot be read by a future recursive sweep.
2. **Enforcement** — `.claude/settings.json` denies the read tools on `aws.txt`,
   `**/.env`, `**/*.pem`, `**/*.key`; the `PreToolUse` hook
   `.claude/hooks/deny-secret-reads.mjs` blocks *shell* commands that would print
   them. Tests: `node .claude/hooks/deny-secret-reads.test.mjs`.
3. **This rule.** It is the layer that already failed twice. Treat it as the *why*,
   not the guard.

The hook deliberately allows **passing a protected path to a program that consumes
it** (`ssh -i omwa-key.pem`, `--env-file api/.env`) and blocks only printing its
contents. A guard that breaks the documented prod-access workflow gets switched off.

▶ **To get the prod `DATABASE_URL`, read the k8s secret — never a local file:**
`ssh -i omwa-key.pem ubuntu@<eip> "sudo kubectl get secret omwa-api-secrets -o jsonpath='{.data.DATABASE_URL}' | base64 -d"`.
Print only host/port/db/user. `DATABASE_SSL=true` is required against RDS.

---

## Production, in one line

**AWS `us-east-2` (Ohio)** · EC2 + k3s at elastic IP **`<eip>`** · RDS Postgres ·
`api.omwanalytics.com` (API) / `omwanalytics.com` (dashboard) · `sudo kubectl` on the box (k3s.yaml
is root-only) · **stop the instance between sessions — `t3.small` is not free.**

⚠️ The **region** is here because it was nowhere: the EC2 console defaults to `us-east-1` and shows
an empty instance list, which reads as "everything is gone". It is not — the list is per-region.
Confirm from outside before believing the console:
`curl -s -o /dev/null -w '%{http_code}' https://api.omwanalytics.com/health`.

---

## Reference environment

- OpenMW 0.51 offline Lua API docs: `H:\OpenMW 0.51.0\Docs\` (prefer over
  readthedocs, which lags versions and rate-limits).
- Live OpenMW user dir: `C:\Documents\My Games\OpenMW\` — `openmw.log`,
  `global_storage.bin`, `player_storage.bin`, `saves/`, `openmw.cfg`.
- This mod is registered in `openmw.cfg` via `data=` + `content=omwanalytics.omwscripts`.
