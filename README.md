# OpenMW Analytics

A telemetry & analytics platform for [OpenMW](https://openmw.org/) mods. Morrowind
is the *domain*; the project itself is a production-inspired exercise in API design,
event-driven ingestion, Postgres data modeling, and observability.

The core challenge is a real one: **OpenMW's Lua sandbox has no network or
filesystem-write access.** So telemetry can't be pushed from inside the game.
Instead the mod emits structured, versioned log lines, and an external shipper
tails the log and forwards them — a *pull* ingestion pipeline built around that
hard platform constraint.

## Architecture

```
OpenMW Lua mod ──print()──▶ openmw.log ──tail──▶ Node shipper ──POST──▶ API ──▶ Postgres ──▶ Dashboard
   (mod/)                   (game dir)          (shipper/)            (api/)                 (planned)
└─────────── ships to players (frozen once installed) ──────────┘ └──── services you operate ────┘
                                                    ▲
                          the OMWA1 wire envelope is the contract between the two worlds
```

Every telemetry line is `OMWA1 <json>` — a versioned envelope (anonymous
`install_id` + `session_id`, monotonic `seq`, event-time `ts`, event `type`, and a
JSON `data` payload). The tag lets the shipper grep telemetry out of noisy game
logs; the version marker lets the server keep accepting events from old, already-
installed mod versions.

## Repository layout

This is an npm-workspaces monorepo. The **only** part OpenMW loads is `mod/`; a
single `data=` entry in `openmw.cfg` points at it, so the server-side code is
invisible to the game.

| Path | What it is | Runs where |
| --- | --- | --- |
| `mod/` | The OpenMW mod: Lua emitter + `.omwscripts`. **Distributed to players.** | Player's machine (Lua sandbox) |
| `shipper/` | Node log-tailer that ships `OMWA1` lines to the API. Companion tool. | Player's machine |
| `api/` | Express + Zod ingest API; Drizzle + Postgres. **Operated service.** | Your server |
| `packages/` | Shared wire contract (envelope schemas + types). *(planned)* | — |
| `design docs/` | The design bible (numbered, teaching-style). Start at `00_README_INDEX.md`. | — |

## Status

- ✅ **Vertical slice verified live** — real OpenMW launch → log → shipper → API →
  Postgres, confirmed end to end.
- ✅ **Ingest API** — generic `POST /events`, envelope validation, epoch-ms → `timestamptz`
  at the boundary, idempotent upsert.
- ✅ **Data model** — Postgres `events` table, `PRIMARY KEY (session_id, seq)`, `(type, ts)` index, JSONB payload.
- ✅ **First real event** — `AreaEntered` ("where do players spend time?").
- ⬜ **Dashboard** — the question-answering read surface. Not started.

## Quickstart (server side)

```bash
# from repo root
npm install                      # installs all workspaces
npm run --workspace api db:up    # start Postgres in Docker
npm run api                      # start the ingest API (http://localhost:4000)
npm run ship                     # tail openmw.log and forward events
```

The mod loads automatically once its `data=`/`content=` entries are present in
`openmw.cfg` (see `mod/omwanalytics.omwscripts`).

## Design docs

The full reasoning — pipeline, envelope contract, event registry, data model,
instrumentation model — lives in [`design docs/`](./design%20docs/), written in a
Why / How / Tradeoffs teaching style. Begin with
[`00_README_INDEX.md`](./design%20docs/00_README_INDEX.md).
