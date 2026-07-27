import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChunks, chunkText, hashText } from './chunk.js';
import { FakeEmbeddingProvider, truncateAndNormalize } from './embeddings.js';
import type { ParsedRecord } from './parseEsmDump.js';

const rec = (over: Partial<ParsedRecord>): ParsedRecord => ({
  recordId: 'r', type: 'BOOK', name: null, fullText: '', effects: [], ...over,
});

const para = (n: number, word: string) => Array.from({ length: n }, () => word).join(' ');

test('short records are ONE chunk -- splitting 1-3 sentences shreds them', () => {
  const chunks = buildChunks([
    rec({ recordId: 'potion_skooma_01', type: 'ALCH', fullText: 'Skooma' }),
    rec({ recordId: 'info_1', type: 'INFO', fullText: 'Addhiranirr is hiding in the underworks.' }),
  ]);
  assert.deepEqual(chunks.map((c) => c.chunkId), ['potion_skooma_01#0', 'info_1#0']);
});

test('only BOOK is chunked: a long non-book stays whole', () => {
  // Same text, two types. If chunking were length-driven rather than type-driven, these would
  // disagree -- and a 23,693-row INFO table would explode into fragments.
  const long = `${para(400, 'alpha')}\n\n${para(400, 'beta')}`;
  const asBook = buildChunks([rec({ recordId: 'b', type: 'BOOK', fullText: long })]);
  const asInfo = buildChunks([rec({ recordId: 'i', type: 'INFO', fullText: long })]);
  assert.ok(asBook.length > 1);
  assert.equal(asInfo.length, 1);
});

test('paragraphs are packed toward the target, not emitted one-per-chunk', () => {
  // Six short paragraphs should merge. Embedding a lone "Chapter Two" yields a vector that is
  // confidently about nothing.
  const text = Array.from({ length: 6 }, (_, i) => `Chapter ${i}`).join('\n\n');
  const chunks = chunkText(text);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /Chapter 0/);
  assert.match(chunks[0], /Chapter 5/);
});

test('an oversized single paragraph is split on sentence boundaries', () => {
  const sentence = `${para(30, 'word')}. `;
  const chunks = chunkText(sentence.repeat(20).trim());
  assert.ok(chunks.length > 1, 'must not emit one 3,000-char chunk');
  // Sentence-boundary splitting, so no chunk should start mid-word.
  for (const c of chunks) assert.doesNotMatch(c, /^\s/);
});

test('ordinals are contiguous from 0 and chunk_id is derived, not sequential', () => {
  const long = Array.from({ length: 8 }, (_, i) => `${para(120, `p${i}`)}`).join('\n\n');
  const chunks = buildChunks([rec({ recordId: 'BookSkill_Enchant1', fullText: long })]);
  assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i));
  assert.equal(chunks[0].chunkId, 'BookSkill_Enchant1#0');
  // Derived ids are what make the upsert a plain ON CONFLICT: same input, same ids, every run.
  const again = buildChunks([rec({ recordId: 'BookSkill_Enchant1', fullText: long })]);
  assert.deepEqual(again.map((c) => c.chunkId), chunks.map((c) => c.chunkId));
});

test('empty text produces no chunks rather than one empty chunk', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(buildChunks([rec({ fullText: '' })]), []);
});

test('the text hash is stable and content-addressed', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  // Whitespace is content: it changes the text, so it must change the key. Anything else would
  // let a reformatted corpus skip re-embedding.
  assert.notEqual(hashText('a b'), hashText('a  b'));
});

// --- embedding provider ---------------------------------------------------------------------

test('the fake is deterministic -- which is what makes idempotency testable', () => {
  const a = new FakeEmbeddingProvider();
  const b = new FakeEmbeddingProvider();
  return Promise.all([a.embed(['Skooma']), b.embed(['Skooma'])]).then(([x, y]) => {
    assert.deepEqual(x[0], y[0]);
  });
});

test('the fake returns REAL unit vectors of the configured width', async () => {
  const fake = new FakeEmbeddingProvider();
  const [v] = await fake.embed(['bribing the guards']);
  assert.equal(v.length, 384);
  // A fake returning zeros or 3 dims would let broken downstream code pass.
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit length, got ${norm}`);
});

test('different text yields different vectors, order is preserved', async () => {
  const fake = new FakeEmbeddingProvider();
  const [a, b] = await fake.embed(['alpha', 'beta']);
  assert.notDeepEqual(a, b);
  const [again] = await fake.embed(['alpha']);
  assert.deepEqual(a, again, 'order in == order out');
});

test('provider declares the provenance that goes in the idempotency key', () => {
  const fake = new FakeEmbeddingProvider({ model: 'text-embedding-3-large', dims: 512 });
  // model + dims are DATA the pipeline stores, not a hidden client detail -- so the thing that
  // produces a vector is the thing that declares what produced it.
  assert.equal(fake.model, 'text-embedding-3-large');
  assert.equal(fake.dims, 512);
});

test('truncation re-normalizes: a prefix of a unit vector is NOT a unit vector', async () => {
  const full = (await new FakeEmbeddingProvider({ dims: 1536 }).embed(['x']))[0];
  const rawPrefix = full.slice(0, 384);
  const rawNorm = Math.sqrt(rawPrefix.reduce((s, x) => s + x * x, 0));
  assert.ok(rawNorm < 0.99, `a bare prefix should be short, got ${rawNorm}`);

  const fixed = truncateAndNormalize(full, 384);
  const norm = Math.sqrt(fixed.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit length after truncation, got ${norm}`);
});

// --- searchable text: effects are the meaning of an item ---------------------------------------

test('an effect-bearing record embeds WHAT IT DOES, not just its name', () => {
  const potion = rec({
    recordId: 'p_charm', type: 'ALCH', name: 'Potion of Charm', fullText: 'Potion of Charm',
    effects: [
      { ordinal: 0, effectId: 79, effectName: 'Fortify Attribute', affected: 'personality',
        affectedKind: 'attribute', magnitudeMin: 10, magnitudeMax: 20, duration: 30, range: 'self' },
    ],
  });
  const [chunk] = buildChunks([potion]);
  // Without this, the vector encodes "potion of charm" and a query about persuasion matches the
  // word "potion" — which is exactly what happened on the real corpus.
  assert.match(chunk.text, /Fortify Attribute personality/);
  assert.match(chunk.text, /Potion of Charm/);
  // Magnitudes and durations are deliberately excluded: they dilute the meaningful words and are
  // a relational filter, not a semantic one.
  assert.doesNotMatch(chunk.text, /10|20|30/);
});

test('repeated identical effect phrases are collapsed, distinct targets are not', () => {
  const eff = (ordinal: number, affected: string | null) => ({
    ordinal, effectId: 79, effectName: 'Fortify Attribute', affected,
    affectedKind: 'attribute' as const,
    magnitudeMin: null, magnitudeMax: null, duration: null, range: null,
  });
  const [chunk] = buildChunks([rec({
    recordId: 'r', type: 'SPEL', name: 'Blessing', fullText: 'Blessing',
    effects: [eff(0, 'personality'), eff(1, 'personality'), eff(2, 'luck')],
  })]);
  assert.equal(chunk.text.match(/Fortify Attribute personality/g)?.length, 1,
    'a repeated phrase only skews the vector');
  assert.match(chunk.text, /Fortify Attribute luck/);
});

test('records without effects are untouched, and books are still chunked from full text', () => {
  const info = rec({ recordId: 'i', type: 'INFO', fullText: 'Addhiranirr is hiding.' });
  assert.equal(buildChunks([info])[0].text, 'Addhiranirr is hiding.');

  const long = `${para(400, 'alpha')}\n\n${para(400, 'beta')}`;
  const book = buildChunks([rec({ recordId: 'b', type: 'BOOK', fullText: long })]);
  assert.ok(book.length > 1, 'the book path must not be affected');
});
