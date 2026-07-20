# 05 — API Design

**Status:** 🟡 in progress. Node/TypeScript service with two jobs: **ingest**
(accept events from the shipper) and later **query** (serve aggregates to the
dashboard). This doc records the stack decisions and the ingest contract.

## Stack (decided 2026-07-14)

| Concern | Choice | Why (and the alternative) |
| --- | --- | --- |
| Language | TypeScript (ESM, NodeNext) | Type safety across the envelope contract. |
| HTTP framework | **Express 5** | Minimal; teaches HTTP mechanics directly. *Alt: NestJS — more structure (DI, decorators) but hides the mechanics we're here to learn.* |
| Validation | **Zod 4** | Parse-don't-validate at the edge; infers TS types from one schema. |
| ORM | **Drizzle** | SQL-shaped and thin — you read the actual query. *Alt: Prisma — heavier abstraction, generates a client.* |
| DB | **Postgres 16** (Docker) | Reproducible, disposable local DB. |
| Dev runner | `tsx watch` | Run TS directly, no build step in dev. |
| Migrations | `drizzle-kit push` (for now) | Fast iteration while schema moves; switch to generated migrations (`generate` + `migrate`) once stable. |

Layout: a single `api/` package for now (not a monorepo). We hoist to a workspace
when the dashboard app arrives — not before (simplicity first).

## Project structure

```
api/
  docker-compose.yml     Postgres 16
  drizzle.config.ts      drizzle-kit config
  .env(.example)         DATABASE_URL, PORT
  src/
    db/
      schema.ts          events table (physical form of the envelope; see 06)
      client.ts          pooled drizzle connection
    index.ts             Express app + routes   (Step B)
    events/
      schema.ts          zod envelope validation (Step B)
      ingest.ts          POST /events handler    (Step B)
```

## Ingest endpoint contract (Step B)

`POST /events` — accepts a **batch** (array) of envelopes. Batch, not one-per-
request, because the shipper ships many buffered lines at once; one round-trip per
event would be wasteful. (Resolves `02` §9(2) at the API side.)

Request body:
```json
[
  { "v":1, "type":"AreaEntered", "seq":42,
    "install_id":"…", "session_id":"…", "ts":1752521538000,
    "data":{ "cell":"Balmora" } }
]
```

Rules:
- **Validate the envelope hard** with Zod (types, uuid format, positive `seq`,
  `ts` a positive int). Reject the batch on a malformed envelope → `400`.
- **`data` is passthrough** — any JSON object; the platform stays generic. `type`
  is any non-empty string (governed by the registry, not the transport).
- **Convert at the boundary:** `ts` epoch-ms int → `Date` → `timestamptz`.
- **Idempotent insert:** one multi-row `INSERT … ON CONFLICT (session_id, seq) DO
  NOTHING`. Re-sent events are no-ops (see `06` §4).

Response `200`:
```json
{ "received": 10, "inserted": 8, "duplicates": 2 }
```
Returning the duplicate count makes at-least-once behaviour observable — the shipper
(and we) can see dedup working.

Also: `GET /health` → `200 { "ok": true }` (liveness; used by tooling and later by
the shipper before flushing).

## Ingest authentication (built 2026-07-20)

`POST /events` requires `Authorization: Bearer <OMWA_INGEST_TOKEN>`.
`GET /health` and `GET /stats/*` stay **deliberately public** — they are aggregate,
anonymous, and being readable is the point of a portfolio dashboard. Only the **write**
path is gated, because deployment moved it from "unreachable on localhost" to
"world-writable on the internet".

**Threat model — what this buys, and what it cannot.** The shipper runs on machines we do
not control. If the mod is ever distributed, the token ships with it and is extractable —
the same reason an API key baked into a mobile app is not really a secret. This is
therefore **not** a strong guarantee against a determined attacker; it is a barrier against
opportunistic and accidental writes, which is the realistic threat while exactly one
shipper exists. Distribute the mod and the correct model becomes **per-install keys**
(revocable, rate-limitable) plus server-side data-quality defence — never trust of the
client.

**Why a shared bearer token** over the alternatives, at this scale:

| Option | Verdict |
| --- | --- |
| **Shared bearer token** | ✅ one trusted client, rotatable, ~10 lines |
| Per-install API keys | revocation + quotas, but no registration flow and users are anonymous — the right answer *if* distributed |
| HMAC signing | secret never crosses the wire, stops replay with a nonce; TLS already covers transport — complexity without a matching threat |
| mTLS | strong, disproportionate ops for one shipper |
| IP allowlist | brittle (dynamic IP), useless once others run the mod |

**Three implementation decisions:**

1. **Fails closed.** With `OMWA_INGEST_TOKEN` unset the endpoint returns **503** and logs
   loudly — it does *not* wave traffic through. A missing config must break noisily;
   fail-open is how a control silently stops existing after an env change.
2. **Timing-safe comparison** (`crypto.timingSafeEqual`). A plain `===` short-circuits on
   the first differing byte, leaking prefix/length through response timing. Largely
   theoretical over TLS, but free — and lengths are compared first, since `timingSafeEqual`
   throws on a length mismatch, which would itself leak length.
3. **401, not 403**, with `WWW-Authenticate: Bearer` — the credential is missing or wrong,
   rather than a valid identity being denied a resource.

The shipper sends the same token and treats **401/503 as configuration faults**, naming
them explicitly instead of retrying silently forever. Its offset stays put either way, so
events are *held, not lost*, until the token is fixed.

Verified 2026-07-20 by curl: unset token → 503 on write / 200 on read; then with a token —
no header, wrong token, **same-length** wrong token, and wrong scheme all → 401; correct
token → 200 insert; `WWW-Authenticate` present.

**Still open:** rate limiting. Auth stops anonymous writes but not a valid-token client
flooding the endpoint; payload caps and idempotent upsert blunt it, volume does not.

## Deferred

- Query endpoints (aggregates for the dashboard) → own section once `07` starts.
- Rate limiting, API versioning path (`/v1`) — noted, not MVP.
- Structured request logging / observability → later.
