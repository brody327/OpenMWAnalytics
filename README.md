# OpenMW Analytics

A telemetry & analytics platform for [OpenMW](https://openmw.org/) mods. Morrowind is the *domain*;
the project is a production-inspired exercise in API design, event-driven ingestion, Postgres
modelling and performance, retrieval, and operations.

The core challenge is a real one: **OpenMW's Lua sandbox has no network and no filesystem-write
access.** Telemetry cannot be pushed from inside the game. So the mod emits structured, versioned
log lines and an external shipper tails the log and forwards them — a *pull* ingestion pipeline
built around a hard platform constraint.

| | |
| --- | --- |
| **Dashboard** | **[omwanalytics.com](https://omwanalytics.com)** — Next.js 16 on Vercel |
| **API** | [api.omwanalytics.com](https://api.omwanalytics.com/health) — Express 5 on k3s (AWS EC2), Postgres 16 on RDS |
| **Build** | [`GET /version`](https://api.omwanalytics.com/version) reports the commit currently serving |

---

## What makes it more than a dashboard

Most analytics can tell a mod author *"players are failing here."* This one also parses the game's
own data files into Postgres, so it can sometimes say something more useful: **the failure may not
be the player's fault.**

> A lockbox puzzle asks for **Luck 100**. The 90th-percentile failing player was **70 points
> short** — and across Morrowind, Tribunal, Bloodmoon and the mod itself there is **no item,
> potion, spell or enchantment** that closes a gap that size.
>
> That is an authoring gap, not a tuning one. Neither half of the data could have found it alone.

Two pipelines make that possible: gameplay telemetry, and a searchable index of **47,747** records
parsed out of the `.esm` files (hybrid `tsvector` + pgvector HNSW retrieval).

### Where a language model earns its keep — and where it doesn't

One question resists SQL: when a remedy *does* exist, does the game's own dialogue ever point a
player at it? That is a judgement about prose, so a single bounded call makes it.

**Four of the six pipeline steps are database queries.** The model gets a fixed evidence payload,
no tools, and one question. Everything it writes is mechanically validated before a human ever
sees it:

- **Number whitelist** — every integer in the output must appear in the evidence. A hallucinated
  "+15 Personality" is rejected by set membership.
- **Citation membership** — every cited record id must be one that was supplied.
- **No reachability claims** — the vocabulary ("apothecary", "sold", "buy") cannot reach the model
  from the evidence, so its appearance proves invention.
- **A rejected insight leaves no row.** Not stored-as-rejected — a fabricated claim one click from
  "approved" is the failure the design exists to prevent.

Insights land `pending`; the public endpoint filters `status = 'approved'` **in SQL**, with no
query parameter that can widen it.

---

## Architecture

```
OpenMW Lua mod ──print()──▶ openmw.log ──tail──▶ Node shipper ──POST──▶ API ──▶ Postgres ──▶ Dashboard
   (mod/)                   (game dir)          (shipper/)            (api/)     (RDS)      (dashboard/)
└─────────── runs on the player's machine ──────────────────────┘ └──────── deployed to the cloud ───────┘
                                                    ▲
                          the OMWA1 wire envelope is the contract between the two worlds

              .esm game files ──esmtool──▶ parser ──▶ game_records + chunks + embeddings ──┘
                    (local only — the game files cannot leave the machine)
```

The mod and shipper can never be hosted — they run where the game runs. That HTTP seam *is* the
deploy boundary, which is why the API and dashboard were env-configured from the start: deployment
turned out to be configuration, not a rewrite.

Every telemetry line is `OMWA1 <json>` — a versioned envelope (anonymous `install_id` +
`session_id`, monotonic `seq`, event-time `ts`, event `type`, JSON `data`). The tag lets the
shipper grep telemetry out of noisy game logs; the version marker lets the server keep accepting
events from already-installed mod versions.

**Identity is anonymous by construction** — random UUIDs only. No player name, no IP, no PII.

---

## Stack

| Layer | Choice |
| --- | --- |
| **Ingest / query API** | Node 22, TypeScript 7, Express 5, Zod 4, Drizzle ORM |
| **Database** | Postgres 16 (AWS RDS), pgvector 0.8, JSONB + generated columns |
| **Retrieval** | OpenAI `text-embedding-3-small` @ 384 dims (Matryoshka-truncated), HNSW, `tsvector`, RRF fusion |
| **Insights** | Anthropic `claude-opus-5` — structured outputs, server-side fallbacks |
| **Dashboard** | Next.js 16 (App Router, Server Components), React 19, Tailwind 4 |
| **Infra** | k3s on EC2, Traefik ingress, cert-manager + Let's Encrypt, GHCR |
| **CI/CD** | GitHub Actions → tests → image → **AWS SSM + OIDC** deploy → `/version` assertion |

---

## Capabilities

- **Generic event ingestion** — any new event `type` is stored as typed columns + JSONB with
  **zero DDL**. Idempotent upsert on `(session_id, seq)`; bearer-authenticated; rate-limited.
- **At-least-once shipping** — durable offsets, post-then-checkpoint, first-line fingerprinting to
  detect a recreated log. Self-healing scheduled task, heartbeat, and a freshness endpoint that has
  fired a real alert.
- **Postgres performance** — index-only scans over generated columns, incrementally-folded
  materialized rollups on a scheduled CronJob, and a hybrid read that gives back the freshness the
  rollups cost.
- **Hybrid corpus search** — lexical + vector with reciprocal-rank fusion; `ef_search` tuned
  against a measured recall curve (89.3% → 91.6% @ ef=80).
- **Content-gap analysis** — joins telemetry to game content to find gates with no remedy, with
  reachability answered from a 6,797-placement world survey and reported as `UNKNOWN` when the
  data cannot support a claim.
- **Reviewed AI insights** — bounded prompt, mechanical validation, human approval gate.

## Deployment

Push to `main` runs tests (with a pgvector service container), builds the image, deploys via
**AWS Systems Manager** — no inbound SSH port, and **no long-lived credential in the repo**, since
GitHub OIDC mints short-lived AWS credentials scoped to one instance and one document — then
asserts `GET /version` through the public ingress. A stale pod cannot return the new commit's sha,
which is the property `/health` lacks.

---

## Testing

**159 tests in five layers**, each chosen for what it can actually detect — **117 API** (unit +
HTTP-level against a real Postgres), **14 shipper reliability**, **17 component** (Vitest + jsdom),
and **11 Playwright E2E** asserting invariants against a running deployment. New guards are
mutation-checked: broken deliberately to confirm they go red, then reverted to confirm they go
green. Both CI suites also assert a **minimum collected test count**, because a runner that
matches zero files exits 0.

```bash
npm test                                    # 148: api (117) + shipper (14) + dashboard (17)
npm test --workspace api                    # needs Postgres for the DB-backed subset
npm run test:e2e --workspace dashboard      # 11, against a live stack
```

See [TESTING.md](./TESTING.md) — including what is deliberately *not* tested, and the ranked gaps.

## Repository layout

npm-workspaces monorepo. The **only** part OpenMW loads is `mod/`.

| Path | What it is | Runs where |
| --- | --- | --- |
| `mod/` | The OpenMW mod: Lua emitter + `.omwscripts`. **Distributed to players.** | Player's machine (Lua sandbox) |
| `shipper/` | Node log-tailer that ships `OMWA1` lines to the API. | Player's machine |
| `api/` | Express + Zod ingest & query API; Drizzle + Postgres; corpus ingest; insights. | Cloud (k3s on EC2) |
| `dashboard/` | Next.js App Router read surface. | Cloud (Vercel) |
| `k8s/` | Deployment, Service, Ingress, cert-manager issuers, rollup CronJob. | — |
| `design docs/` | Numbered decision records — what was chosen, what was rejected, what settled it. Start at `00_README_INDEX.md`. | — |

## Quickstart

```bash
npm install                      # all workspaces
npm run --workspace api db:up    # Postgres + pgvector in Docker
npm run --workspace api db:migrate:run
npm run api                      # ingest API on :4000
npm run ship                     # tail openmw.log and forward
```

Optional, for the corpus and demo volume:

```bash
npm run --workspace api ingest-corpus -- <esmtool-dump> <source>
npm run --workspace api seed-synthetic          # ~180k labelled demo events
```

The shipper keeps a durable checkpoint (`shipper/.ship-state.json`) and resumes where it left off.
On its **very first** run it starts at end-of-file so a large pre-existing log isn't replayed.

---

## A note on the data

The public instance is padded with ~180,000 generated events (`env = 'synthetic'`) so aggregation,
pagination and rollup behaviour have real volume to work against — labelled with a banner on every
view that includes them.

**The content-gap analysis excludes them in SQL.** Findings are computed from real recorded play
only, and insight generation resolves its gate through the same filtered query — so a fabricated
gate is not *rejected*, it is never found.

## Design docs

The full reasoning — pipeline, envelope contract, event registry, data model, retrieval,
deployment, and the AI layer — lives in [`design docs/`](./design%20docs/), written Why / How /
Tradeoffs, including the cases where running the thing contradicted the design. Begin with [`00_README_INDEX.md`](./design%20docs/00_README_INDEX.md).

## License

[MIT](./LICENSE) — Brody Faust.

Morrowind and OpenMW assets are the property of their respective owners; no game data is
redistributed here. The corpus pipeline parses `.esm` files locally and never copies them into
the repository or the cloud.
