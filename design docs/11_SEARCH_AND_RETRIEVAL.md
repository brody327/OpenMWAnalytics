# 11 — Search & Retrieval (Phase 4b: hybrid search over the game corpus)

**Status: steps 1–6 BUILT 2026-07-26** (`api/src/corpus/`, branch `feat/corpus-ingest`) — parser,
chunking, embedding providers and the ingest job, 48 tests. Step 7 (index tuning + measurement)
and step 8 (dashboard view + synthetic seeding) are still undesigned.

⚠️ **Numbers below marked MEASURED replaced earlier estimates on 2026-07-26.** Several estimates
were wrong, and one design assumption (`record_id` as a natural key) was wrong — see §6a. The
corpus has NOT yet been embedded for real: the local database holds *fake* deterministic vectors,
which are searchable and meaningless. **No recall or ranking number is valid until a real run.**

Phase 4a (`07 §7`) ranked what the dashboard already knew. This phase adds a *second corpus* —
the game's own text — and joins it to telemetry. It is the AI-engineering thread and the
Postgres-performance thread in one, which is why it was sequenced ahead of the LLM layer (4c).

---

## 1. What it is for

Two use cases, both mod-developer questions, both settled 2026-07-25:

**A — the consistency search (author-facing, human-issued).**
> *"Is there already a proper noun for this? Does the base game already treat this theme, so my
> mod stays consistent with it?"*

Note this single question needs **both** halves of a hybrid system: a proper noun (`Addhiranirr`)
is a **lexical** lookup where embeddings are near-useless; a theme ("bribery") is a **semantic**
lookup where keywords fail. This is the clearest justification for hybrid we have, and it came
from the product side, not the engineering side.

**B — content recommendation for a skill check (machine-issued).**
> *"Players buff Personality with potions 40% of the time and enchanted gear 5% — what else in the
> game could serve this check, and where is it?"*

Feeds the design loop: the author places content to open a route players aren't using.

⚠️ **"Skill check" here includes ATTRIBUTE checks** — CCFF gates on Personality, which is an
attribute, not a skill. This matters because Morrowind's alchemy fortifies *attributes* and never
skills: **0 of 289 `ALCH` effects and 0 of 355 `INGR` effects target a skill**, so a
literal-minded reading of "skill" makes the potion route look impossible. It is not — potions and
ingredients are exactly how an attribute check gets buffed.

MEASURED coverage for Personality — all four vehicles participate, which is why `record_effects`
carries `affected_kind` (`'skill' | 'attribute'`) to disambiguate ids that collide across the two
enums:

| vehicle | Personality-targeting effects |
| --- | --- |
| `ALCH` potions | 12 |
| `INGR` ingredients | 18 |
| `SPEL` spells | 29 |
| `ENCH` enchantments | 27 |

The pre-filter returns **19 `Fortify` candidates** for Personality (Charisma, Lady's Favor,
Colovia's Grace, …). Note the filter must also read the effect **name**, not just its target:
`Drain Attribute` hits Personality too, in the opposite direction.

Across the whole corpus the effects table covers **35 distinct targets — all 8 attributes and all
27 skills.** Nothing about the schema privileges one check.

### What does NOT justify a vector

The test is: **is there a key that answers this?** If yes, join — do not reach for embeddings.

| question | key exists? | vector load-bearing? |
| --- | --- | --- |
| "what content belongs to the Titania case?" | ✅ id convention | ❌ it's a `LIKE` |
| "what's in the cell players visit most?" | ✅ `area` ↔ `CELL` | ❌ it's a join |
| "what content is about *bribing guards*?" | ❌ no such field | ✅ **only embeddings** |
| "content thematically like this report" | ❌ not a column | ✅ **only embeddings** |
| "similar content players never reach" | ❌ | ✅ **only embeddings** |

⚠️ **The tight product loop does not need embeddings.** "Show the evidence for the Titania
confrontation" is `WHERE record_id LIKE '%titania%'`. Recording this so the next session does not
re-derive it — and because being able to say *"I checked whether I needed the sophisticated tool"*
is the point of leading Phase 4 with ranking rather than ML (see `07 §7`).

---

## 2. The corpus — VERIFIED 2026-07-25

Extracted with `esmtool.exe dump -p` (ships with the OpenMW install, `H:\OpenMW 0.51.0\`).

| source | records | notable |
| --- | --- | --- |
| `Morrowind.esm` | **48,295 headers** | **23,693 `INFO`** (dialogue + journal), 2,788 `STAT`, 2,675 `NPC_`, 2,538 `CELL`, 2,358 `DIAL`, 1,449 `GMST`, 1,390 `LAND`, 1,194 `PGRD`, 990 `SPEL`, 708 `ENCH`, 574 `BOOK`, 137 `MGEF` |
| CCFF `.omwaddon` | ~500 | 226 `INFO`, 131 `ACTI`, 60 `DIAL`, 27 `BOOK`, 17 `CELL`, 13 `NPC_` |

~31 MB of extractable text, **zero synthetic content** — the same standard that killed
collaborative filtering (`10 §3.3`, [[project-search-ranking-ai-thread]]).

**Decision: index everything.** Most documents are searchable but *mute* (no telemetry attached).
Accepted deliberately — the volume is what makes the Postgres tuning real, and `00`'s "blocked on
volume, not capability" is the constraint this lifts.

**MEASURED 2026-07-26** — the earlier "~31,000 records / ~34,000 chunks" was close by luck; the
composition is different from what was assumed:

| | count | |
| --- | --- | --- |
| record headers | **48,295** | parse time ~245 ms |
| → indexable records | **34,810** | after dropping empties and containers |
| → skipped as empty | **11,127** | `LAND`, `PGRD`, `GMST`, `STAT`, unnamed exterior `CELL`s — no name, no prose |
| → `DIAL` containers | **2,358** | consumed as parser state, never emitted (§4a) |
| → **chunks** | **36,567** | 574 books expand to 2,356 chunks |
| effects | **2,960** | across `ALCH` / `SPEL` / `ENCH` / `INGR` |

The three counts reconcile exactly (`34,810 + 11,127 + 2,358 = 48,295`), and **that invariant is
a test.** It is what caught the id-less-header bug (§6a) — no individual record looked wrong.

---

## 3. Joins to telemetry — graded, not assumed

| telemetry field | joins to | quality |
| --- | --- | --- |
| `AreaEntered.area` | `CELL.name` (interior) / `REGN` id (exterior) | ✅ **exact** — **1,240 named cells indexed** (of 2,538; the rest are unnamed exterior tiles). ⚠️ These were all being *dropped* until §6a was fixed |
| buff source id from `ActiveSpell.id` (future `SkillCheckResolved`) | `SPEL` / `ALCH` / `ENCH` | ✅ **exact** — the best join in the project |
| `ConfrontationAttempted.suspect` | CCFF records by `*titania*` naming convention | ⚠️ **convention, not a contract** |
| `ConfrontationAttempted.topic` | — | ❌ **none** |

⚠️ **`topic` does not join.** `crime_scene` / `name_at_scene` appear **zero** times in CCFF's
plugin — they are pure Lua-side constructs. Verified by grep against the dump. This kills the
obvious idea of enriching the stuck-ranking's topic rows with game text.

⚠️ **`suspect` joins only by naming habit.** `titania` appears 25 times across `GLOB`
(`CCFF_Knows_TitaniaFrameFalse`), `ACTI` (`CCFF_blood_titania`, `CCFF_RoomID_TitaniaRoom`), and
`BOOK` (`ccff_titania_injury_report`) ids. It works, and **one record named
`ccff_evidence_ledger_07` breaks it silently.** Ship against it, but the clean fix is to have CCFF
put the record id on the wire — a declared key instead of an inferred one.

---

## 4. Grain — what a "document" is (step 1)

The unit of retrieval. Same rule as the friction rollup: **store at the finest grain that retains
the inputs; derive the coarse view. You can always aggregate up, never disaggregate down.**

An embedding is a **fixed-size array regardless of input length** — so a whole-book vector is the
*average* of everything the book discusses and sits close to none of it. That is collapsing past
the grain, and it is unrecoverable.

| record type | grain | why |
| --- | --- | --- |
| `INFO` dialogue (23,693) | whole record | 1–3 sentences; splitting shreds it |
| `CELL`, `NPC_`, `SPEL`, `ALCH`, items | whole record | text is thin by nature |
| `BOOK` (601 incl. CCFF) | **chunked**, paragraph-ish, `record_id` retained | the only long-form text |

Net = **36,567 chunks** (MEASURED; 574 books expand to 2,356). Embed fine, return coarse — the
pattern is called **parent-document retrieval** ("small-to-big"). Book-level results are a
`GROUP BY record_id`, and the aggregate is the knob:

| rollup | semantics |
| --- | --- |
| `MAX(chunk_score)` **(default)** | "any paragraph about it counts" |
| `AVG(chunk_score)` | "the book must be *substantially* about it" |

Chosen `MAX`; revisitable **without re-embedding**, which is the whole payoff of the fine grain.

---

## 5. Embeddings (step 2)

An embedding is a deterministic function: text → fixed-length float array, trained so that
semantically similar text lands at nearby coordinates. Similarity is **cosine** (angle, not
magnitude — so a long and a short document on the same topic still match).

⚠️ **This is the project's first genuinely un-inspectable component.** Dimension 417 means nothing;
you cannot explain a specific match or hand-tune it. The defence is **scope**: opacity is confined
to "is this text semantically related," which nothing inspectable can do at all. Everything around
it — filtering, fusion, the telemetry join — stays explicit. That is the answer to *"you argued
heuristic-over-model in 4a, why a model now?"*

### The decision

| | choice |
| --- | --- |
| provider | OpenAI `text-embedding-3-small` (**Anthropic has no embeddings endpoint**) |
| embed at | 1536 — **derived from the model, not configurable** (§8a) |
| production dims | **384**, truncated + **re-normalized** |
| cost | **MEASURED: ~$0.026 one-time** (~1.28 M tokens over 36,567 chunks, of which only **28,252 are unique text**); per-query negligible |
| escape hatch | `3-large` truncated to 384 if recall disappoints |
| lock-in | model change ⇒ **full re-embed + index rebuild**; vectors from different models are incomparable |

**23% of the corpus is exact-duplicate text** (repeated stock dialogue, plus records whose
`full_text` falls back to their name). Because the idempotency key is already a *content hash*,
de-duplicating before the API call is the same lookup — it removes ~8,300 inputs for free.
Content-addressing tends to pay twice like that.

**Cost is not a decision criterion here — memory is.** The whole corpus embeds for pennies. The
scarce resource is `shared_buffers` on a **`db.t3.micro`, 1 GB RAM, 20 GB storage**.

⚠️ **MEASURED against the live RDS instance 2026-07-26: `shared_buffers` = 185 MB, not the 256 MB
this section assumed** (25% of 1 GB was a guess; RDS's actual default formula gives less). Index
sizes were also measured, on the real 36,567-chunk corpus:

| | measured | earlier estimate |
| --- | --- | --- |
| raw vector column (36,567 × 384) | **54 MB** | 52 MB ✅ |
| HNSW index | **56 MB — ~1.04× the column** | "~1.25×", and "2×" in one session ❌ |
| GIN `tsv` index | **6 MB — 9.3× cheaper than HNSW** | "a few MB, an order of magnitude" ✅ |

HNSW is barely larger than the vectors it holds because at 384 dims each node's *data* (1,536
bytes) dwarfs its *graph links* (~32 neighbours × 6 bytes). The link overhead is ~4%, not 100%.

| dims | HNSW index | share of the **measured** 185 MB pool | verdict |
| --- | --- | --- | --- |
| 384 | **56 MB (measured)** | **30%** | comfortable |
| 768 | ~112 MB | 61% | viable, tight |
| 1536 | ~224 MB | **121%** — and the *raw column alone* is 113% | dead |

Note **20 GB of disk makes every option fit** — disk was never the constraint; residency is (§7).

⭐ **The decision survived being wrong twice, in opposite directions.** 384 wins under the
optimistic multiplier and the pessimistic one, under 256 MB and under 185 MB. A choice that only
holds if your estimates are right is a weaker choice than one robust to them being wrong.

**Why 384 is not a quality compromise:** modern embedding models are trained with **Matryoshka
representation learning** — leading dimensions carry the most information, so truncation degrades
*gracefully*. We get a strong model at a small footprint rather than a weak model.

**This also creates the step-7 experiment:** embed once at 1536, truncate to 1536/768/512/384 from
the same run, and measure `dims × index size × recall@10 × p95 latency`. Four cents buys the whole
table.

---

## 6. Schema (step 3a)

```
game_records        one row per record — the thing you RETURN
  record_id PK · source · type · name · full_text     ← ⚠️ NOT a clean natural key, see §6a

game_chunks         one row per embeddable unit — the thing you SEARCH
  chunk_id PK · record_id FK · ordinal · text
  embedding vector(384) · tsv tsvector
  text_hash · embedding_model · embedding_dims      ← see §7

record_effects      one row per magic effect — 1-to-MANY
  (record_id, ordinal) PK · effect_id · effect_name
  affected · affected_kind · magnitude_min/max · duration · range
```

### Why effects are relational, not JSONB

This is `06`'s JSONB-vs-columns debate returning, **and the answer is different this time.**

| | `events` | record effects |
| --- | --- | --- |
| schema defined by | any third-party mod, freely | the **engine** — `MGEF` is a fixed 137-entry set |
| new shapes at runtime? | yes — the whole point (zero DDL) | no |
| **cardinality** | one payload per row | **Skooma has 3 effects; spells have more** |
| query needed | `GROUP BY suspect, topic` | filter with a **range predicate** |

**Cardinality is the structural blocker.** A generated column is a function of *one row*; a
one-to-many needs repeating groups (`effect_1_*`, `effect_2_*`…) which fail at N+1. Generated
columns cannot rescue it — this is an expressibility ceiling, not a tuning issue.

⚠️ **The JSONB range-predicate trap**, recorded because it ships silently:

```sql
-- WRONG: the two clauses can match DIFFERENT array elements.
-- A potion fortifying Speechcraft by 5 AND Strength by 20 matches falsely.
WHERE effects @> '[{"skill":"speechcraft"}]' AND (effects->0->>'magnitude')::int >= 10
```

Correct requires `jsonb_path_exists(... '$[*] ? (@.skill == "speechcraft" && @.magnitude >= 10)')`
— which **GIN cannot index usefully**. Relational makes it boring:
`WHERE affected='speechcraft' AND magnitude_min>=10`, one btree, no false matches.

**Note the inversion:** a *new* effect type is a new **row** in a child table, but new **DDL** in
generated columns. The flexibility JSONB is usually chosen for is here better served by normalizing.

---

## 6a. ⚠️ The esmtool id is NOT a natural key — corrected 2026-07-26

§6 above says `record_id` is "esmtool's own id … a NATURAL key, deliberately." **That was wrong**,
and it failed in three distinct ways. All three were caught by a *constraint or a total*, never by
reading output — every individual record looked correct in each case.

| # | what | scale | resolution |
| --- | --- | --- | --- |
| 1 | **5,286 headers carry no id at all** — `Record: CELL ` with a trailing space (`SKIL` 27, `MGEF` 137, `CELL` 2,538, `LAND` 1,390, `PGRD` 1,194) | 11% of headers | accept id-less headers; synthesize `TYPE:name`, or `TYPE:index` for `SKIL`/`MGEF` |
| 2 | **`INFO` ids are unique only WITHIN a topic** — 99 repeat across topics, one pair of topics differing only in capitalisation | 99 collisions | key `INFO` as `topic#id`; resolves all 99 |
| 3 | **25 records genuinely share ids in the source** — 16 `CELL` groups where a town spans several same-named exterior cells (`Sadrith Mora` ×3), plus one `BSGN` | 25 | collapse last-wins, and **count it** |

**(1) was the dangerous one.** Requiring the quoted id meant those headers did not start a new
record, so their fields were silently folded into the **previous** record. It was found only
because `emitted + skipped + containers` did not equal the header count. Recovered by the fix:
**1,240 named `CELL`s** — the `AreaEntered.area` join target this document grades as the platform's
one exact join (§3) — plus 137 `MGEF` and 27 `SKIL` **descriptions**, real prose about what effects
and skills do.

**(3) is collapsed rather than disambiguated on purpose.** For a *search* corpus, "Sadrith Mora"
should be one result rather than three identical ones. But the count is reported, because a number
that grows means some new type started colliding for a reason nobody has looked at.

> **The transferable rule: when N things go in, assert that N things come out, classified.** Two
> separate bugs here — and the missing-`ENCH` bug in §6b — were invisible record-by-record and
> obvious the moment a total was reconciled. Both invariants are now tests.

## 6b. Having effects is enough to be content

`ENCH` records carry **no `Name:` and no prose** — only `Type`/`Cost`/`Charge` and their effects.
An initial "is this empty?" test of `(name || text)` therefore discarded **all 708 enchantments and
1,069 effects**, silently deleting the entire *enchanted gear* vehicle from §1's use case B.

It is also structural: `record_effects.record_id` is an FK to `game_records`, so **a record that
owns rows in a child table must exist however little text it has.** `full_text` falls back to the
record id to keep the `NOT NULL` column satisfiable.

Found by reconciling parsed effects (1,891) against effect lines in the dump (2,960).

---

## 7. Filtered vector search (step 3b) — where a `WHERE` fights an ANN index

**HNSW = Hierarchical Navigable Small World** — a layered proximity graph, structurally a skip
list in 384 dimensions: sparse top layer for big strides, dense lower layers for refinement,
greedy traversal. **It is a graph you walk**, which is why residency in `shared_buffers` matters:
traversal is a *pointer chase*, and on RDS every miss is a network round trip to EBS. A sequential
scan of a large index is survivable; a random-access walk through a non-resident one is not.

Two orderings that do not compose — a btree yields a **set**, HNSW yields a **ranked prefix**:

| strategy | behaviour |
| --- | --- |
| **post-filter** (vector → then `WHERE`) | ⚠️ **silently returns nothing** when the filter is selective. 30 matches in 34,000 = 0.09%; expected hits in a top-10 = `10 × 0.0009 = 0.009`. Returns `200 []` with 30 valid answers available |
| **pre-filter** (`WHERE` → exact KNN over survivors) | correct and complete, but the ANN index does nothing — fine over 30 rows, a full scan over 24,000 |

**Selectivity is the deciding variable** — the same quantity as seq-scan-vs-index-scan (`06`,
2026-07-21). Getting it wrong here yields *wrong results*, not merely slow ones.

### Decision

| query | strategy |
| --- | --- |
| **A — consistency search** (no filter, 34,000 chunks) | **HNSW.** This is the index's entire justification |
| **B — skill-check recommendation** (~30 records) | **pre-filter btree → exact KNN.** Not a compromise: exact KNN over 30 rows is strictly better than approximate |

> **The HNSW index exists to serve the human search box. The telemetry-driven recommendation path
> does not use it at all.** If use case A were dropped, the index would be dead weight consuming
> 25% of the buffer pool.

For middle-selectivity queries (none yet): **iterative index scans** (pgvector 0.8+, keeps pulling
until K rows pass the filter, capped by `hnsw.max_scan_tuples`) or a **partial index**
(`... WHERE type='ALCH'`).

✅ **VERIFIED on the live RDS instance 2026-07-26** (tested inside a transaction, then rolled back,
so production still carries only `plpgsql` until the migration deploys):

| check | result |
| --- | --- |
| parameter group permits `CREATE EXTENSION vector` | ✅ yes |
| pgvector version | **0.8.2** on RDS, 0.8.5 locally ⇒ **iterative index scans are available** |
| local dev image | `postgres:16` has no pgvector at all ⇒ switched to `pgvector/pgvector:pg16` |

⚠️ **`maintenance_work_mem` = 64 MB — MEASURED, and smaller than the 56 MB…65 MB index.** An HNSW
build that does not fit falls back to a two-phase on-disk path, paying the pointer-chase cost for
every node inserted rather than only at query time.

**Decision: do nothing until it is measured.** 36,567 rows is small; pre-tuning a parameter to
avoid an unmeasured cost is the same error as reaching for ML before a heuristic. If it ever
matters, raise it **session-scoped** (`SET maintenance_work_mem` before `CREATE INDEX`) and
**never in the parameter group** — autovacuum workers inherit it (`autovacuum_work_mem` defaults
to `-1`), so a group-wide 256 MB is a 768 MB ceiling across three workers on a 1 GB box, and an
OOM on RDS restarts Postgres. It is a *ceiling*, not a reservation: nothing is allocated until a
maintenance operation asks for it.

⚠️ **Also measured:** swapping the local image moved glibc 2.41 → 2.36, so every text btree was
built under different collation rules than it would now be searched under — silent wrong answers,
on the database step 7 benchmarks against. Fixed with `REINDEX DATABASE` + `REFRESH COLLATION
VERSION` (5 s). Same hazard shape as §8 and §9: two sides of a transformation that must agree.

---

## 8. Ingest pipeline (step 4)

### The constraint that decides the architecture

The corpus lives on the author's machine (`H:\Morrowind - OpenMW\Data Files`), `esmtool.exe` lives
in the OpenMW install, and **80 MB of copyrighted Bethesda `.esm` is not going into a container
image.** So ingest is **local-first** — the same topology as the shipper, for a different reason:

| | shipper | corpus ingest |
| --- | --- | --- |
| source | `openmw.log`, local only | `.esm`/`.omwaddon`, local only |
| why not remote | Lua sandbox has no network | game files can't leave the machine |
| bridge | local Node process → POST | local Node script → RDS |

Second time the project has hit "the data is trapped on the client." Treat as a pattern.

```
esmtool dump -p  →  parse  →  chunk  →  hash + diff  →  embed (batched)  →  upsert
```

⚠️ **`esmtool` has no structured output** — no JSON, no CSV (`--help`: `dump`/`clone`/`comp`,
`--raw`, `--type`, `--plain`, `--quiet`). We parse a human-readable debug dump with a state
machine, so **an `esmtool` formatting change in a future OpenMW release breaks it silently.**
Mitigation: a named, tested parser component with a fixture — not a regex buried in a script.

### Idempotency — and the trap

Re-running must not re-embed unchanged text. Key: `sha256(chunk text)`, same technique as
**migration baselining** (`09 §7`: record the hash, never `IF NOT EXISTS`). Match → skip; differ →
re-embed; absent → new; orphaned → delete.

⚠️ **THE TRAP: a text-only hash silently permits a model swap.** Change the embedding model, re-run,
and unchanged text is *skipped* — leaving `game_chunks` holding vectors from **two different models
in one column**. Distances between them are arbitrary. No error; queries return results; rankings
are quietly wrong.

> **An idempotency key must cover every input the cached output depends on — not just the one that
> is obviously "the data."**

The vector is a function of `(text, model, dims, truncation, normalization)`. Skip only when
`text_hash` **and** `embedding_model` **and** `embedding_dims` all match. A model change then
invalidates everything by construction — the loud, correct behaviour, and it costs four cents.

### 8a. The trap had a sibling — closed 2026-07-26

Writing the test for the above exposed a second instance one level down. The provider originally
took a `requestDims` option: the width asked of OpenAI *before* truncating. Embedding at 1536 and
truncating to 384 does **not** produce the same vector as embedding at 3072 and truncating to 384 —
yet both store `model='text-embedding-3-small', dims=384`. **Identical provenance, different
vectors**, and unlike a stored-width change the fixed-width `vector(384)` column cannot catch it
either.

**Fixed by deleting the knob, not by adding a fourth key column.** The request width is now derived
from the model (`NATIVE_DIMS`: `3-small → 1536`, `3-large → 3072`), which makes the vector a
function of exactly `(text, model, storedDims)` — precisely what the key covers.

The argument for removal rather than tracking: the only legitimate reason to change the request
width is changing models, **and a model change already invalidates the key**; requesting less than
the native width is strictly worse than truncating from it. Step 7's sweep is unaffected because it
truncates one set of stored 1536-dim vectors locally — it varies the **stored** width, never the
requested one. A column tracking a variable that no longer varies is schema guarding a footgun
instead of no footgun. Unknown models **throw at construction**; defaulting to 1536 would silently
change every vector a future model produced.

**Residual, stated rather than hidden:** the truncate/normalize transform is itself an input the key
does not cover. Change `truncateAndNormalize` and unchanged text is still skipped. The mitigation is
that it is *code, not configuration* — it cannot drift via an env var — plus a comment at that
function saying so, placed where someone would break it.

### 8b. Two more defences, both structural

- **`CHECK (embedding IS NULL) = (embedding_model IS NULL) = (embedding_dims IS NULL)`** — a vector
  whose provenance is unknown cannot exist. Verified: the constraint rejects the write.
- **`vector(384)` is fixed-width**, so a stored-width change is refused by Postgres regardless of
  whether the key noticed. Two independent defences, and the schema-level one does not depend on
  us getting the key right.

**This is the fourth instance of one failure mode in this project** (unverified migrations → prod
500; the `ORDER BY` output-alias sort returning *correct* results at ~2,000× cost; the staleness
metric that climbed forever while the cron was healthy; now the model swap). Standing hazard:
**anything that caches, skips, or short-circuits work needs its invalidation key audited against
every input.**

---

## 9. The lexical half (step 5)

`to_tsvector` runs a pipeline before storage: parse → lowercase → drop stopwords → **stem** →
record positions. Full-text search and embeddings fail in **opposite** directions, which is the
whole argument for running both:

| query | `tsvector` | embedding |
| --- | --- | --- |
| `Addhiranirr` | ✅ exact token | ❌ invented Dunmer name ≈ noise |
| `bribing guards` → *"the watch wants coin"* | ❌ no shared token | ✅ the entire point |

### `english` vs `simple` — measured, not assumed

Run against local Postgres 16, 2026-07-25:

```
english: 'balmora':4 'bribe':7 'demand':6 'guard':2                          (4 tokens)
simple:  'balmora':4 'bribes':7 'demanding':6 'guards':2 'of':3 'the':1 'were':5   (7)
```

`simple` produces **75% more tokens**, and the extras are `the`/`of`/`were` — pure cost. And the
feared damage to invented names **did not occur**: `balmora`, `dagoth`, `ur`, `sadrith`, `mora`
are byte-identical under both configs. **Decision: `english`.**

⚠️ **Gotchas, all verified against live output:**

- **`Ald'ruhn` splits into `ald` + `ruhn` — in BOTH configs.** The *parser* splits on the
  apostrophe, before any dictionary runs; no config choice prevents it.
- **`Sadrith Mora` is two tokens.** `tsvector` is a bag of words with positions; it has no concept
  of a multi-word name.
- **Rescue is on the query side, not the index side:** positions are adjacent, so
  `phraseto_tsquery('english','Sadrith Mora')` → `'sadrith' <-> 'mora'` (FOLLOWED BY) matches only
  where they are adjacent. Use `phraseto_tsquery` for proper nouns, `websearch_to_tsquery` for
  general queries.
- **The stemmer *does* fire on some names**: `Cosades` → `cosad` (reads `-es` as an inflection);
  `Gravius`/`Caius`/`Sellus` are untouched. **This is harmless because it is symmetric** — the
  query `Cosades` also stems to `cosad`.

> **Stemming does not need to be *correct*. It needs to be *symmetric*.** The real failure is
> **asymmetric** analysis — indexing with one config and querying with another gives zero results
> and no error. (Same hazard shape as §8's idempotency key: two sides of a transformation that
> must agree, and silence when they don't.)

The indexed form is lossy — `cosad` cannot be rendered back to `Cosades` — which is why
`game_records.full_text` exists separately for display.

**Index: GIN** (slower build, faster search; right side of the trade for a read-heavy corpus).
**MEASURED: 6 MB, against the HNSW index's 56 MB — 9.3× cheaper**, confirming the prediction. The
semantic half is the expensive half; know which one you are paying for.

---

## 10. Fusion (step 6) — Reciprocal Rank Fusion

Two ranked lists, incompatible units: `ts_rank` is an **unbounded** positive float; cosine is
bounded `[-1, 1]`. Every arithmetic combination fails:

| approach | failure |
| --- | --- |
| **add** | works by accident — relative influence is whatever the scales happened to be, and `ts_rank` has no ceiling so a term-stuffed document swamps cosine |
| **weighted sum** | needs per-query normalization, which **manufactures confidence**: a query where every result is bad still scales its top hit to 1.0. Plus α is an indefensible magic number |
| **multiply** | ⚠️ **turns OR into AND.** A semantic-only hit (`ts_rank = 0`) scores exactly zero and ranks last — annihilating the one thing the 65 MB index exists to find |

**The way out: stop comparing scores; compare positions.** Rank is scale-free by construction —
"3rd best lexically" and "3rd best semantically" are directly comparable without knowing either
scale.

$$\text{score}(d) = \sum_{\text{lists}} \frac{1}{k + \text{rank}_d}$$

**Reciprocal Rank Fusion** (Cormack et al., SIGIR 2009), `k = 60` the paper's empirical default.
Worked on the three-document example (A = both agree, B = semantic-only, C = lexical false friend):

| `k` | A | B | C | order |
| --- | --- | --- | --- | --- |
| 0 (naive `1/rank`) | 1.500 | 1.000 | 0.833 | A, B, C |
| **60** | 0.0325 | 0.0164 | 0.0320 | A, C, B |

**`k` is the same *shape* of knob as `m` in the shrinkage:**

| | `m` (4a) | `k` (RRF) |
| --- | --- | --- |
| low | trust this topic's own data | trust a single confident retriever |
| high | trust the global prior | require **agreement** between retrievers |
| units | attempts | ranks |

⚠️ **Be honest about the consequence:** at `k=60` RRF systematically **favours consensus** — a
document both retrievers merely like outranks one a single retriever loves. Usually right for
hybrid search (it suppresses each retriever's characteristic false positives), but it is a
*choice*, not an inheritance from a paper.

Why RRF suits this project: it never touches raw scores, needs no normalization, degrades to one
term for single-list hits, and is **explainable** — *"1st lexically, 2nd semantically"* renders in
the UI. The opaque component is confined to producing one ordering; the combiner is two lines with
one documented knob.

```sql
WITH lex AS (SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY ts_rank(...) DESC) AS r ...),
     vec AS (SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY embedding <=> $q) AS r ...)
SELECT chunk_id, COALESCE(1.0/(60+lex.r),0) + COALESCE(1.0/(60+vec.r),0) AS rrf
FROM lex FULL OUTER JOIN vec USING (chunk_id) ORDER BY rrf DESC LIMIT 10;
```

`FULL OUTER JOIN` is load-bearing — an `INNER JOIN` reintroduces multiplication's failure.

---

## 11. What is built, and what is next

### Built 2026-07-26 — `api/src/corpus/`, branch `feat/corpus-ingest`

| module | what |
| --- | --- |
| `parseEsmDump.ts` | pure string → records. `esmtool` has **no structured output**, so this parses a human-readable debug dump; the fixture test is the tripwire for a future OpenMW reformat |
| `chunk.ts` | grain + packing + `sha256` content hash |
| `embeddings.ts` | `EmbeddingProvider` interface, OpenAI over plain `fetch` (no SDK dependency), and a deterministic offline **fake** |
| `ingest.ts` | hash-diff upsert, dedup, orphan removal; embedding happens **outside** the transaction |
| `ingestCli.ts` | `npm run ingest-corpus -- <dump> <source> [--fake]` |

**48 tests.** Proven rather than asserted: re-running over unchanged text embeds *nothing*; a model
swap re-embeds everything and exactly one model may exist in the column; a shortened book drops its
tail chunks (the orphan a cascade cannot catch).

Measured, full corpus, fake provider, local Postgres: first run **48.2 s**, second run **2.7 s** with
36,567 chunks skipped and 0 embedded.

⚠️ **Format facts that differ from any reasonable assumption** — all verified, none guessed:
`INGR` effects use a *different shape* from `ALCH`/`SPEL`/`ENCH` (no `[N]` index, no magnitude,
sub-fields at the *same* indent ⇒ match by key, never by indentation) and print `Invalid (-1)` for
the unused `Skill`/`Attribute`; `INFO` ids are numeric hashes whose topic lives in the *preceding*
`DIAL`; `DIAL` is a container, consumed as state and never emitted; book text is a `START`/`END`
block of HTML-ish markup, and the corpus genuinely contains script comments like
`;Cell: Balmora, Council Club` — a field-shaped line inside a text block.

### Not yet done

- 🚨 **A real embedding run.** The database holds **fake** vectors: deterministic, searchable, and
  semantically meaningless. **Every recall, ranking and quality number is invalid until this runs**
  (~$0.026, needs `OPENAI_API_KEY`).
- **Step 7 — index tuning + measurement.** The dims sweep (`dims × index size × recall@10 × p95`),
  `hnsw.ef_search` / `m` / `ef_construction`, and how recall is measured at all — **exact KNN as
  ground truth**, i.e. what fraction of the true top-k the approximate index returned. This is the
  Postgres-performance payoff and the reason the phase was sequenced first. Blocked on the real run.
- **Step 8 — dashboard view + synthetic seeding** (see [[project-synthetic-data-policy]]:
  `env='synthetic'`, banner, never a truncate).
- **Deployment.** ✅ `CREATE EXTENSION vector` is permitted on RDS and lives in migration `0005`
  (`09 §7`'s initContainer). Ingest stays local by necessity — the `.esm` files cannot leave the
  machine — so **production's corpus is populated by running ingest against the RDS URL**, which is
  one env var away from the local run. The CLI prints its target host before doing anything.
