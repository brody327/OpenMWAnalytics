import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIEmbeddingProvider, nativeDimsFor } from './embeddings.js';

// Exercises the REAL provider with no network and no key, through the fetchImpl seam. What is
// under test is the request we would have sent -- which is the thing that determines the vector.

/** A stub fetch that records every request body and returns unit-ish vectors of the right width. */
function stubFetch() {
  const bodies: { model: string; input: string[]; dimensions: number }[] = [];
  const impl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as typeof bodies[number];
    bodies.push(body);
    return new Response(
      JSON.stringify({
        data: body.input.map((_t, index) => ({
          index,
          embedding: Array.from({ length: body.dimensions }, (_, i) => (i % 7) + 1),
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { impl, bodies };
}

test('the requested width is DERIVED from the model, not configurable', async () => {
  // ⭐ This is the closed hole. Embedding at 1536 and truncating to 384 does not produce the same
  // vector as embedding at 3072 and truncating to 384 -- yet both would store identical
  // provenance (model + dims), so neither the idempotency key nor the fixed-width column could
  // catch a mismatch. Deriving the width from the model removes the ability to create one.
  const small = stubFetch();
  await new OpenAIEmbeddingProvider({
    apiKey: 'k', model: 'text-embedding-3-small', fetchImpl: small.impl,
  }).embed(['bribing the guards']);
  assert.equal(small.bodies[0].dimensions, 1536);

  const large = stubFetch();
  await new OpenAIEmbeddingProvider({
    apiKey: 'k', model: 'text-embedding-3-large', fetchImpl: large.impl,
  }).embed(['bribing the guards']);
  assert.equal(large.bodies[0].dimensions, 3072);
});

test('an unknown model throws at construction, not mid-run', () => {
  // Failing here beats failing 20,000 texts into a run -- and beats defaulting to 1536, which
  // would silently change every vector a future model produced.
  assert.throws(
    () => new OpenAIEmbeddingProvider({ apiKey: 'k', model: 'text-embedding-4-imaginary' }),
    /Unknown embedding model/,
  );
  assert.equal(nativeDimsFor('text-embedding-3-small'), 1536);
});

test('vectors are truncated to the STORED width and re-normalized', async () => {
  const { impl, bodies } = stubFetch();
  const provider = new OpenAIEmbeddingProvider({ apiKey: 'k', dims: 384, fetchImpl: impl });
  const [v] = await provider.embed(['x']);

  assert.equal(bodies[0].dimensions, 1536, 'requested at native width');
  assert.equal(v.length, 384, 'stored at the configured width');
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit length, got ${norm}`);
});

test('responses are re-ordered by index, never trusted to arrive in order', async () => {
  // The API does not promise response order. A reordered batch would attach every vector to the
  // wrong chunk -- wrong results, no error, and nothing downstream could detect it.
  const impl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    // The leading component encodes the index, so the vectors stay DISTINGUISHABLE after
    // normalization. (A uniform fill would normalize to identical vectors and the assertion
    // below would hold whether or not the sort ran -- a test that cannot fail.)
    const data = body.input.map((_t, index) => ({
      index,
      embedding: [index + 1, ...new Array(1535).fill(1)],
    }));
    return new Response(JSON.stringify({ data: data.reverse() }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const [first, second] = await new OpenAIEmbeddingProvider({
    apiKey: 'k', fetchImpl: impl,
  }).embed(['a', 'b']);
  // Sent 'a' (index 0, leading 1) then 'b' (index 1, leading 2); the stub returned them
  // REVERSED. Correct handling restores input order, so the smaller leading component is first.
  assert.ok(first[0] < second[0], `expected input order to be restored, got ${first[0]} then ${second[0]}`);
});

test('a batch returning the wrong number of embeddings fails loudly', async () => {
  const impl: typeof fetch = async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1536).fill(1) }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  await assert.rejects(
    () => new OpenAIEmbeddingProvider({ apiKey: 'k', fetchImpl: impl }).embed(['a', 'b']),
    /returned 1 embeddings for 2 inputs/,
  );
});

test('a non-2xx response names the batch offset', async () => {
  const impl: typeof fetch = async () => new Response('rate limited', { status: 429 });
  await assert.rejects(
    () => new OpenAIEmbeddingProvider({ apiKey: 'k', fetchImpl: impl }).embed(['a']),
    /429.*offset 0/s,
  );
});
