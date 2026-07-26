// Embedding providers (design docs 11 §5).
//
// WHY AN INTERFACE, and it is not only for tests: the idempotency key is
// `text_hash + embedding_model + embedding_dims` (11 §8), so the *identity* of the model is
// data the pipeline stores, not a detail hidden inside a client. Making `model` and `dims`
// part of the contract means the thing that produces a vector is also the thing that declares
// what produced it -- they cannot drift apart.
//
// The testing payoff is real too: ingest is exercised end to end with no network and no spend,
// and the fake returns REAL 384-dim unit vectors, so nothing downstream can tell it is a fake
// by shape. A fake that returned zeros or 3 dimensions would let broken code pass.

export interface EmbeddingProvider {
  /** Stored verbatim in game_chunks.embedding_model -- half of the invalidation key. */
  readonly model: string;
  /** Dims AFTER truncation. Stored in game_chunks.embedding_dims. */
  readonly dims: number;
  /** Batch in, batch out, same order. Order is the only correlation between input and output. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Scale a vector to unit length. */
function normalize(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  // A zero vector has no direction; returning it unchanged is better than dividing by zero.
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/**
 * Truncate to `dims` and RE-NORMALIZE.
 *
 * Truncation is safe because the model is trained with Matryoshka representation learning --
 * the loss is applied at several prefix lengths, so information is front-loaded and a prefix
 * is itself a usable embedding. But lopping off 1,152 of 1,536 numbers destroys unit length,
 * and the rest of the system assumes unit vectors (it is what makes cosine and L2 rank
 * identically). Re-normalizing restores the property rather than hoping nothing depended on it.
 *
 * ⚠️ CHANGING THIS FUNCTION REQUIRES A FULL RE-EMBED. The stored vector is a function of
 * (text, model, dims, AND this transform), but the idempotency key covers only the first three.
 * Alter the truncation or normalization here and unchanged text will still be skipped, leaving
 * vectors produced by two different transforms in one column -- the model-swap trap wearing a
 * different hat. This is deliberately code rather than configuration: it cannot drift via an
 * env var, so breaking it takes an edit, and the edit meets this comment.
 */
export function truncateAndNormalize(v: number[], dims: number): number[] {
  return normalize(v.slice(0, dims));
}

// ---------------------------------------------------------------------------------------------

/**
 * Native output width per model -- the width we REQUEST before truncating.
 *
 * This is a lookup rather than a constructor option on purpose. It used to be configurable
 * (`requestDims`), which opened a silent-corruption hole: embedding at 1536 and truncating to
 * 384 does not produce the same vector as embedding at 3072 and truncating to 384, yet both
 * store model='text-embedding-3-small', dims=384. Identical provenance, different vectors, no
 * error -- and unlike a width change, the fixed-width column cannot catch it either.
 *
 * Deriving it from the model closes the hole BY CONSTRUCTION instead of adding a fourth key
 * column to guard a knob nobody needed: the only legitimate reason to change the request width
 * is changing models, and a model change already invalidates the key. Requesting less than the
 * native width is strictly worse than truncating from it -- a shorter, less informative source
 * for no benefit.
 *
 * Step 7's dims sweep is unaffected: it truncates ONE set of stored 1536-dim vectors locally via
 * truncateAndNormalize. It varies the STORED width, never the requested one -- re-requesting
 * would mean re-embedding, which is exactly what "four cents buys the whole table" avoids.
 */
const NATIVE_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

export function nativeDimsFor(model: string): number {
  const dims = NATIVE_DIMS[model];
  // Throw rather than defaulting: a silent fallback to 1536 for a model whose native width is
  // something else re-creates a quieter version of the bug this lookup exists to remove.
  if (!dims) {
    throw new Error(
      `Unknown embedding model '${model}'. Add its native width to NATIVE_DIMS -- ` +
      'guessing one would silently change every vector it produces.',
    );
  }
  return dims;
}

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  /** Stored width. 384 keeps the HNSW index resident in a 185 MB shared_buffers (11 §5). */
  dims?: number;
  model?: string;
  /** Requests are per-batch, so this trades latency against blast radius on a failure. */
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI embeddings over plain `fetch` -- no SDK dependency for one endpoint (guardrail: no new
 * dependency without demonstrated need). Anthropic has no embeddings endpoint, which is why this
 * is the one external model call in the project.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  private readonly apiKey: string;
  private readonly requestDims: number;
  private readonly batchSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIEmbeddingOptions) {
    if (!opts.apiKey) throw new Error('OpenAIEmbeddingProvider: apiKey is required');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dims = opts.dims ?? 384;
    // Derived, not configurable -- see NATIVE_DIMS. Resolved in the constructor so an unknown
    // model fails at construction rather than partway through a 28,000-text ingest run.
    this.requestDims = nativeDimsFor(this.model);
    this.batchSize = opts.batchSize ?? 100;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await this.fetchImpl('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.requestDims,
        }),
      });
      if (!res.ok) {
        // Fail loudly with the batch position: a partial corpus is worse than a failed run,
        // because a partial corpus looks like a working one.
        throw new Error(
          `OpenAI embeddings failed (${res.status}) on batch at offset ${i}: ${await res.text()}`,
        );
      }
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      // ⚠️ Sort by `index`: the API does not promise response order, and a silently reordered
      // batch would attach every vector to the wrong chunk -- wrong results, no error.
      const ordered = [...json.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== batch.length) {
        throw new Error(
          `OpenAI returned ${ordered.length} embeddings for ${batch.length} inputs at offset ${i}`,
        );
      }
      for (const d of ordered) out.push(truncateAndNormalize(d.embedding, this.dims));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Deterministic offline provider. No network, no key, no spend.
 *
 * DETERMINISM IS THE POINT: the same text always yields the same vector, so a test can assert
 * that re-running ingest over unchanged text is a no-op -- which is the property the whole
 * idempotency design exists to guarantee. A random fake would make that untestable.
 *
 * It is NOT semantic: similar text does not land nearby. It exercises plumbing, shapes and
 * provenance, never retrieval QUALITY. Any recall or ranking measurement (step 7) requires real
 * embeddings, and a fake that pretended otherwise would produce exactly the kind of confident
 * wrong number this project keeps hunting.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  calls = 0;
  embedded: string[] = [];

  constructor(opts: { model?: string; dims?: number } = {}) {
    this.model = opts.model ?? 'fake-deterministic';
    this.dims = opts.dims ?? 384;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    this.embedded.push(...texts);
    return texts.map((t) => this.vectorFor(t));
  }

  private vectorFor(text: string): number[] {
    // xorshift32 seeded from the text: cheap, dependency-free, and stable across runs and
    // platforms (unlike anything touching Math.random or hash iteration order).
    let seed = 2166136261;
    for (let i = 0; i < text.length; i++) {
      seed ^= text.charCodeAt(i);
      seed = Math.imul(seed, 16777619);
    }
    let s = seed || 1;
    const v: number[] = new Array(this.dims);
    for (let i = 0; i < this.dims; i++) {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      v[i] = (s / 0xffffffff) * 2 - 1;
    }
    // Unit length, exactly like the real provider -- so downstream code cannot distinguish them.
    return normalize(v);
  }
}
