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

---

## Read side: the raw event feed (added 2026-07-23)

Two endpoints behind the event explorer (`07 §6`). Both are read-side and therefore **open**,
like `/stats/*`; only `POST /events` is authenticated.

### `GET /events`

Filters (all optional, all AND-ed): `mod_id`, `type`, `env`, `session_id`, plus the promoted
payload columns `suspect`, `topic`, `reason`. Time bounds `from`/`to` are **epoch ms on `ts`
(event time)**, matching the wire contract — the explorer answers *"what happened when"*, not
*"what did we ingest when"*.

**Payload filters are an ALLOW-LIST**, not arbitrary `data->>?`. An unindexed JSONB predicate
over 1M rows is a sequential scan per request; letting the caller choose the predicate makes the
endpoint's cost unbounded. A payload key becomes filterable by being *promoted to a column*
(`06 §3`), which is a deliberate act with a measurable cost, not a query-string parameter.

**Pagination is KEYSET (seek), not OFFSET.** Measured on 1M rows, both plans using the same
`events_feed_idx`:

| | rows read | time |
| --- | --- | --- |
| keyset page N | 50 | **~0.14 ms** |
| `LIMIT 50 OFFSET 500000` | **500,050** | ~218 ms (~1,500x, linear in offset) |

A B-tree has no rank statistic, so *there is no seeking to the Nth row* — an index cannot rescue
`OFFSET`. **The correctness argument matters more than the speed one:** `events` is append-only
and this feed is newest-first, so rows arrive at the top. `OFFSET` is anchored to a **count**,
which means something different between two page fetches — page 2 re-shows rows already seen. A
cursor is anchored to a **position**.

Contract details, each load-bearing:

- The cursor is the `(ts, session_id, seq)` tuple, base64'd and **opaque by design** — callers
  cannot do arithmetic on it, so the sort key stays changeable later.
- `(ts, session_id, seq)` is a **total order**. `ts` alone ties constantly, and a
  non-deterministic tie-break makes pages overlap or skip regardless of technique.
- The query fetches `limit + 1` to detect a further page, so there is **no `COUNT(*)`** over the
  filtered set — an exact total is the expensive half of pagination and an infinite feed needs none.
- `nextCursor: null` is an **explicit terminator**. Clients must not infer exhaustion from a short
  page, which is wrong whenever a page lands exactly on the boundary.
- An invalid cursor is **400**, not a silent page 1 — the latter restarts a feed from the top and
  reads to the user as duplicated data.

### `GET /mods`

The registry plus live event/session counts per mod. Counts are computed at read rather than
denormalised onto `mods`: it is a small indexed group-by, and a stored counter would need
maintaining on every ingest for a number nothing reads on the hot path.

### Envelope change: `mod_id`

`mod_id` is **optional** in the Zod envelope, making this an additive, backward-compatible change
— an older emitter that omits it still validates, which is why `v` stays `1` (see `02 §2a`).

It is **not** regex-validated in Zod. A malformed id normalises to `'unknown'` at ingest rather
than 400-ing the batch: the id is metadata about the event, and losing real telemetry over a bad
label is the worse failure — the same posture as `env` falling back to `'prod'`. The API
re-validates the format even though the Lua SDK already does, because the emitter runs inside
another author's mod; **the trust boundary is here, not there.**

Ingest also **auto-registers** every mod id in a batch (one upsert, deduped in JS), after the
event insert and deliberately outside it: the registry is derived convenience, and failing to
refresh a `last_seen_at` must never cost us events.
