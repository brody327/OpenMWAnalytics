import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { OpenAIEmbeddingProvider, type EmbeddingProvider } from '../corpus/embeddings.js';

// GET /search?q=...&limit=10
//
// Hybrid search over the game corpus (design docs 11 §10). Two retrievers, fused by Reciprocal
// Rank Fusion, over the 36,567 chunks ingested by src/corpus.
//
// WHY BOTH HALVES, demonstrated rather than argued (measured 2026-07-26 on the real corpus):
//   "Addhiranirr"          -> the VECTOR half ranks `Chirranirr`, a different NPC, 3rd. Embeddings
//                             match the orthographic shape of an invented proper noun, not its
//                             identity. The lexical half finds the actual dialogue.
//   "bribing the guards"   -> the LEXICAL half scores "the watch wanted coin" at exactly zero;
//                             the vector half puts it at 0.43 with no shared content words.
// Each retriever's characteristic failure is the other's easy case.
//
// ⚠️ THIS IS THE FIRST EXTERNAL SERVICE ON A REQUEST PATH IN THIS PROJECT. Every other endpoint
// is Postgres and nothing else. Three consequences, all handled below:
//
//  1. LATENCY INVERTS. The database work is ~2 ms; embedding the query is ~1,100 ms. The search
//     is not a database problem, it is a network problem, and no amount of index tuning touches
//     the dominant term. Hence the cache.
//  2. AVAILABILITY. If OpenAI is down or rate-limits us, the semantic half is simply unavailable.
//     Failing the whole request would be wrong -- the lexical half is a complete, working search
//     on its own -- so we DEGRADE to lexical-only and say so in the response, the same shape as
//     the dashboard's live/snapshot/unavailable handling (07).
//  3. SPEND. Bounded by the cache and by how many distinct queries users type. Negligible here,
//     but it is now a per-request cost where before there were none.

const RRF_K = 60;
/** Depth pulled from EACH retriever before fusing. Deeper costs little and lets a document that
 *  only one retriever likes still enter the fusion at all. */
const CANDIDATE_DEPTH = 100;
const MAX_LIMIT = 50;

/**
 * ⚠️ 80, not pgvector's default 40 — MEASURED in 11 §10a: recall@10 rises 89.3% -> 91.6% for 1.6x
 * the buffers, and flattens hard after (160 buys +0.2 points for 1.9x the work). Still ~30x
 * cheaper than exact KNN.
 */
const EF_SEARCH = 80;

/**
 * Query-embedding cache. Identical query text always produces an identical vector, so this is
 * safe by the same argument as the corpus idempotency key -- and it converts the ~1,100 ms
 * dominant cost into ~0 for any repeated search.
 *
 * ⚠️ Keyed by text ALONE, which is only correct because the provider is fixed for the process
 * lifetime. If the model ever became per-request, this key would need the model in it -- the same
 * trap as 11 §8, one layer up. Bounded so a hostile client cannot grow it without limit.
 */
const CACHE_MAX = 500;
const queryVectorCache = new Map<string, number[]>();

let provider: EmbeddingProvider | null | undefined;
/** Resolved lazily so the API still boots (and every other endpoint still works) with no key. */
function getProvider(): EmbeddingProvider | null {
  if (provider === undefined) {
    const apiKey = process.env.OPENAI_API_KEY;
    provider = apiKey ? new OpenAIEmbeddingProvider({ apiKey }) : null;
    if (!provider) {
      console.warn('[search] OPENAI_API_KEY unset — semantic half disabled, lexical-only.');
    }
  }
  return provider;
}

/** Exposed for tests. */
export function __setProviderForTest(p: EmbeddingProvider | null): void {
  provider = p;
  queryVectorCache.clear();
}

async function embedQuery(q: string): Promise<number[] | null> {
  const p = getProvider();
  if (!p) return null;
  const cached = queryVectorCache.get(q);
  if (cached) return cached;
  try {
    const [v] = await p.embed([q]);
    if (queryVectorCache.size >= CACHE_MAX) {
      // Cheapest possible eviction: drop the oldest insertion. A real LRU would need access
      // bookkeeping this endpoint cannot justify yet.
      queryVectorCache.delete(queryVectorCache.keys().next().value as string);
    }
    queryVectorCache.set(q, v);
    return v;
  } catch (err) {
    // Degrade, do not fail: the lexical half is a complete search on its own.
    console.error('[search] embedding failed, falling back to lexical-only', err);
    return null;
  }
}

export interface SearchHit {
  record_id: string;
  type: string;
  name: string | null;
  source: string;
  /** The matching CHUNK, not the whole record — books are chunked (11 §4). */
  snippet: string;
  rrf_score: number;
  /** Null when that retriever did not return this document at all. Surfaced because RRF's
   *  selling point over a weighted sum is that the ordering is EXPLAINABLE: "1st lexically,
   *  2nd semantically" renders in a UI; "0.0325" does not. */
  lexical_rank: number | null;
  vector_rank: number | null;
}

export interface SearchResult {
  query: string;
  /** 'hybrid' when both retrievers ran; 'lexical' when the embedding was unavailable. */
  mode: 'hybrid' | 'lexical';
  took_ms: number;
  results: SearchHit[];
}

export async function searchCorpus(query: string, limit = 10): Promise<SearchResult> {
  const t0 = Date.now();
  const vector = await embedQuery(query);
  const k = Math.min(Math.max(limit, 1), MAX_LIMIT);

  // The vector half is a separate CTE rather than a nullable parameter: `embedding <=> NULL`
  // would leave the planner deciding what to do with an index scan over a null probe. An empty
  // CTE is unambiguous, and FULL OUTER JOIN handles the degenerate side for free.
  const vecCte = vector
    ? sql`SELECT chunk_id, embedding <=> ${JSON.stringify(vector)}::vector AS d
          FROM game_chunks ORDER BY d LIMIT ${CANDIDATE_DEPTH}`
    : sql`SELECT NULL::text AS chunk_id, NULL::float8 AS d WHERE false`;

  const run = async (tx: typeof db) => tx.execute(sql`
    WITH lex AS (
      SELECT chunk_id, ts_rank(tsv, websearch_to_tsquery('english', ${query})) AS s
      FROM game_chunks
      WHERE tsv @@ websearch_to_tsquery('english', ${query})
      ORDER BY s DESC
      LIMIT ${CANDIDATE_DEPTH}
    ),
    lex_r AS (SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY s DESC) AS r FROM lex),
    vec   AS (${vecCte}),
    vec_r AS (SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY d) AS r FROM vec),
    -- FULL OUTER JOIN is load-bearing (11 §10): an INNER JOIN would require BOTH retrievers to
    -- return a document, which silently re-imposes multiplication's failure -- a semantic-only
    -- hit, the entire reason the 56 MB vector index exists, would be dropped.
    fused AS (
      SELECT COALESCE(lex_r.chunk_id, vec_r.chunk_id) AS chunk_id,
             COALESCE(1.0/(${RRF_K} + lex_r.r), 0) + COALESCE(1.0/(${RRF_K} + vec_r.r), 0) AS rrf,
             lex_r.r AS lexical_rank,
             vec_r.r AS vector_rank
      FROM lex_r FULL OUTER JOIN vec_r USING (chunk_id)
    ),
    ranked AS (
      SELECT f.rrf, f.lexical_rank, f.vector_rank,
             c.record_id, c.text AS snippet,
             r.type, r.name, r.source,
             -- PARENT-DOCUMENT ROLLUP (11 §4): one row per record, keeping its best chunk. MAX,
             -- not AVG -- "any paragraph about it counts". A query-time choice, changeable
             -- without re-embedding, which is the whole payoff of the fine grain.
             ROW_NUMBER() OVER (PARTITION BY c.record_id  ORDER BY f.rrf DESC) AS rn_record,
             -- 23% of the corpus is exact-duplicate text (stock dialogue reused across topics),
             -- so without this the same sentence appears repeatedly under different record ids.
             -- Observed in the first live demo.
             ROW_NUMBER() OVER (PARTITION BY c.text_hash ORDER BY f.rrf DESC) AS rn_text
      FROM fused f
      JOIN game_chunks  c ON c.chunk_id  = f.chunk_id
      JOIN game_records r ON r.record_id = c.record_id
    )
    SELECT record_id, type, name, source, snippet,
           rrf AS rrf_score, lexical_rank, vector_rank
    FROM ranked
    WHERE rn_record = 1 AND rn_text = 1
    ORDER BY rrf DESC
    LIMIT ${k}
  `);

  // ⚠️ SET LOCAL ONLY APPLIES INSIDE A TRANSACTION. Outside one it is a WARNING and a silent
  // no-op -- which is exactly how the step 7 benchmark spent a run measuring the default while
  // believing it was sweeping ef_search. The transaction is not for atomicity here (this is a
  // read); it is the scope that makes the setting take effect at all.
  const rows = vector
    ? await db.transaction(async (tx) => {
        // sql.raw, because SET does not accept bind parameters ("syntax error at or near $1").
        // Safe here and only here: EF_SEARCH is a module constant, never request input.
        await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`));
        return run(tx as unknown as typeof db);
      })
    : await run(db);

  return {
    query,
    mode: vector ? 'hybrid' : 'lexical',
    took_ms: Date.now() - t0,
    results: (rows.rows as unknown as SearchHit[]).map((r) => ({
      ...r,
      rrf_score: Number(r.rrf_score),
      lexical_rank: r.lexical_rank === null ? null : Number(r.lexical_rank),
      vector_rank: r.vector_rank === null ? null : Number(r.vector_rank),
    })),
  };
}

export async function search(req: Request, res: Response): Promise<void> {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.status(400).json({ error: 'q is required' });
    return;
  }
  // Bounded so one request cannot ask the fusion to materialize the corpus.
  const limit = Number.parseInt(String(req.query.limit ?? '10'), 10);
  const result = await searchCorpus(q, Number.isFinite(limit) ? limit : 10);
  res.json(result);
}
