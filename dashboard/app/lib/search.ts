// Typed client for hybrid corpus search (Express GET /search).
//
// Server-side only, like lib/stats.ts and lib/events.ts -- the API base stays out of the browser
// bundle and there is no CORS.
//
// NO snapshot fallback, for the same reason as lib/events.ts but more so: a stale search result
// is not "slightly old data", it is an ANSWER TO A DIFFERENT QUESTION. Showing yesterday's hits
// for today's query would be wrong in a way the user cannot detect. When upstream is down we say
// so and show nothing.

const API_BASE = process.env.OMWA_API_BASE ?? 'http://localhost:4000';

export type SearchHit = {
  record_id: string;
  type: string;
  name: string | null;
  source: string;
  /** The matching CHUNK, not the whole record -- books are chunked (design docs 11 §4). */
  snippet: string;
  rrf_score: number;
  /** Null when that retriever did not return this document AT ALL. Not zero -- absent.
   *  This nullability is the whole reason RRF was chosen over a weighted sum: the ordering
   *  stays explainable, and "1st lexically, unranked semantically" is renderable. */
  lexical_rank: number | null;
  vector_rank: number | null;
};

export type SearchResult = {
  query: string;
  /** 'lexical' means the embedding call failed and only half the search ran. Surfaced in the
   *  UI rather than swallowed: results are still useful, but they are NOT the same product. */
  mode: 'hybrid' | 'lexical';
  took_ms: number;
  results: SearchHit[];
};

export async function getSearch(
  q: string,
  limit = 20,
): Promise<{ result: SearchResult | null; error: string | null }> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  try {
    const res = await fetch(`${API_BASE}/search?${params.toString()}`, {
      // Never cache. Corpus search is deterministic for a given query, so caching would be
      // safe -- but the timeout below is the real constraint: an embedding round-trip plus an
      // HNSW scan is the slowest read in the platform, and a stale-while-revalidate story here
      // would need a cache key that includes the embedding model. Not worth it for one user.
      cache: 'no-store',
      // Longer than the 8s used elsewhere: this request fans out to OpenAI before it reaches
      // Postgres, so it has a network hop the other endpoints do not.
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { result: null, error: `upstream returned ${res.status}` };
    return { result: (await res.json()) as SearchResult, error: null };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : 'unknown error' };
  }
}
