---
description: Run the full telemetry pipeline check — log → shipper → API → Postgres → stats. Optionally filter by event type: /verify-pipeline SkillCheckResolved
---

Verify the OpenMW Analytics pipeline end to end after an in-game test run. If the user passed an argument ("$ARGUMENTS"), treat it as an event `type` to focus the report on.

**Do the steps in order and stop early if a step fails** — a later step's output is meaningless if an earlier one broke.

## 0. What is already true before you start

- `openmw.log` is at `C:\Documents\My Games\OpenMW\openmw.log`.
- Postgres runs in Docker as container `omwanalytics-db` (user `omwa`, db `omwanalytics`).
- ⚠️ **The log is truncated on every game launch.** Events sitting in it are lost if the game restarts before the shipper runs. If the user just finished playing, **ship first, analyse second**.

## 1. Read the emitter's output (source of truth for emission)

```bash
cd "C:/Documents/My Games/OpenMW" && grep -c "OMWA1" openmw.log
grep -o '"type":"[A-Za-z]*"' openmw.log | sort | uniq -c | sort -rn
```

Aggregate — never paste whole log lines unless diagnosing a specific payload. If an expected event is **missing**, check whether the underlying gameplay actually happened before assuming the emit is broken (e.g. `grep -c "Evidence stored:" openmw.log` for `EvidenceCollected`). *Absent gameplay ≠ broken telemetry* — this distinction has mattered before.

## 2. Start the API and ship

```bash
cd "C:/Documents/My Games/OpenMW/data/dev-mods/OpenMWAnalytics/api" && (npx tsx src/index.ts > /tmp/omwa-api.log 2>&1 &) ; for i in $(seq 1 30); do curl -s -m 2 http://localhost:4000/health >/dev/null && break; done; echo "api up"
cd ../shipper && timeout 12 node ship.mjs 2>&1 | tail -5
```

Expect `sent N -> { received: N, inserted: N, duplicates: 0 }`. A relaunch line (`new log detected … reshipping from start`) is **correct behaviour**, not an error.

If the API 500s, the detail is in `/tmp/omwa-api.log` — `grep -A3 "cause: error:" /tmp/omwa-api.log | head -8`.

## 3. Confirm the rows and their JSON types

```bash
docker exec omwanalytics-db psql -U omwa -d omwanalytics -c "select type, count(*) from events group by type order by 2 desc;"
```

For any event with array or numeric payload fields, **check the jsonb types**, not just presence:

```bash
docker exec omwanalytics-db psql -U omwa -d omwanalytics -c "select jsonb_typeof(data->'<field>') , count(*) from events where type='<Type>' group by 1;"
```

⚠️ An empty Lua table serialises to `{}` (a JSON **object**), so an array field must report `array` — if it reports `object`, the emitter is sending an empty table instead of omitting the key.

## 4. Query the read side

⚠️ **Re-check `/health` first.** A backgrounded API from an earlier tool call does not reliably
survive into the next one — a bare `curl` then fails with a connection error that looks like an
endpoint bug. Restart it if needed before reading anything into the result.

```bash
curl -s -m 2 http://localhost:4000/health || (cd "C:/Documents/My Games/OpenMW/data/dev-mods/OpenMWAnalytics/api" && (npx tsx src/index.ts > /tmp/omwa-api.log 2>&1 &) ; for i in $(seq 1 40); do curl -s -m 2 http://localhost:4000/health >/dev/null 2>&1 && break; done)
curl -s -m 10 http://localhost:4000/stats/confrontations
curl -s -m 10 http://localhost:4000/stats/friction
curl -s -m 10 http://localhost:4000/stats/skills
```

Pipe to `python -m json.tool` for readability, but **never** hide a failure behind
`2>/dev/null` — a silently empty result reads as "no data" when it was actually a crashed
request. If a formatter produces nothing, print the raw body before drawing any conclusion.

⚠️ **If a new event type was just introduced, check `/stats/friction` for an unexpected `other` bucket.** Sequence queries (`LEAD` over the event stream) are coupled to the *set* of event types: a new type the `CASE` has no branch for silently lands in `other`. See `design docs/07 §4c`.

## 5. Stop the servers — `pkill` DOES NOT WORK HERE

`pkill`/`kill` appear to succeed on Windows but leave the process listening, which leads to reading **stale output from an old build**. Always kill by PID:

```powershell
$c = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
if ($c) { foreach ($id in ($c.OwningProcess | Select-Object -Unique)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }
Start-Sleep -Seconds 2
if (Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue) { "STILL up" } else { "port 4000 free" }
```

## 6. Report

1. **Events emitted** (by type) vs **rows landed** — call out any mismatch.
2. **Payload spot-check** for anything new: field present, correct jsonb type.
3. **Anything missing**, and whether the cause is a broken emit or gameplay that never happened.
4. **Stats endpoints**: did the new data actually move the numbers.
5. **Is one action dominating the aggregate?** Check `count(*)` vs `count(distinct session_id)`
   per `check_id`. A cheap, repeatable action (a retryable lottery roll, a spammable button)
   produces many identical rows from one player and can swamp a distribution — the metric then
   describes *one action's repeatability*, not player experience. When it does, the fix is to
   count **distinct (session, check_id)**, i.e. one vote per player per check, because that is
   the unit the question is actually about.
6. Confirm the servers were stopped.

Do not claim an event is verified unless you saw its row in Postgres. "I saw the log line" proves the emitter, not the pipeline.
