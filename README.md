# OpenMW Analytics

A telemetry & analytics platform for [OpenMW](https://openmw.org/) mods. Morrowind
is the *domain*; the project itself is a production-inspired exercise in API design,
event-driven ingestion, Postgres data modeling, and observability.

The core challenge is a real one: **OpenMW's Lua sandbox has no network or
filesystem-write access.** So telemetry can't be pushed from inside the game.
Instead the mod emits structured, versioned log lines, and an external shipper
tails the log and forwards them — a *pull* ingestion pipeline built around that
hard platform constraint.

## Live

| | |
| --- | --- |
| **Dashboard** | **[omwanalytics.com](https://omwanalytics.com)** — Next.js on Vercel |
| **API** | [api.omwanalytics.com](https://api.omwanalytics.com/health) — Express on k3s (AWS EC2), Postgres on RDS |

Real gameplay events, shipped from a real OpenMW install. The dashboard falls back
to a labelled last-known-good snapshot when the API is offline (the cluster is
stopped between sessions to control cost).

## Architecture

```
OpenMW Lua mod ──print()──▶ openmw.log ──tail──▶ Node shipper ──POST──▶ API ──▶ Postgres ──▶ Dashboard
   (mod/)                   (game dir)          (shipper/)            (api/)     (RDS)      (dashboard/)
└─────────── runs on the player's machine ──────────────────────┘ └──────── deployed to the cloud ───────┘
                                                    ▲
                          the OMWA1 wire envelope is the contract between the two worlds
```

The mod and shipper can never be hosted — they run where the game runs. That HTTP
seam *is* the deploy boundary, which is why the API and dashboard were env-configured
from the start: deployment turned out to be pure configuration, not a rewrite.

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
| `api/` | Express + Zod ingest & query API; Drizzle + Postgres. **Operated service.** | Cloud (k3s on EC2) |
| `dashboard/` | Next.js App Router read surface; server components consume `/stats/*`. | Cloud (Vercel) |
| `k8s/` | Deployment, Service, Ingress, cert-manager issuers for the k3s cluster. | — |
| `packages/` | Shared wire contract (envelope schemas + types). *(planned)* | — |
| `design docs/` | The design bible (numbered, teaching-style). Start at `00_README_INDEX.md`. | — |

## Status

- ✅ **Vertical slice verified live** — real OpenMW launch → log → shipper → API →
  Postgres, confirmed end to end.
- ✅ **Ingest API** — generic `POST /events`, envelope validation, epoch-ms → `timestamptz`
  at the boundary, idempotent upsert.
- ✅ **Data model** — Postgres `events` table, `PRIMARY KEY (session_id, seq)`, `(type, ts)` index, JSONB payload.
- ✅ **Real events** — `AreaEntered` (first-party) and `ConfrontationAttempted`, emitted by a
  *separate* mod through the public `OMWA_Track` SDK — the cross-mod seam works.
- ✅ **Shipper reliability** — at-least-once delivery: durable offset, post-then-checkpoint,
  first-line fingerprinting to detect a relaunched (recreated) log.
- ✅ **Dashboard** — pass-rate/failure-reason views over `GET /stats/*`, aggregated in SQL.
- ✅ **Deployed** — Docker image built by GitHub Actions → GHCR, running on k3s behind a
  Traefik ingress with auto-renewing Let's Encrypt TLS; Postgres on managed RDS.
- ⬜ **Ingest auth** — `POST /events` is currently unauthenticated. Next up.

## Quickstart (local development)

```bash
# from repo root
npm install                      # installs all workspaces
npm run --workspace api db:up    # start Postgres in Docker
npm run api                      # start the ingest API (http://localhost:4000)
npm run ship                     # tail openmw.log and forward events
```

To ship into the deployed stack instead of a local API, point the shipper at it:

```bash
OMWA_API='https://api.omwanalytics.com/events' npm run ship
```

The shipper keeps a durable checkpoint (`shipper/.ship-state.json`), so it resumes where
it left off. On its **very first** run — with no checkpoint — it starts at end-of-file so a
large pre-existing log isn't replayed.

The mod loads automatically once its `data=`/`content=` entries are present in
`openmw.cfg` (see `mod/omwanalytics.omwscripts`).

## Design docs

The full reasoning — pipeline, envelope contract, event registry, data model,
instrumentation model — lives in [`design docs/`](./design%20docs/), written in a
Why / How / Tradeoffs teaching style. Begin with
[`00_README_INDEX.md`](./design%20docs/00_README_INDEX.md).
