# 04 — Shipper Design (log tail → API delivery)

**Status:** 🟢 built + reliability pass done 2026-07-18 (`shipper/ship.mjs`).

The shipper is the **egress half** of the pull pipeline. The Lua sandbox can't POST
(see `01`), so the mod emits `OMWA1 <json>` lines to `openmw.log` and this external
Node process tails the log and POSTs batches to the ingest API. It is the one
component that must reason about **delivery reliability** — everything upstream is
fire-and-forget, everything downstream is idempotent.

---

## 1. Job

```
openmw.log  --tail-->  ship.mjs  --POST batch-->  /events  -->  Postgres
```

Poll the log every `POLL_MS` (1s); read new bytes since the last offset; extract the
`OMWA1`-sentinel lines; POST the batch. Simple by design — the interesting part is
surviving the two things that actually happen in practice: **the API being down** and
**the game relaunching** (which recreates `openmw.log`).

---

## 2. Delivery guarantee: at-least-once + idempotent sink = effectively-once

The three classic options:

| Guarantee | Meaning | Cost |
| --- | --- | --- |
| at-most-once | advance position, then send; a failed send is lost | data loss |
| **at-least-once** | send, then advance only on success; may re-send | duplicates |
| exactly-once | never lose, never duplicate | distributed-systems-hard |

We pick **at-least-once**, because the *consumer is already idempotent*: the API upserts
on `PRIMARY KEY (session_id, seq)` (`06`), so a re-sent event is a harmless no-op
(`duplicates` counter ticks). at-least-once + idempotent sink gives **effectively-once**
without any distributed-transaction machinery. **Idempotency upstream is what makes
retry safe downstream** — the single most important property in the pipeline.

> Regression this fixed (D1): the first version advanced the byte offset *before*
> awaiting the POST, so a failed POST (API down — which happened) silently dropped that
> batch. That is accidental *at-most-once*. The fix is ordering: **post-then-checkpoint**.

---

## 3. Mechanisms

### 3.1 Post-then-checkpoint (D1)
Advance and persist the offset **only after a 2xx**. On failure, leave the offset put;
the next poll re-reads the same bytes and re-sends. Retry is therefore automatic — it
falls out of *not* advancing, no retry queue needed. (Chunks with **no** `OMWA1` lines —
i.e. startup spam — advance without a POST, so we don't rescan megabytes each poll.)

### 3.2 Durable offset checkpoint (D2)
`{offset, fingerprint}` is written to a sidecar `shipper/.ship-state.json` (git-ignored,
per-machine runtime state) after each advance, via **temp-file + atomic rename** so a
crash never leaves a half-written checkpoint. On startup the shipper **resumes from the
checkpoint** instead of EOF, so a shipper restart no longer skips events emitted while it
was down.

### 3.3 Relaunch / truncation detection (D3)
`openmw.log` is recreated every launch, so a byte offset from the previous file is
meaningless against the new one. Detecting this by `size < offset` alone is **not enough**:
if the new session's startup logging grows past the old offset before the next poll, the
shrink is never observed and the whole session is silently skipped (this is what dropped
session `ce7bd7c4`). Instead we **fingerprint the log's first line** (sha1) — OpenMW's
opening banner carries a per-launch timestamp, so a relaunch changes it. A changed
fingerprint **or** `size < offset` ⇒ new file ⇒ reset offset to 0 and ship the new
session from the top. The fingerprint is deferred until a first newline exists, so a
still-being-written opening line can't produce a partial hash and a spurious reship.

### 3.4 First-run start
With **no** checkpoint (fresh install), start at **EOF** so a large pre-existing
`openmw.log` isn't replayed. Once a checkpoint exists it always wins; on truncation we
reset to 0 regardless. (Trade-off: a first run started while the game is already running
skips whatever preceded shipper start — acceptable; that history predates the observer.)

---

## 4. Verification

Reliability logic is covered by a deterministic harness (mock API + synthetic log,
`scratchpad/test-shipper.mjs`) that asserts all three fixes: ships appended events +
writes a checkpoint (D2), reships after a first-line change / truncation (D3), and
redelivers an event across a POST failure once the API returns (D1). All pass. The
original live failure (game relaunch dropping a session) is exactly the D3 case.

---

## 5. Operating it (and the first-run trap, observed live 2026-07-20)

Run it against local dev, or against the deployed API:

```bash
OMWA_API='https://api.omwanalytics.com/events' node ship.mjs
```

**The failure:** a full play session's events reached `openmw.log` but never reached
Postgres. The shipper simply **was not running** while the game was.

**How that was diagnosed, and why the tell is worth remembering:** the checkpoint file
`shipper/.ship-state.json` did not exist. The shipper writes it even for a chunk containing
**zero** events (it advances past startup noise so it need not rescan). So the file's absence
proves the loop never completed a single poll — a stronger and faster signal than reading
logs. *An artifact written on every iteration is a liveness probe for free.*

**Why it couldn't simply be restarted:** §3.4's first-run rule means that with no checkpoint
the shipper starts at **EOF** — so starting it after the fact would have silently skipped the
events already in the log. The trade-off documented as "acceptable: that history predates the
observer" is exactly right in principle and exactly the trap in practice, because the *first*
run is when a user is most likely to play first and ship second.

**Recovery** — seed a checkpoint at the top of the file and let the normal loop do the work:

```bash
printf '{"offset":0,"fingerprint":null}' > shipper/.ship-state.json
```

The whole log is then reshipped. This is safe **because of D1**: the API upserts on
`(session_id, seq)`, so replay is idempotent. Observed: `received: 8, inserted: 8,
duplicates: 0`. At-least-once delivery into an idempotent sink turns what would otherwise be
a data-loss incident into a one-line fix — the reliability model paying for itself.

**After the first run the trap is gone.** Start-at-EOF applies only when no checkpoint exists;
once one does, starting the shipper *after* a session resumes from the checkpoint and catches
up. Ordering is only fragile exactly once.

---

## 6. Deferred (YAGNI until a forcing function)

- **Explicit backoff** — on a long API outage the loop retries every 1s. Harmless at dev
  scale; add exponential backoff if it ever matters.
- **Multiple / rotated log files** — we assume one `openmw.log`. OpenMW doesn't rotate
  mid-session, so out of scope.
- **Batch size / flush caps** — one POST per poll of whatever accumulated. Fine at
  current volumes; cap if a single poll could produce a huge batch.
- **Backpressure / on-disk queue** — the log *is* the durable buffer; if the API is down
  the events simply wait in `openmw.log`. No separate spool needed.

---

## ⚠️ THE SIX-DAY SILENT OUTAGE (2026-07-20 → 07-27) — supervision, not monitoring

**What happened.** The shipper's Scheduled Task last *started* on **2026-07-20 19:06**, exited with
`LastTaskResult 0xC000013A` (`STATUS_CONTROL_C_EXIT`), and never ran again. Prod's newest event was
**2026-07-21 00:14 UTC** — six days stale. Nobody noticed. Nothing alerted.

⭐ **`/health` was green the entire time, and was right to be.** The API was healthy; the database
was healthy; the *pipeline* was dead. Liveness of a service says nothing about liveness of the flow
through it — the failure was two hops upstream of everything being watched, on a Windows box.

### The diagnosis: it WAS configured to restart itself, and that was not enough

| setting | value | verdict |
| --- | --- | --- |
| `MultipleInstances` | `IgnoreNew` | ✅ |
| `RestartCount` / `RestartInterval` | `3` / `1 min` | ⚠️ **restarts on failure — three times, then stops forever** |
| `ExecutionTimeLimit` | `PT0S` (none) | ✅ |
| **trigger** | **logon only, no repetition** | ❌ **the gap** |

It failed, retried three times a minute apart, exhausted them, and then **nothing was ever going to
try again until the next logon.** A task that is technically self-restarting and still stays dead
for six days.

### The fix (applied + VERIFIED 2026-07-27)

A second trigger: `-Once` with `-RepetitionInterval 15 min` and **no duration** (an empty duration
is how Task Scheduler encodes *indefinitely*; `[TimeSpan]::MaxValue` serialises to
`P99999999DT23H59M59S` and is rejected outright).

`MultipleInstances = IgnoreNew` is what makes this safe: the repeat is a **no-op while the shipper
is running** and a **restart when it is not**. Self-healing supervision, two lines of config.

⭐ **Verified by breaking it, not by reading it.** Interval temporarily set to 1 minute, the running
shipper killed (PID 47592), and the task observed bringing it back (PID 25856) ~60 s later; interval
then restored to 15 minutes. The settings table above *looked* correct before the fix too — only
killing it distinguishes a supervision policy that works from one that merely parses.

**No data was lost.** The shipper keeps a durable offset and is at-least-once, so restarting resumed
from where it stopped: the six-day backlog, including that day's test events, shipped on restart.
The design's own reliability property is what turned a six-day outage into a delay.

### ▶ What this does NOT fix, and why monitoring is still warranted

Supervision handles *the process died*. It cannot see: the machine being off, the network being
down, the API rejecting every batch, or the shipper running but stuck. Those need a freshness
signal with an **external** notifier — a check nobody polls would have missed this outage exactly as
completely as no check at all.

⚠️ **Freshness must NOT be folded into `/health`.** `k8s/deployment.yaml` wires `/health` to both
`livenessProbe` and `readinessProbe`, so a stale-data 503 would make Kubernetes restart the API pod
and pull it from the Service — for a condition the API neither causes nor can fix. A dead shipper on
a laptop would crashloop the production API, an outage caused entirely by the monitoring.

> **Liveness asks "should this process be restarted?" Freshness asks "is the data trustworthy?"**
> They must never share an endpoint, because one of them has a destructive remediation attached.

### ✅ Freshness monitoring — BUILT + VERIFIED 2026-07-27

The safety net supervision cannot provide (machine off, network down, API rejecting, shipper
alive-but-stuck).

| piece | what |
| --- | --- |
| `shipper_state` | **one row per install**, UPSERTed. Bounded by installs, never by time |
| `POST /ops/heartbeat` | authenticated (it writes; an open route would let anyone forge "the pipeline is fine") |
| `GET /ops/freshness` | **503 when any shipper is stale**, so a dumb external monitor can page a human |
| `ship.mjs` | pings every 5 min **whether or not there is anything to send** |

⭐ **The heartbeat's entire value is that it fires when idle.** A ping sent only alongside events
carries zero information — it would be silent in exactly the quiet period an outage hides in.

⭐ **Why not `max(events.received_at)`?** It only advances when someone *plays*, so in any quiet
period it grows without bound and a healthy pipeline looks broken — the same bug
`friction_fold_state` exists to avoid one layer down. An alert on it would fire every time the
author took a day off, get muted, and then miss the real outage. It is **reported for context and
never alerted on**. *"Is the shipper alive"* and *"is anyone playing"* are different questions;
only the first is an outage.

⭐ **Why not an event type?** `03` retired the original `Heartbeat` because 1,049 of them against
11 real events bloated storage *and* corrupted sequence analysis. A single-row-per-install table is
invisible to every sequence query because it is not in `events` at all.

**Threshold: 120 minutes.** Deliberately generous against a 5-minute ping — it tolerates a slept
laptop, a flaky network, a reboot. The failure being caught lasted six days; catching it in two
hours is ~70×, and a tighter bound would only buy false alarms.

**Verification — all eight cases, including the one that matters:**

| # | case | result |
| --- | --- | --- |
| 1 | no shippers registered | **503** — an empty table is *not* healthy; greening on no data is monitoring nothing |
| 2 | `/health` unaffected | 200 |
| 3 | heartbeat without token | 401 |
| 4 | malformed `install_id` | 400 |
| 5 | valid heartbeat | 200 |
| 6 | freshness after ping | 200, `ok: true` |
| 7 | ⭐ **`last_seen_at` aged by six days — the real outage replayed** | **503**, `minutes_since: 8640` |
| 8 | ⭐ **`/health` DURING that outage** | **200** — k8s correctly does nothing |

Cases 7 and 8 are the pair that matters: the freshness route detects the exact incident, and the
liveness route stays green so Kubernetes does not restart a pod over a laptop's dead process.

▶ **STILL REQUIRED — the endpoint is not the monitoring.** Something must *poll* `/ops/freshness`
and reach a human who is not looking. Until an external uptime monitor is pointed at it, this
detects the outage and tells nobody, which is the same outcome as 07-20.

### ⚠️ Two bugs found while deploying the freshness work (both silent)

**1. The install-id recovery window was 26× too small — and failed without erroring.**

`install_id` reaches the shipper only through event envelopes, so a restart during a quiet period
leaves it unable to identify itself until the player next plays — silent in exactly the window an
outage hides in. The fix reads backwards from the end of the log. The first version read a fixed
**64 KB tail**, which seemed generous.

Measured against the real log:

| tail scanned | `OMWA1` lines found |
| --- | --- |
| 64 KB | **0** |
| 512 KB | **0** |
| 4 MB | 12 ✅ |

**Telemetry lines are RARE in `openmw.log`** — a 1.7 MB log held twelve of them, and the engine's
own chatter (`LuaText` warnings and friends) buried them far from the end. The function parsed
cleanly, threw nothing, returned `null`, and the heartbeat simply never fired. It was caught only
by probing the assumption directly, because the observable symptom — `shippers: []` — is identical
to "the shipper hasn't started yet."

Now scans backwards in **1 MB chunks until it finds one**, bounded at 64 MB. A chunk's first line
is usually cut mid-line; it fails to parse and is skipped, so no carry buffer is needed.

**2. `Stop-ScheduledTask` orphans the `node` child → TWO shippers.**

Observed live: after `Stop-ScheduledTask` + `Start-ScheduledTask`, PIDs 25856 *and* 48288 were both
tailing the log. The task action is `powershell.exe → start-shipper.ps1 → node ship.mjs`; stopping
the task kills the wrapper but leaves the grandchild running. The task then reports itself
**not running**, so the next trigger starts a second one.

⚠️ **`MultipleInstances = IgnoreNew` does not protect against this** — it prevents the *task* from
running twice and knows nothing about an orphaned grandchild. Two shippers share one
`.ship-state.json` and race on the offset. Ingest is idempotent on `(session_id, seq)` so no data
is corrupted, but it is wasted work and a confusing state to debug.

**Operational rule: stop the shipper by killing the `node` process, not by stopping the task.**
Killing `node` ends the wrapper too, the task registers as finished, and the 15-minute trigger
restores it cleanly — which is exactly the path verified in the self-heal test above.

✅ **End-to-end verified in prod 2026-07-27:** single shipper, `/ops/freshness` → `200 ok:true`,
install registered at age 0m.
