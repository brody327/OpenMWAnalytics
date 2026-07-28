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

---

## `GET /search` — hybrid search over the game corpus (added 2026-07-26)

The first user-reachable path into Phase 4b's second corpus (`11`). Read-side and therefore
**open**, like `/stats/*` and `/events`.

```
GET /search?q=bribing%20the%20guards&limit=10
```

```jsonc
{
  "query": "bribing the guards",
  "mode": "hybrid",              // or "lexical" — see degradation below
  "took_ms": 606,
  "results": [{
    "record_id": "TG_BrotherBragor#273315646829231659",
    "type": "INFO", "name": "TG_BrotherBragor", "source": "Morrowind.esm",
    "snippet": "…Shadbak gra-Burbug, a guard in Fort Pelagiad, has been taking bribes…",
    "rrf_score": 0.0292,
    "lexical_rank": 3,           // null when that retriever did not return it
    "vector_rank": 15
  }]
}
```

`limit` is clamped to 50. A missing `q` is a `400`.

### Why the ranks are in the response

`lexical_rank` / `vector_rank` are not debug output — they are the reason RRF was chosen over a
weighted sum (`11 §10`). *"1st lexically, 15th semantically"* is an explanation a UI can render;
`0.0292` is not. The one opaque component (the embedding) is confined to producing **one
ordering**; everything downstream stays inspectable.

### ⚠️ This is the first endpoint that calls an external service

Every other endpoint is Postgres and nothing else. Three consequences:

| | |
| --- | --- |
| **Latency inverts** | embedding the query ≈ **1,100 ms**, the database work ≈ **2 ms**. Search is a *network* problem; no index tuning touches the dominant term. |
| **Availability** | a bounded in-process cache of query vectors (**~400 ms → ~40 ms** on a repeat) plus **degradation**: if the provider fails or no key is configured, the semantic half is dropped and the response says `"mode": "lexical"`. The lexical half is a complete search on its own, so failing the whole request would be wrong. |
| **Spend** | per-request cost where previously there was none. Bounded by the cache and by how many *distinct* queries users type. |

The cache is keyed by query text **alone**, which is correct only because the provider is fixed
for the process lifetime. If the model ever became per-request, that key would need the model in
it — the same trap as `11 §8`, one layer up.

### Query shape (see `11 §10` for the reasoning)

- `hnsw.ef_search = 80`, the measured value (`11 §10a`), set **inside a transaction** — `SET LOCAL`
  outside one is a warning and a silent no-op.
- `FULL OUTER JOIN` between the two ranked lists. **Load-bearing:** an `INNER JOIN` would require
  both retrievers to return a document, silently discarding semantic-only hits — the entire reason
  the 56 MB vector index exists. Verified live: one query returns a both-retrievers hit, a
  lexical-only hit and a semantic-only hit.
- **Parent-document rollup** (one row per record, best chunk wins) **and text dedup** — 23% of the
  corpus is exact-duplicate text, so without it the same stock line repeats under different ids.

### ⚠️ Known limitation, verified not hidden

Domain jargon does not always survive the embedding. The corpus contains
`"Fortify Attribute personality"` and ranks it **#1–3** for the query *"fortify personality"* — but
*"a potion that makes you more persuasive"* returns nothing relevant in the top 400.
`text-embedding-3-small` does not connect *persuasive* to *personality*; in Morrowind that is a
stat name, and the model reads it as the ordinary English word.

This is a **model** limitation, not a data one, and it is bounded: the flagship product question
("what content could serve this check") is answered by an **exact relational filter** over
`record_effects`, which never touches the vector index (`11 §7`). Only the fuzzy search box is
affected. Options if it ever matters: document expansion with domain synonyms, or `3-large`.

### Deployment gap

**Production has no `OPENAI_API_KEY`**, so `/search` there reports `"mode": "lexical"` until one is
added to the k8s Secret (`09 §2`).

---

## `GET /ops/freshness` + `POST /ops/heartbeat` — pipeline monitoring (added 2026-07-27)

Built after telemetry went **silently dark for six days** (`04`). The API was healthy throughout
and `/health` was right to be green — the failure was two hops upstream, in a process on a Windows
laptop.

| route | auth | purpose |
| --- | --- | --- |
| `POST /ops/heartbeat` | ✅ ingest token | the shipper saying "I am alive", with or without events |
| `GET /ops/freshness` | ❌ open, like `/stats/*` | **503** when any shipper is stale, 200 when all are current |

### ⚠️ Why this is NOT part of `/health`, and why that separation is load-bearing

`k8s/deployment.yaml` wires `/health` to **both** `livenessProbe` and `readinessProbe`. A non-200
there means *"restart this pod and pull it from the Service."* Folding staleness in would make
Kubernetes restart the API — repeatedly — for a condition it neither causes nor can fix. **A dead
shipper on a laptop would crashloop production**, an outage manufactured entirely by its own
monitoring.

> **Liveness asks "should this process be restarted?" Freshness asks "is the data trustworthy?"**
> They must never share a route, because exactly one of them has a destructive remediation wired to
> it.

Verified during the induced outage: `/ops/freshness` returned 503 while `/health` stayed 200 and
k8s did nothing.

### Why 503 rather than `200 {"ok":false}`

The consumer is a dumb external uptime monitor that understands status codes and nothing else. The
endpoint is not the monitoring — **the thing that polls it is** — and a checker nobody reads would
have missed the six-day outage exactly as completely as no checker at all.

### Design notes

- **An empty `shipper_state` returns 503, not 200.** "Nothing has ever checked in" is not healthy;
  greening on absent data is how a monitor silently monitors nothing.
- **A failure to *assess* freshness is also 503.** Returning 200 when the query throws would make a
  broken database read as a healthy pipeline — the exact failure this endpoint exists to remove.
- **`newest_event_at` is reported but never alerted on.** `max(received_at)` only advances when
  someone *plays*, so in a quiet period it grows without bound and a healthy pipeline looks broken
  (`frictionFoldState`'s lesson, one layer up). *"Is the shipper alive"* and *"is anyone playing"*
  are different questions; only the first is an outage.
- **Heartbeat is authenticated** because it writes. An open route would let anyone forge *"the
  pipeline is fine"* — the one lie that would defeat the whole mechanism.
- `install_id` is validated as a UUID (400 otherwise); `COALESCE` on update means a heartbeat that
  omits a field cannot **erase** a known one.

---

## `GET /stats/sufficiency` — Q3.6 mechanical sufficiency (added 2026-07-28)

Open, like the rest of `/stats/*`. Implemented in `api/src/stats/sufficiency.ts`; the judgement is
a pure `classifyGate()` split out from the handler, exactly as `ranking.ts` splits `rankTopics` —
a DB-free function is the part worth testing and showing.

**The only `/stats` route that leaves the telemetry database.** Every other view is a `GROUP BY`
over events and can only say *players are failing here*. This one joins what players **did**
(`SkillCheckResolved`) to what the game **contains** (`record_effects`, `11`), so it can say
whether the failure is even remediable — a gate with no remedy in the content is an authoring gap,
not a tuning one.

⭐ **Pure SQL, no model, deliberately.** Per the 4c plan this measurement must exist *before*
anything generative, because it **is** the "why not just a heuristic" answer. The question here is
*what is the number*, not *is this meaningful*, and a model adds nothing to the former.

### Response shape

One row per `check_id` + `threshold` — the grain a mod author actually acts on, since the remedy
you would author depends on the specific gate and its bar (per-`skill` would say "the game has
Personality potions", which is true of every Personality gate and therefore decides nothing).

| field | meaning |
| --- | --- |
| `gap_p50` / `gap_p90` | `threshold − skill_value` over **failed `inspect`** checks |
| `reliable` | Fortify effects with `magnitude_min >= gap_p90` — *"works every time"* |
| `possible` | Fortify effects with `magnitude_max >= gap_p90` — *"works on a good roll"* |
| `unknown_magnitude` | effects on the stat whose magnitude is **absent from the dump** (INGR) |
| `verdict` | `no_remedy` \| `gamble_only` \| `remedy_exists` |
| `reachable` | ⚠️ **always the literal `'UNKNOWN'`** — see below |

### ⚠️ The boundary this endpoint may not cross

It reports **mechanical** sufficiency — does an item exist whose magnitude covers the gap. It
cannot report **reachability**, because the corpus has no placement, value, vendor or leveled-list
data at all (`11 §13`). `reachable` is therefore emitted as `'UNKNOWN'` on every row and is **never
omitted**: absence must be *visible*, because this is the single place a downstream LLM would
fabricate most convincingly (*"sold by most apothecaries"*) — fluent, plausible, probably even true
of the real game, unverifiable from our data, and **indistinguishable from a computed fact**. Every
other failure this project has hit had a tell; that one has none.

### Why three tiers rather than one number

Collapsing them forces a lie in one direction, and the two lies point opposite ways:

| observed | `reliable` alone says | `possible` alone says | the truth |
| --- | --- | --- | --- |
| 0 reliable, 1 possible | "no remedy" → author content | "a remedy exists" → signpost it | passable **only by re-rolling** |

⭐ **Found on the first real run:** `security @ 25` returns `0 / 1`, because the only Fortify
Security effect in the entire corpus that reaches a 25-point gap is `Wild Fortify Security Skill`,
which rolls **5–30**. Everything else caps at 20, and there is **no ALCH remedy for Security at
all** — the base game has no Fortify Security potion. `shortblade @ 25` returns `0 / 0`: nothing in
the corpus closes it, which is the unambiguous *author-or-retune* verdict.

`unknown_magnitude` exists for the same reason: INGR effects print no magnitude, so those items
affect the stat by an amount we do not have. **Dropping them deletes evidence; counting them
asserts a magnitude we lack.** They are carried separately and can never change a verdict.

### Decisions behind the numbers

- **`max` is the headline predicate, not `min`.** Morrowind rolls a random magnitude in `[min,max]`
  on every use, so *"this gives you a shot"* is the game's own idiom — reporting only guarantees
  would describe a game this isn't. It also errs in the cheap direction: an undercount says *the
  content has no answer* and buys a weekend of authoring, while an overcount says *the answer
  exists, players aren't finding it* and buys an hour of hint dialogue.
- **p90, not `max(gap)`.** `max` is by construction an **n = 1** estimate — one under-levelled
  character who wandered into a late-game check defines it forever, with nothing pulling it back.
  Same disease `ranking.ts` treats with shrinkage; for a distribution the cure is a robust
  statistic. p90 rather than p50 because Q3.6's word is *accessible*, and an accessibility claim
  that holds only for the median failing player is not one.
- **`Fortify` only.** Restore refills *damaged* points and cannot lift a stat above base, so it can
  only close a gap for a damaged player — and `stat_damage` is emitted by **nothing**. Revisit when
  the `03` additive fields ship.
- **`affected_kind` is load-bearing in the join.** Skill and attribute ids collide across the two
  enums; joining on `affected` alone would credit a stat with another stat's remedies.
- **`gap <= 0` rows are excluded.** Failing while *meeting* the bar on the deciding stat (multi-stat
  AND, or a pass override) is a real but different problem, and including it drags every gap down.

### ⚠️ Known limitations — biasing the result, not hidden

- **`base_value` is emitted by nothing** (0 of 329,964 rows), though `03` designed it 2026-07-27.
  `skill_value` is the **modified** value, so a player who already drank a potion shows a smaller
  gap than their build has ⇒ **every gap here is biased low**, and remedies therefore look *more*
  sufficient than they are. This is the same caveat `10` already records against Q3.5/Q3.6.
- **No `env` filter**, matching every other `/stats` endpoint. Seeded rows carry `env='synthetic'`
  and currently dominate (329,932 of 329,964), so treat magnitudes as **shape, not finding**.
- ⚠️ **A seeder artefact is visible in the current data:** `security` `gap_p90` sticks at 30 while
  `threshold` climbs 40 → 50 → 60 → 100. Real players facing a 100 bar would show enormous gaps;
  the generator is drawing `skill_value` as `threshold − U(0,~30)`.
