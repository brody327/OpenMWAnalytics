# 01 — Architecture Overview

## The problem in one sentence

Collect behavioral telemetry from OpenMW mods, store it, and turn it into
**actionable design insights** ("Puzzle 7 has a 71% failure rate"), not raw counts.

## The pipeline

```
┌──────────────┐   print()   ┌────────────┐   tail    ┌───────────┐   POST    ┌───────┐        ┌────────────┐        ┌───────────┐
│ OpenMW Lua   │ ──────────▶ │ openmw.log │ ────────▶ │  Shipper  │ ────────▶ │  API  │ ─────▶ │  Postgres  │ ─────▶ │ Dashboard │
│ (mod, GLOBAL)│             │ (plaintext)│           │  (Node)   │           │(Node) │        │  (JSONB)   │        │ (React)   │
└──────────────┘             └────────────┘           └───────────┘           └───────┘        └────────────┘        └───────────┘
     emit                     durable buffer            transport             validate            store               visualize
```

## Why this shape? The load-bearing constraint

OpenMW's Lua runs in a **security sandbox with no network access and no
filesystem-write access** (verified against the 0.51 API docs). A mod therefore
*cannot* `POST /events` directly. The only ways data can leave the game are
engine-provided persistence channels:

| Channel | File | Format | Verdict |
| --- | --- | --- | --- |
| `print()` → log | `openmw.log` | plain text, append-only, **a stream** | ✅ **chosen** |
| `storage` (Persistent) | `global_storage.bin` | binary KV **snapshot**, flushed on exit only | identity only |
| savegame | `saves/*.omwsave` | binary | ❌ |
| `vfs` | data dirs | **read-only** | ❌ (can't write) |

Events are an append-only stream; the log *is* an append-only stream — a shape
match. This also mirrors a real production pattern: **structured application logs
tailed by an agent** (Filebeat / Fluentd / Vector). We're building a miniature of a
genuinely industrial ingestion architecture.

**Design principle:** the API contract is defined as if ingestion is always HTTP,
so the server never knows or cares whether events arrived from a live shipper or a
manual file import. Clean service boundary.

## Components

| Component | Tech | Responsibility |
| --- | --- | --- |
| **Mod (emitter)** | Lua (OpenMW) | Detect gameplay, build events, `print()` `OMWA1 <json>` lines. Stamp identity. |
| **Shipper** | Node/TS | Tail `openmw.log`, extract our lines, batch, POST to API. Own transport reliability (offset tracking, truncation detection, retries). |
| **API** | Node/TS (Express/Nest) | Validate + accept events (ingest), serve aggregates (query). |
| **Database** | Postgres | Durable event store; aggregation queries. |
| **Dashboard** | React / Next.js | Answer product questions from the data. |

## What has been validated (2026-07-14 spike)

Proven in the real game, not assumed:

- A **GLOBAL** script's `print()` reaches `openmw.log` in near-real-time.
- A `OMWA1 <json>` sentinel line survives intact; the Node shipper extracts and
  parses it (matching the `OMWA1 ` substring, tolerant of OpenMW's `Global[...]:\t`
  prefix).
- The sandbox has **no JSON library** → we ship our own (`scripts/omwanalytics/json.lua`).
- Anonymous identity works: `install_id` persisted to `global_storage.bin` across a
  clean exit; `session_id` fresh per launch.
- **Gotcha learned:** persistent storage is buffered in memory and flushed to disk
  only on save / clean-exit — fine for `install_id`, and another reason storage
  can't be the live event channel.

## Known constraints & risks (carry forward)

- **Log truncation:** `openmw.log` is overwritten on each launch → the shipper must
  detect truncation (offset > filesize ⇒ reset). Handled in the spike.
- **No delivery guarantee from `print()`** → at-least-once achieved by the shipper
  persisting a read offset; consumer must dedup. See `02` delivery contract.
- **Weak RNG** in the sandbox (`math.random`, engine-seeded) → fine for anonymous
  ids, never for anything security-bearing.
- **UTF-8 / escaping** in log lines → our JSON encoder escapes control chars.
