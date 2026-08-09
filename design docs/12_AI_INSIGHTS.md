# 12 — AI Insights (Phase 4c)

The last phase, and the one with the least code in it. That is the design.

Everything a query can answer **is** answered by a query. The model is left with one question, and
the interesting engineering is not the prompt — it is the machinery that decides whether what the
model produced is allowed to exist.

---

## 1. Why a model at all — the question this phase had to answer first

The 4c plan (07-27) required the *"why not just a heuristic"* answer to exist **before** anything
generative was built. It does: `/stats/sufficiency` (Q3.6) is pure SQL and answers whether the game
contains a remedy for a gate. Six candidate "insights" were assessed on 07-28 and **all six turned
out to be SQL joins** — they argued *against* a model, not for one.

The learner's own criterion became the spec:

> *The LLM earns its keep only where the comparison is against something written in prose, or where
> the interesting question is "is this meaningful" rather than "what is the number."*

Exactly one question in the inventory survives that test:

> **A gate is failing hard. A remedy exists and closes the gap. Does the game's own text ever point
> a player at it?**

`tsvector` and HNSW can *retrieve* dialogue that mentions a Fortify Personality ring. Deciding
whether a given line actually **signposts** it for this gate is a judgement about prose. It also
turns `remedy_exists` from a dead end into an action: *the content is fine, the discoverability
isn't.*

### What this buys that a heuristic cannot

| Verdict | Author's next move |
| --- | --- |
| `no_remedy` | Write content, or retune the gate |
| `gamble_only` | The gate is a dice roll — retune, or accept it |
| `remedy_exists` + `NOT_SIGNPOSTED` | **The content already exists. Write one hint line.** |
| `remedy_exists` + `SIGNPOSTED` | Players are being told and still failing — look elsewhere |

Only the model can split the last two, and they lead to opposite work.

---

## 2. The pipeline

```
queryGates()        SQL      which gate, how big the shortfall, how many failures
queryRemedies()     SQL      which records close it, named, with magnitudes
searchCorpus()      hybrid   what the game's own text says (two passes, §5)
provider.generate() MODEL    ONE judgement, one bounded call, no tools, no loop
validateInsight()   pure     may this be published at all
insert                       stored as `pending` — a human decides if it ships
```

**Four of the six steps are queries.** That ratio is the argument for the phase, and it is worth
being able to say out loud in an interview.

"Bounded" means three specific things, not "short":

1. **Fixed evidence.** The model receives exactly what the queries produced. There are no tools on
   the call — it cannot fetch, search, or ask for more.
2. **Constrained output.** Structured outputs (`output_config.format`) pin the fields and the
   three-value `signposting` enum. The enum matters more than it looks: given a free-text verdict
   the model writes a fourth, hedged answer, and `UNCLEAR` stops being the honest choice and
   becomes the only one on offer.
3. **One call.** No agent, no retry-with-more-context, no self-critique pass.

---

## 3. ⭐ The guards — decided before the prompt was written

Every other failure this project has hit had a tell. A fixture overwrote real corpus rows and the
contradiction surfaced in-game; a stale pod served old code and a new route 404'd; an inverted
boolean made every exterior area match `%region%`.

**A fabricated LLM claim has no tell.** *"Most apothecaries stock them"* renders in the same font,
the same register and the same confident tone as a computed fact, and it is very likely true of the
real game — it is simply not something *our data says*. Human review cannot reliably catch that,
because a reviewer reading a plausible sentence has no signal to react to.

So the guard is mechanical, and it runs **before a human ever sees the text**. A rejected insight is
never rendered, never stored, and never gets the chance to look right.

| Guard | Mechanism | Why it can't be walked past |
| --- | --- | --- |
| **Number whitelist** | every integer in the output must appear in the serialised evidence | a hallucinated `+15 Personality` contains `15`; if `15` is nowhere in the payload it was invented |
| **Citation membership** | every cited `record_id` must be one we supplied | set membership — there is no way to be *plausibly* wrong |
| **No reachability claims** | a term list (`apothecary`, `buy`, `sold`, …) that **cannot reach the model from the evidence** | the payload is numbers, record names and game prose; if the word appears, the model supplied it |

### The load-bearing consequence nobody would guess

`/stats/sufficiency`'s `PLACEMENT_NOTE` contains the words *"merchant"* and *"buy"*. It must
therefore **never** be included in the evidence payload — doing so would put the reachability
vocabulary in reach and silently defeat guard 3. The note is rendered in the UI beside the insight
instead, which is where a caveat belongs anyway.

### What the guards do NOT do — stated so nobody mistakes them for a proof

They bound the model to the **vocabulary and numbers of the evidence**. They cannot check that a
sentence is a correct *inference* from that evidence. A model that says "this gate is trivially
easy" about a brutal gate uses only whitelisted numbers and cited records and passes everything.

**They close the fabrication hole, not the reasoning hole.** The reasoning hole is what human review
is actually for — and a reviewer *can* catch a bad inference, because the evidence sits next to the
claim. `validate.test.ts` contains a test that asserts this boundary (a whitelisted number used
wrongly still passes) specifically so the suite cannot be read as proving more than it does.

---

## 4. Human review is a state transition, not a hope

Résumé bullet 5 says *"bounded prompts + human review"*. That is only a true claim if unreviewed
output **cannot reach a reader**.

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /insights/generate` | ✅ | costs money and writes a row; lands `pending` |
| `GET /insights` | public | `status = 'approved'` **in SQL** |
| `GET /insights/review` | ✅ | the pending queue — **plus the stored evidence** |
| `POST /insights/:id/review` | ✅ | `pending → approved \| rejected`, once |

Two decisions carry the claim:

- **The public route has no `status` parameter.** A safe default would be a suggestion;
  `?status=pending` would make review decorative for anyone who reads a URL bar.
- **The review route returns the evidence and the public route does not.** A reviewer cannot judge
  "is this a correct inference?" without the exact payload the model saw — and that payload is the
  one thing the mechanical guards cannot check for them.

**A rejected insight leaves no row.** Not stored-as-rejected, not kept for audit. An insight in the
table is a thing a reviewer can approve, and a fabricated claim sitting one UI click from
`approved` is the failure this phase was designed around.

The evidence is stored **verbatim** on each row because telemetry accumulates and the corpus gets
re-ingested — a later re-derivation would show a reviewer different evidence than the claim was made
against, and they would be reviewing a different claim.

---

## 5. ⚠️ Two things only RUNNING it found

Both were invisible to a green test suite, and both are the same shape as the `type='SPEL'` bug of
07-28: *a query that computes what it was told, over rows that do not mean what it assumed.*

**1. The "passages" were the remedies.** The first real evidence payload for `ccff_j_mortar:force`
came back with eight passages that were all Fortify Security *effect definitions* — including the
remedy's own record. The prompt would have asked whether an item's own description signposts that
item. Nothing was broken: `searchCorpus` returned genuinely relevant hits, the payload validated,
every test stayed green. Fixed by filtering to `INFO` (32,088 dialogue records) and `BOOK` (881) —
the only two surfaces a mod author can actually edit to signpost something.

**2. Filtering then returned zero.** The semantic neighbourhood of a Fortify effect *name* is other
Fortify effects. Retrieval is now **two passes**:

| Pass | Query | Why it cannot be dropped |
| --- | --- | --- |
| situational | *"how can I improve my `{stat}`, or get help passing a difficult `{stat}` check"* | only this makes `NOT_SIGNPOSTED` fair — without context, "no passage names the ring" is indistinguishable from "we searched for the wrong thing" |
| by name | the remedy names | only this can produce `SIGNPOSTED` — signposting means the text points at a *specific* thing |

They are **interleaved**, not concatenated: taking pass 1 first and truncating at 8 would drop pass
2 entirely on any stat with plentiful dialogue, silently restoring the single-pass bias.

This is the second real use of the HNSW index, and the one that justifies having built it — the
`"guards demanding bribes"` vs `"the watch wanted coin"` case (11 §9) pointed at a real question
instead of a smoke test.

---

## 6. ⭐⭐ The gate grain — `check_id` is not a key

Found by rendering the dashboard, not by a test.

`ccff_j_mortar:force` is **sixteen gates**: security@25, @30, @35, @40, @50, @60, @100, plus
alchemy, acrobatics, alteration, mysticism, marksman, shortblade, luck and personality. **Their
verdicts disagree** — security@60 is `no_remedy` while acrobatics@25 is `remedy_exists`.

> **The gate grain is `(check_id, stat, stat_kind, threshold)`.**
> `stat_kind` is in the key because skill and attribute names collide across the two enums.

Three places had assumed otherwise, all shipped in one commit:

- `buildEvidence()` matched on `check_id` and took the **first** hit — silently answering about
  whichever stat had the most failures. The insight was well-formed, correctly cited, and about the
  wrong gate.
- `POST /insights/generate` accepted a bare `check_id`, so a caller *could not* name the gate it
  meant. All four fields are now required; defaulting them would have hidden the same bug behind a
  friendlier API.
- The dashboard keyed its React list **and** its insight lookup on `check_id` — duplicating 11 of
  25 keys and handing the `security@25` insight to the `shortblade@25` card.

`matchGate()` is extracted and pure so the rule is testable without an event log. The bug was
invisible to every DB-free test precisely because **the wrong answer is a real gate with real
numbers**.

---

## 7. Provider

`ClaudeInsightProvider` (`claude-opus-5`) + `FakeInsightProvider`, the same interface/real/fake
shape as `corpus/embeddings.ts` and for the same two reasons: the model identity is *data* stored
on every row, and the pipeline must be testable with no network and no spend.

- **Structured outputs** pin the schema; the response is *also* shape-checked in code, because this
  project has now been bitten twice by trusting a stage's own report instead of checking what
  crossed the boundary out of it.
- **`stop_reason === 'refusal'` is checked before reading `content`** — on a refusal `content` is
  empty or partial, and indexing `[0]` would throw on a successful HTTP 200.
- **Server-side fallbacks** (`fallbacks: 'default'`) — a declined request is re-run on a recommended
  model server-side, routed by refusal category rather than pinning a model we would have to
  maintain.
- **Fails CLOSED** without `ANTHROPIC_API_KEY`, unlike `/search`, which degrades to lexical-only.
  Half a search still answers the user's question; **there is no honest half of an insight**, so a
  missing key returns 503 rather than quietly serving the fake.

`prompt_version` is stored on every row so derived-artefact drift (11 §14) is a query
(`where prompt_version < N`) instead of archaeology.

---

## 8. Status

| | |
| --- | --- |
| ✅ Built | validator (+ mutation-checked tests), provider, prompt, orchestration, 4 routes, `insights` table (migrations 0008 + 0009), `/gaps` dashboard view |
| ✅ Verified | evidence assembly against real data; 97 tests; rejected-insight-leaves-no-row; SSR 25 cards / 25 distinct grains |
| ❌ **NOT verified** | **no live model call has ever run** — `ANTHROPIC_API_KEY` is not configured locally or in the cluster |

▶ **Next:** add `ANTHROPIC_API_KEY` to `api/.env` and to the k8s secret `omwa-api-secrets`, generate
against a real gate, and review the first insight. Until then the generation path is code that
compiles and has never executed end to end — which is exactly the kind of claim this project does
not make.
