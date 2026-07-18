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

## 5. Deferred (YAGNI until a forcing function)

- **Explicit backoff** — on a long API outage the loop retries every 1s. Harmless at dev
  scale; add exponential backoff if it ever matters.
- **Multiple / rotated log files** — we assume one `openmw.log`. OpenMW doesn't rotate
  mid-session, so out of scope.
- **Batch size / flush caps** — one POST per poll of whatever accumulated. Fine at
  current volumes; cap if a single poll could produce a huge batch.
- **Backpressure / on-disk queue** — the log *is* the durable buffer; if the API is down
  the events simply wait in `openmw.log`. No separate spool needed.
