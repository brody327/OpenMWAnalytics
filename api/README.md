# OpenMW Analytics — API

Ingestion + query API. Node/TypeScript, Express 5, Drizzle ORM, Postgres 16.

Design: `../design docs/05_API_DESIGN.md` (API) and `06_DATA_MODEL.md` (schema).

## Prerequisites

- Node 20+ and Docker Desktop running.

## Run

```bash
npm install
npm run db:up        # start Postgres 16 in Docker
npm run db:push      # create/sync the events table from src/db/schema.ts
npm run dev          # start the API on http://localhost:4000 (tsx watch)
```

## Endpoints

- `GET /health` → `{ "ok": true }`
- `POST /events` → accepts a JSON **array** of event envelopes; returns
  `{ received, inserted, duplicates }`. Idempotent on `(session_id, seq)`.

### Example

```bash
curl -X POST http://localhost:4000/events -H "Content-Type: application/json" -d '[
  {"v":1,"type":"AreaEntered","seq":1,
   "install_id":"e2a9cd3e-5f67-4911-88c4-b71f15ad1a33",
   "session_id":"1f5afde8-3968-41c2-b820-895743e5da35",
   "ts":1752521538000,"data":{"cell":"Balmora"}}
]'
```

Re-POST the same event and `duplicates` increments while the row count does not —
at-least-once delivery made safe by an idempotent upsert.

## Useful

```bash
npm run db:studio    # Drizzle Studio (browse the DB)
npm run db:down      # stop Postgres (add -v in compose to wipe the volume)
docker exec omwanalytics-db psql -U omwa -d omwanalytics -c "SELECT * FROM events;"
```

## Scripts

| Script | Does |
| --- | --- |
| `dev` | run with hot reload (tsx watch) |
| `build` / `start` | compile to `dist/` and run |
| `db:up` / `db:down` | start / stop Postgres container |
| `db:push` | sync schema to DB (dev iteration) |
| `db:generate` / `db:migrate` | generate + apply migration files (production path) |
| `db:studio` | Drizzle Studio DB browser |
