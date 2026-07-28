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
| **cardinality** | one payload per row | **Skooma has 4 effects; spells have up to 8** |
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

✅ **MEASURED on prod RDS 2026-07-26 — and the deferral was right.** Building the index over the
real 36,567-row corpus, pgvector reported exactly what it did:

```
NOTICE:  hnsw graph no longer fits into maintenance_work_mem after 28368 tuples
DETAIL:  Building will take significantly more time.
```

**78% of the graph fit in 64 MB; the whole build still finished in 19.5 s.** So "significantly more
time" is nineteen seconds, once. Raising the parameter would have traded a real OOM hazard on a
1 GB instance for a saving of seconds on an operation that runs when the corpus changes. The
extrapolation, for the record: ~2.3 KB per node ⇒ the full graph wants ~82 MB.

> This is the value of deferring: the tuning question answered itself the moment there was data,
> and the answer was "don't."

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

## 10a. Step 7 — index tuning + measurement (MEASURED 2026-07-26)

Harness: `api/src/corpus/benchRecall.mts` (`npm run bench-recall`). 80 out-of-distribution queries,
`k = 10`, 36,567 chunks, real `text-embedding-3-small@384` vectors, local PG16.

### How recall is measured when the index is approximate by design

**Exact KNN is the ground truth.** Disable index scans, let Postgres brute-force the true top-k
over every vector — slow, but correct by definition. Run the same query through HNSW and take the
**set overlap**. No external label set is needed: the database can always tell you the right
answer, just expensively.

`recall@10` is a **set** metric, order-insensitive. That is the right choice here for a
non-obvious reason: **HNSW's approximation is in *which* items it finds, not how it orders them.**
Distances are computed exactly for every candidate, so the returned k are perfectly ranked among
themselves — a rank-aware metric (NDCG@10) would largely track recall and add nothing.

### The curve

| `ef_search` | recall@10 | buffers | p50 ms |
| --- | --- | --- | --- |
| 10 | 79.9% | 364 | ~5–8 |
| 20 | 84.6% | 523 | ~2.2 |
| **40** *(pgvector default)* | **89.3%** | 844 | ~2.6 |
| **80** ⭐ | **91.6%** | 1,362 | ~2.0 |
| 160 | 91.8% | 2,558 | ~2.4 |
| 320 | 92.6–93.3% | 4,452 | ~3.4 |
| **exact KNN** | 100% *(by definition)* | **41,509** | **27–34** |

**Recommendation: `hnsw.ef_search = 80`.** +2.3 points of recall over the default for 1.6× the
buffers, still **30× cheaper than exact**. Past 80 it flattens hard — 160 buys +0.2 points for 1.9×
the work. Not applied yet; it is a session/queryable GUC, so it belongs with the search endpoint.

**Recall never reaches 100%**, even at `ef_search = 320` (a candidate list ~1% of the corpus). The
greedy walk can settle in a region of the graph from which some true neighbours are unreachable,
and more candidates do not help if the traversal never goes there.

⚠️ **`ef_search = 10` with `k = 10` is structurally the worst case** (79.9%): pgvector clamps
`ef_search` to at least `k`, so the candidate list has **zero slack** — every candidate the walk
finds is returned, with no chance to evict a worse one for a better one discovered later.

### ⚠️ Trust buffers, not milliseconds

Across two identical runs, **buffer counts were bit-identical** while p50 swung up to 60% (5.18 →
8.19 ms at `ef_search=10`, which ran first and absorbed cache warming). At 1–5 ms, wall-clock is
noise. Buffers are deterministic work, are perfectly monotonic in `ef_search`, and are what
predicts **RDS** behaviour, where pages are not resident and each miss is a network round trip.

### The seq scan pays a cost the index skips entirely: TOAST

41,509 buffers for a "58 MB" table looked wrong, and was worth chasing. `game_chunks` is 58 MB heap
**plus 19 MB TOAST**; `embedding` has `avg_width` 1,071 (compressed from 1,544) and is stored
externally. So exact KNN reads ~7,400 heap pages **and then does a per-row detoast fetch for
~30,000 vectors**.

> HNSW stores vectors inside its own pages and the query projects only `chunk_id`, so the fast path
> **never detoasts at all.** The index is not merely touching fewer pages — it avoids an entire
> access pattern.

**Deliberately NOT tuned.** `ALTER COLUMN embedding SET STORAGE PLAIN` would eliminate the detoast,
but the only full scans are this benchmark's ground truth and use case B's ~30-row pre-filtered
path, where 30 detoasts are free. It would speed up nothing a user touches. Recorded, not actioned.

### ⚠️ Two methodology bugs, both of which produced clean, plausible, entirely fake tables

1. **Query vectors sampled FROM the indexed corpus.** A corpus point's true top-10 neighbours are
   precisely the nodes HNSW linked it to at build time, so the graph is asked to find the
   neighbours it was constructed from. Result: **100% recall at every `ef_search`**, including 10.
   Queries must be out-of-distribution.
2. **`SET LOCAL` outside a transaction block is a WARNING and a no-op.** So `enable_indexscan=off`
   never applied and neither did any `hnsw.ef_search`: all seven rows were the same query (HNSW at
   the default 40) compared against itself. The tell was **identical buffer counts across
   supposedly different plans**.

> The fix that generalises: **the harness now asserts which plan actually ran** (`Seq Scan` for
> ground truth, `hnsw` for the approximate path) and fails loudly otherwise. Measuring without
> checking what executed is how you get a confident table of numbers about nothing.

### Not done

- **The dims sweep** (`384 / 512 / 768 / 1536`). ⚠️ Doc §5 claimed one embedding run would cover it,
  but **ingest stores only the truncated 384** — the 1536-dim source is discarded. A sweep needs a
  bench table holding full-width vectors and a re-embed (~$0.026). **§10b below shows this is a
  structural block, not a scheduling one.**
- **`m` / `ef_construction`** — build-time parameters, so each value needs a full index rebuild.

---

## 10b. ⚠️ What the stored vectors CANNOT prove about Matryoshka (measured 2026-07-27)

Run as a hands-on re-teach of §5's truncation argument, and it corrected the argument instead.

**The hypothesis tested:** if information is "front-loaded," the *first* quarter of a stored vector
should out-rank the *last* quarter. Ground truth = exact-KNN top-10 over the full 384; the metric is
mean overlap@10 across randomly sampled queries, forced to a seq scan.

| slice (96 dims each) | mean overlap@10 vs full-384 |
| --- | --- |
| head, dims 1–96 | **6.07** |
| middle, dims 145–240 | **6.40** |
| tail, dims 289–384 | **6.35** |

**Controls ran before the result was interpreted** — the discipline of §10a's two fake tables:

| control | expected | measured |
| --- | --- | --- |
| `subvector(1,384)` vs full — identity | exactly 10.00 | **10.00** — the instrument is sound |
| first **8** dims only | badly degraded | **2.30** — the instrument *can* detect degradation |

So the tie is real. **Within the stored 384, position carries no importance gradient.**

Prefix-length sweep (the test that *should* have been written), 60 queries:

| prefix | overlap@10 |
| --- | --- |
| 384 (stored) | 10.00 |
| **192** | **7.62** — half the bytes, 76% of the ranking |
| 96 | 6.27 |
| 48 | 4.88 |
| 16 | 2.73 |

Graceful degradation, no cliff — which **justifies the 384 decision in §5**. But it does *not*
demonstrate Matryoshka, and conflating the two is the error worth recording:

| claim | MRL's actual promise? | this data |
| --- | --- | --- |
| a **prefix** is itself a usable embedding | **yes** — the loss is applied at nested prefix *lengths* (64/128/256/512…) | consistent, but not isolated |
| earlier dimensions individually beat later ones | **no** — never promised at sub-prefix granularity | **falsified** (head ≈ mid ≈ tail) |

⭐ **The methodological point: two hypotheses predict the prefix curve equally well** — "MRL
front-loads information" and "any N dims carry N/384 of the information." Nothing measurable from
stored data separates them; that needs a prefix beating a **non-prefix at equal width**, and every
width buildable here fails to show it. *An experiment only supports a claim if some outcome would
have refuted it* — the same family as §10a's benchmark-against-itself, except here the flaw was in
the experiment's design rather than its wiring.

✅ **Pipeline verified correct while investigating:** `embeddings.ts` requests the **native 1536**
(`NATIVE_DIMS`) and `truncateAndNormalize` takes `slice(0, 384)` + re-normalizes, exactly as §5 and
§7 describe. The finding is about the *concept*, not a defect.

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

- ✅ **Real embedding run DONE 2026-07-26** — 28,253 texts, 152 s, ~$0.026, `text-embedding-3-small`
  at 384 dims. Exactly one model in the column, 0 provenance violations. **The model-swap guard
  fired live**: every fake vector was invalidated by construction (`chunks skipped 0`).
- ✅ **Step 7 — `ef_search` curve MEASURED**, see §10a. ▶ Remaining: the dims sweep (needs a bench
  table + re-embed, because ingest discards the 1536-dim source) and `m` / `ef_construction`.
- ✅ **Step 8 — dashboard view DONE 2026-07-27, LIVE at `omwanalytics.com/search`.** Four UI
  decisions with their rejected alternatives are recorded in `07 §8`; the prod deploy failures that
  stood between the merge and a reachable endpoint are in `09`.
  ⚠️ **The dedupe note above was WRONG** — duplicate text was never a UI problem. It is already
  handled server-side in `search.ts` by `ROW_NUMBER() OVER (PARTITION BY c.text_hash)` with
  `rn_text = 1`, alongside the parent rollup on `record_id`. Verified: 185 chunks carry the literal
  text `Chest`; a search for `chest` returns exactly one.
  ▶ **Synthetic seeding is NOT done** and was not needed for this view — the corpus is real data,
  so the search page has nothing to seed. It remains open for the *telemetry* views.
- ✅ **`hnsw.ef_search = 80` APPLIED** at the search endpoint (`search.ts`, `EF_SEARCH`), inside an
  explicit transaction because `SET LOCAL` outside one is a silent no-op (§10a).
- ✅ **DEPLOYED AND POPULATED 2026-07-26.** Migration `0005` applied via the `09 §7` initContainer
  on a `kubectl rollout restart` (pgvector 0.8.2 installed, three tables created, 6 migrations
  recorded). Prod now holds **34,785 records / 36,567 chunks / 2,960 effects**, one embedding model,
  index sizes identical to local (56 MB HNSW, 6 MB GIN).

  **How, and why it is awkward by design:** ingest must run locally (the `.esm` files cannot leave
  the machine) but **RDS is not publicly reachable** — its endpoint resolves to a private VPC
  address. So the run goes through an **SSH tunnel via the EC2 box**:

  ```
  ssh -i omwa-key.pem -N -L 15432:omwa-db.<id>.us-east-2.rds.amazonaws.com:5432 ubuntu@<eip>
  DATABASE_SSL=true DATABASE_URL=postgresql://omwa:<pw>@localhost:15432/omwanalytics \
    npm run ingest-corpus -- <dump> Morrowind.esm
  ```

  171 s end to end — only ~19 s slower than the local run despite the tunnel. Prod re-embedded from
  scratch (~$0.026) because its `game_chunks` was empty: correct by construction, not waste.

  ⚠️ **Bulk-load order matters and this was the one free moment to get it right.** The HNSW index
  was **dropped before the load and rebuilt after** — safe only because the table was empty and
  nothing queried it yet. Inserting 36,567 vectors into a live HNSW index would have paid graph
  maintenance per row. Load-then-index is the standard pattern; here it also produced the
  `maintenance_work_mem` measurement in §7.

---

## 12. ⚠️ The test fixture overwrote real corpus records (found + fixed 2026-07-27)

**The best bug this project has produced**, because of how it was caught and how long it hid.

### What happened

`ingest.test.ts` built its fixture from **real record ids** — `potion_skooma_01`,
`BookSkill_Enchant1` — for realism. `record_id` is the primary key, so every `npm test` against the
dev database **upserted the fixture over the genuine records**: Skooma's four real effects were
replaced by the two the fixture models, and its `source` flipped to `test.fixture`.

| | |
| --- | --- |
| blast radius | **2 records of 34,785** · **4 effects of 2,960** (0.006%) |
| duration undetected | ~1 day, across a merge, a deploy, and two full doc passes |
| how it surfaced | **a contradiction between two independent observations** |

### How it was caught — and why nothing else could have

A player drank Skooma in-game and gained **+20 Strength** (`SkillCheckResolved.stat_modifier`,
`base_value` 20 → `skill_value` 40). The corpus insisted Skooma does not affect Strength at all.
Both sources were internally consistent; only *against each other* was either wrong.

Nothing in the existing checks could have found it:

| existing check | why it passed |
| --- | --- |
| 48 unit tests | the fixture was self-consistent — it defines the very rows it asserts |
| parser conservation (`emitted + skipped == headers`) | the parser was **correct**; re-run today it yields all 4 effects |
| effect-count distribution | ALCH reaches 6, ENCH 8 — no truncation signature to see |
| idempotency / provenance guards | the row existed, with one model, one source |

⭐ **Every conservation check in this project lived INSIDE a stage. Nothing verified the stage
BOUNDARY that actually persists** — that what reached Postgres matched the `.esm`. The rule was
already written down (*"when N things go in, assert N come out"*); it had simply never been pointed
at the database.

### The two fixes

**1. `npm run verify-corpus -- <dump> <source>`** (`verifyCorpus.mts`) — re-parses the dump and
reconciles it against the database, classifying every discrepancy (missing / extra / fewer effects
/ more effects) and **exiting non-zero** so it can gate a release. It found the bug in seconds:

```
records missing from db  2
    bookskill_enchant1
    potion_skooma_01
```

**2. Fixture ids are now `fixture_*`, which is a correctness requirement, not a naming preference.**
The 07-26 source-scoping fix stopped the tests *deleting* real data; it could never stop them
*overwriting* it, because **a shared primary key does not care about the `source` column.** Realistic
test data sharing a keyspace with real data is the hazard; fake ids close it.

⚠️ **Two `npm test` runs during 2026-07-27's other work re-stamped the fixture over the real rows.**
The contamination was not a one-off — it recurred on every test run, silently, and would have kept
recurring.

### Verified after the fix

```
records   dump=34785  db=34785
effects   dump=2960   db=2960
✅ database matches the dump
```

Re-ingest took **4.5 s** and re-embedded **14 chunks** — the hash-diff means repairing the corpus
costs almost nothing, which is itself an argument for running `verify-corpus` routinely.

Skooma now reads `Fortify Speed 20 · Fortify Strength 20 · Drain Agility 20 · Drain Intelligence 20`,
matching the in-game verification exactly. The full attribution join then confirms the telemetry:
`skill_value - base_value = 20` equals the Fortify Strength magnitude, so the item that caused the
pass is identified from two independent observations rather than inferred.

⚠️ **Doc correction:** §6's table said *"Skooma has 3 effects"*. Earlier on 2026-07-27 that was
"corrected" to **2** to match the database — moving the doc *further* from the truth, because the
database was the thing that was wrong. It is **4**. Trusting data over a doc is usually right; it
is only right when the data has been verified against its source.

---

## 13. World placement survey — DESIGNED 2026-07-27 (spike run, not yet built)

The corpus knows what items **exist**. It does not know where they **are**, and `10 Q3.6` ("does the
game contain an *accessible* remedy for this gate?") rests entirely on the word *accessible*.

### Why survey the RUNNING GAME rather than parse more `.esm` files

The obvious fix — ingest Tribunal, Bloodmoon and the rest — is worse on three counts:

| | `.esm` parsing | `world.cells` survey |
| --- | --- | --- |
| **load order** | we would have to reimplement Morrowind's override semantics across 12+ files | ✅ **the engine has already merged it** |
| **placement** | not in `esmtool`'s formatted dump at all (`--raw` subrecords only) | ✅ exact, per cell |
| **mod content** | each plugin ingested separately, ids colliding across sources | ✅ included automatically |

⚠️ **CORRECTED 2026-07-27, same day — the first version of this section was WRONG.** It argued
from "the running world has 11,553 cells vs ~3,900 in `Morrowind.esm`, so two-thirds of the world
is missing." **That framing does not survive the learner's objection:**

> *"This is a website measuring specific mods — not my entire load order. Base game and its
> expansions are a stable base that will always be there; my load order is not stable."*

Correct, and decisive. The corpus exists to describe **the base every author shares**, plus the
**one mod being measured**. Measured breakdown:

| source | cells | ALCH |
| --- | --- | --- |
| `Morrowind.esm` | 2,538 | 258 |
| `Tribunal.esm` | 121 | 6 |
| `Bloodmoon.esm` | 276 | 2 |
| **stable base** | **2,935** | **266** |
| *running game (one author's load order)* | *11,553* | — |

So the real gap is **397 cells and 8 potions** (13% / 3%), not two-thirds. The other ~8,600 cells
are one person's personal mods and belong nowhere near a shared corpus. ▶ **Ingest Tribunal and
Bloodmoon; ignore everything else.**

⚠️ **And this exposes a flaw in the survey itself: Lua cannot report an object's PROVENANCE.**
`recordId` carries no source file, so a survey run on an author's normal setup would silently bake
their personal mods' placements into a corpus meant to describe the shared base — the fixture bug's
shape again, data from one context contaminating a dataset meant for another.
**Therefore the survey is a BUILD STEP against a CONTROLLED load order** (base + expansions + the
measured mod, nothing else), not a capture of a play session. Load order matters here because it
must be *controlled*, not because it should be *recorded*.

✅ **RESOLVED 2026-07-27 — see §14. Option A: `record_id` stays the PK, ingest became an ordered
merge, and `source` means "the file that won."**

~~⚠️ **Blocked on a schema decision.**~~ `game_records`' primary key is `record_id` **alone**, not
`(source, record_id)`. Where Tribunal overrides a Morrowind record they collide: the later ingest
silently wins and flips `source`. That is arguably correct load-order semantics, but it breaks
`verify-corpus`, which reconciles per source — overridden records would read as "missing from
Morrowind.esm". **A shared primary key does not care about the source column** (§12, third instance
in one day). Decide deliberately: either the PK becomes `(source, record_id)` with resolution at
query time, or ingest is explicitly ordered and `source` means *"the file that won."*

✅ **Confirmed while measuring:** `potion_skooma_01` is defined **only** in `Morrowind.esm` — no
Tribunal or Bloodmoon override. §12's bug was entirely the test fixture; load order was never
involved, and it was reached for twice.

This is the **third** time this project has hit the same shape: the data is trapped on the client, so
ship the computation to the data (`04` shipper, `11 §8` local-first ingest, now this).

### MEASURED — spike, 2026-07-27

| measure | value |
| --- | --- |
| cells | **11,553** |
| cell sweep | ~0.28 ms/cell (3 × `getAll`) → **~3.2 s** full |
| containers | ~19.4/cell → **~224,000** |
| container probe | ~0.005 ms each → **~1.1 s** full |
| **full survey** | **~4–5 s**, batched across frames |
| loose potions | ~55 per 60 cells → **~10,600** |
| ingredients | ~219 per 60 cells → **~42,000** |

**Off-cell reads WORK.** 60 cells probed with the player in none of them: **0 errors**. Container
contents likewise — **400 distant containers, 216 non-empty (54%), 0 failures**.

⭐ **The discriminating check was the comparison, not the probe.** v1 sampled ONE container, got
`ok, items=0`, and that result was worthless — it was a *mushroom* (`types.Container` includes
harvestable flora), and an empty mushroom looks identical whether off-cell contents are readable or
not. v2 compared **400 distant containers against the player's own definitely-loaded cell**
(54% vs 12% non-empty). Distant containers being *more* populated is a result that could not occur
if off-cell reads were degraded. *A probe that cannot distinguish the failure it tests for is not a
probe.*

⚠️ **Sample bias, recorded:** every example returned `egg_kwama00=1` — the first 60 entries in
`world.cells` are exteriors, so the sample is flora-dominated and no **chest** was specifically
read. The API is type-agnostic so the risk is low, but the sample was not representative.

### Scope — merchant inventories are OUT, deliberately

`Cell:getAll` finds containers, not NPC inventories, so *"does a trader sell one"* is unanswered.
**Excluded on purpose (learner's call):** merchant stock is leveled-list RNG that restocks on a
timer — it is not a stable surface a designer can reason about. The question this feature serves is
**bespoke placement**: *"should I put a Fortify Personality item in the estate?"* Shop inventory is
a different question with a different (and much noisier) answer.

### Grain — `(area, item_record_id, count)`, never one row per object

~10,600 potions + ~42,000 ingredients + ~155,000 container items ≈ **200,000 placements**. Emitting
one line per object instance would be the retired-`Heartbeat` mistake at 200× the scale.

The question is *"where can this item be found"*, so the grain is a **`GROUP BY`** — collapsing
~200k instances to an estimated 20–30k rows, computed in Lua before anything is written.

⭐ **The area key MUST match `AreaEntered`'s convention** (`03`): interior → `cell.name`, exterior →
`cell.region`. This is the whole payoff — telemetry says *where players fail*, placement says *where
the remedy is*, and they only join if both use the same notion of "area". Using raw cell ids here
would produce a table that is correct and useless.

### Transport — corpus data, NOT telemetry

⚠️ **This must never go through the event pipeline.** It describes the *world*, not a player's
behaviour; in `events` it would bloat storage and pollute every sequence query — exactly why `03`
retired `Heartbeat` and why `06`'s `shipper_state` is a table rather than a stream.

Same topology as the esmtool dump: a one-shot survey prints to `openmw.log` behind a sentinel that
is deliberately **not** `OMWA1 ` (the shipper greps for that, so survey lines are invisible to it), a
local extractor lifts them into a manifest, and the existing ingest CLI loads them
`source='world-survey'` — local-first, because the world is on the author's machine.

### ▶ Still to decide before building

- table shape (`item_placements`: area, item_record_id, count, is_exterior, source)
- ⚠️ **case**: `recordId` from Lua is **lowercase**; corpus ids are mixed-case. Join on
  `lower(record_id)` or 12 of 353 consumables silently vanish (`03 ItemConsumed`)
- whether the survey is one-shot manual or re-runnable per load order change
- how a stale survey is detected — the world changes when the load order does, and a placement
  table that silently describes an old load order is the same class of bug as `§12`

---

## 14. Multi-plugin corpus — the ordered merge (BUILT 2026-07-27)

### The decision

`game_records.record_id` stays the **primary key alone**. `source` is a **label meaning "the file
that won"**, not a namespace. The corpus therefore holds **one row per game object, in its effective
state** — the game as played.

**Why not `(source, record_id)`:** this is a *search index*. Two rows for one object means a query
can return the superseded version — a pre-patch item description competing with the patched one,
ranked by relevance, with nothing marking it stale. It would also duplicate embeddings and HNSW
entries for rows that must never surface. Provenance is worth less than correctness here, and
nothing in `10`'s question inventory asks which file defined a record.

### The consequence: ingest is a MERGE, and a single plugin is REFUSED

Last-wins across sources makes a single-file run **destructive and silent**: re-ingesting
`Morrowind.esm` alone re-asserts its text over every Tribunal and Bloodmoon override, with no error
and no count. So `ingest-corpus` now takes the whole load order, earliest first, and **refuses one
plugin** unless `--single` states the intent:

```
npm run ingest-corpus -- mw.txt Morrowind.esm tri.txt Tribunal.esm bm.txt Bloodmoon.esm
```

⭐ **Refuses rather than warns.** A warning printed over a destructive default is a warning nobody
reads twice.

### An ordering detail that was load-bearing and undocumented

Overriding a record that got **shorter** (a book of 6 chunks replaced by one of 3) leaves chunks
`#3–#5` orphaned — the parent still exists, so the FK cascade cannot catch them. They are removed
only because **the record upsert runs BEFORE the orphan sweep**, flipping `source` first and thus
pulling the stale chunks into the source-scoped sweep's candidate set.

Had the sweep run first, those chunks would have survived as **stale searchable text with live
embeddings**, attached to a record whose content no longer contains them. Correct today, by an
ordering that nothing asserted. Recorded here because it is invisible in the code.

### MEASURED — the merge, 2026-07-27

| | before (Morrowind only) | after (base + expansions) |
| --- | --- | --- |
| records | 34,785 | **45,209** |
| chunks | 36,567 | **47,130** |
| effects | 2,960 | **3,446** |
| overrides applied | — | **5,681** |

Run time **57 s**, ~8,350 new embeddings (~**$0.008**). Morrowind re-ingested with **0 chunks
written** — the hash-diff correctly recognised it as unchanged.

⭐ **5,681 overrides is far more than the ~397 cells predicted, and spot-checking explains it:
expansions re-serialise the dialogue topics they touch.** A sampled `INFO` record was **byte-
identical** across `Morrowind.esm` and `Tribunal.esm` — same id, prev/next pointers, text, actor and
script. So most "overrides" change nothing but the label. Verified rather than assumed, because
2,719 base dialogue records changing owner is exactly what a silent id-collision would also look
like.

### `verify-corpus` had to change too — and it caught itself

The first version reconciled **one plugin against a per-source `WHERE`**, and after the merge it
reported **3,189 false discrepancies**: every overridden record read as "missing from Morrowind.esm"
while being present and correct. It now replays the merge in load order and verifies the
**effective** state, scoped to the plugins under test so an unrelated source (a mod's plugin, the
test fixture) is never mistaken for corruption.

```
merged: 45,209 records, 5,681 overrides
records 45209=45209 · effects 3446=3446 · ✅ database matches the dump
```

⚠️ **The tool that exists to catch silent corruption was itself silently wrong for one run.** It
failed loudly, which is why it took minutes rather than a day — the same argument as exiting
non-zero.

### ▶ Not done

- **Prod still holds Morrowind-only** (34,785 records). Needs the same ordered merge through the RDS
  tunnel.
- CCFF's own `.omwaddon` is still not ingested — it is the *measured mod*, so it belongs at the end
  of the load order.
