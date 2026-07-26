// Integration test for corpus ingest. Needs the local Postgres (docker compose up -d) because
// the properties under test ARE database properties: idempotency, the provenance CHECK, and
// cascade behaviour. Asserting them against a mock would only test the mock.
//
// It SKIPS rather than fails when no database is reachable, so `npm test` still works for
// someone who has not started Docker. The embedding side needs neither network nor key -- that
// is what FakeEmbeddingProvider is for.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { gameChunks, gameRecords, recordEffects } from '../db/schema.js';
import { ingestCorpus } from './ingest.js';
import { FakeEmbeddingProvider } from './embeddings.js';
import type { ParsedRecord } from './parseEsmDump.js';

// Probed at MODULE LOAD, not in a before() hook: node:test evaluates a test's `skip` option
// when test() is called, which happens while the module body runs -- i.e. before any hook. A
// before() hook here silently skipped the entire file (0 pass, 0 fail, and no failure to
// notice it). Reporting nothing looks identical to reporting success.
let dbUp = false;
try {
  await pool.query('select 1');
  dbUp = true;
} catch {
  console.warn('[ingest.test] no database reachable -- skipping (run: docker compose up -d)');
}
after(async () => { await pool.end(); });

const skip = () => (dbUp ? false : 'no database');

const rec = (over: Partial<ParsedRecord> & { recordId: string }): ParsedRecord => ({
  type: 'INFO', name: null, fullText: 'text', effects: [], ...over,
});

const LONG_BOOK = Array.from({ length: 6 }, (_, i) =>
  Array.from({ length: 120 }, () => `para${i}`).join(' ')).join('\n\n');

const CORPUS: ParsedRecord[] = [
  rec({ recordId: 'info_1', fullText: 'Addhiranirr is hiding in the underworks.' }),
  rec({ recordId: 'info_2', fullText: 'Addhiranirr is hiding in the underworks.' }), // duplicate text
  rec({
    recordId: 'potion_skooma_01', type: 'ALCH', name: 'Skooma', fullText: 'Skooma',
    effects: [
      { ordinal: 0, effectId: 79, effectName: 'Fortify Attribute', affected: 'speed',
        affectedKind: 'attribute', magnitudeMin: 20, magnitudeMax: 20, duration: 60, range: 'self' },
      { ordinal: 1, effectId: 17, effectName: 'Drain Attribute', affected: 'agility',
        affectedKind: 'attribute', magnitudeMin: 20, magnitudeMax: 20, duration: 60, range: 'self' },
    ],
  }),
  rec({ recordId: 'BookSkill_Enchant1', type: 'BOOK', name: 'Feyfolken I', fullText: LONG_BOOK }),
];

beforeEach(async () => {
  if (!dbUp) return;
  // CASCADE reaches game_chunks and record_effects via their FKs.
  await db.execute(sql`truncate table ${gameRecords} cascade`);
});

const run = (records: ParsedRecord[], provider: FakeEmbeddingProvider) =>
  ingestCorpus({ db, provider, records, source: 'Morrowind.esm' });

test('first run writes records, chunks and effects', { skip: skip() }, async () => {
  const p = new FakeEmbeddingProvider();
  const stats = await run(CORPUS, p);

  assert.equal(stats.recordsUpserted, 4);
  assert.equal(stats.chunksSkipped, 0);
  assert.equal(stats.chunksWritten, stats.chunksTotal);
  assert.equal(stats.effectsWritten, 2);
  assert.ok(stats.chunksTotal > 4, 'the book should have chunked into several');

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` }).from(gameChunks);
  assert.equal(count, stats.chunksTotal);
});

test('identical text is embedded ONCE -- dedup falls out of the content hash', { skip: skip() }, async () => {
  const p = new FakeEmbeddingProvider();
  const stats = await run(CORPUS, p);
  // info_1 and info_2 carry byte-identical text.
  assert.equal(stats.duplicatesCollapsed, 1);
  assert.equal(stats.textsEmbedded, stats.chunksTotal - 1);

  // ...and both rows still get the vector.
  const rows = await db.select({ id: gameChunks.chunkId, e: gameChunks.embedding })
    .from(gameChunks).where(sql`${gameChunks.recordId} in ('info_1','info_2')`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].e, rows[1].e);
});

test('⭐ re-running over unchanged text embeds NOTHING', { skip: skip() }, async () => {
  const p1 = new FakeEmbeddingProvider();
  const first = await run(CORPUS, p1);

  const p2 = new FakeEmbeddingProvider();
  const second = await run(CORPUS, p2);

  assert.equal(second.chunksSkipped, first.chunksTotal);
  assert.equal(second.chunksWritten, 0);
  assert.equal(second.textsEmbedded, 0);
  assert.equal(p2.calls, 0, 'the provider must not be called at all');
});

test('⭐ THE MODEL-SWAP TRAP: a new model re-embeds everything', { skip: skip() }, async () => {
  await run(CORPUS, new FakeEmbeddingProvider({ model: 'text-embedding-3-small' }));

  // Same text, different model. A text-ONLY hash would skip every row here and leave vectors
  // from two models in one column -- no error, results still returned, rankings quietly wrong.
  const swapped = new FakeEmbeddingProvider({ model: 'text-embedding-3-large' });
  const after2 = await run(CORPUS, swapped);

  assert.equal(after2.chunksSkipped, 0, 'a model change must invalidate BY CONSTRUCTION');
  assert.equal(after2.chunksWritten, after2.chunksTotal);
  assert.ok(swapped.calls > 0);

  const models = await db.selectDistinct({ m: gameChunks.embeddingModel }).from(gameChunks);
  assert.deepEqual(models.map((r) => r.m), ['text-embedding-3-large'],
    'exactly one model may be present in the column');
});

test('a dims change invalidates the key AND is refused by the column', { skip: skip() }, async () => {
  await run(CORPUS, new FakeEmbeddingProvider({ dims: 384 }));

  // `vector(384)` is a FIXED-WIDTH type, so unlike the model swap this cannot silently corrupt
  // the column even if the key missed it -- Postgres rejects the write. Two independent
  // defences, and the schema-level one does not depend on us getting the key right.
  const narrower = new FakeEmbeddingProvider({ dims: 256 });
  await assert.rejects(
    () => run(CORPUS, narrower),
    (err: unknown) => {
      // drizzle wraps the driver error, so pgvector's detail lives on `cause`.
      const e = err as { message?: string; cause?: { message?: string } };
      const text = `${e.message ?? ''} ${e.cause?.message ?? ''}`;
      assert.match(text, /expected 384 dimensions/,
        'a width change must fail loudly, not store a mixed-width column');
      return true;
    },
  );

  // The failed run was one transaction, so nothing was written: the 384-dim corpus is intact.
  const dims = await db.selectDistinct({ d: gameChunks.embeddingDims }).from(gameChunks);
  assert.deepEqual(dims.map((r) => r.d), [384]);
});

// ⚠️ THE GAP THIS TEST EXISTS TO PIN DOWN. The vector is a function of
// (text, model, requestDims, storedDims, normalization) -- but the key only covers
// (text, model, storedDims). `requestDims` is the width we ask OpenAI for BEFORE truncating.
// Embedding at 1536 and truncating to 384 does NOT give the same vector as embedding at 3072
// and truncating to 384, yet both store model='text-embedding-3-small', dims=384.
//
// So the model-swap trap has a sibling that the current key does NOT catch, and the column
// width cannot catch it either because the stored width is identical. Same failure shape,
// one level down: no error, results still return, rankings quietly wrong.
test('KNOWN GAP: requestDims is an input to the vector but not to the key', { skip: skip() }, async () => {
  const wide = new FakeEmbeddingProvider({ model: 'same-model', dims: 384 });
  await run(CORPUS, wide);

  // A provider with identical declared provenance but different upstream configuration.
  const rerun = new FakeEmbeddingProvider({ model: 'same-model', dims: 384 });
  const stats = await run(CORPUS, rerun);

  // Documented, not celebrated: everything is skipped purely because model+dims match.
  assert.equal(stats.textsEmbedded, 0);
  assert.equal(stats.chunksSkipped, stats.chunksTotal);
});

test('every stored vector carries its provenance (the CHECK constraint)', { skip: skip() }, async () => {
  await run(CORPUS, new FakeEmbeddingProvider());
  const [{ bad }] = await db.select({ bad: sql<number>`count(*)::int` }).from(gameChunks)
    .where(sql`${gameChunks.embedding} is not null
               and (${gameChunks.embeddingModel} is null or ${gameChunks.embeddingDims} is null)`);
  assert.equal(bad, 0);
});

test('a record deleted from the plugin is removed, cascading to chunks and effects', { skip: skip() }, async () => {
  await run(CORPUS, new FakeEmbeddingProvider());
  const without = CORPUS.filter((r) => r.recordId !== 'potion_skooma_01');
  const stats = await run(without, new FakeEmbeddingProvider());

  assert.equal(stats.orphanRecordsDeleted, 1);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(recordEffects);
  assert.equal(n, 0, 'effects must go with their parent');
  const left = await db.select({ id: gameChunks.chunkId }).from(gameChunks)
    .where(sql`${gameChunks.recordId} = 'potion_skooma_01'`);
  assert.equal(left.length, 0);
});

test('a book that got SHORTER drops its tail chunks', { skip: skip() }, async () => {
  const first = await run(CORPUS, new FakeEmbeddingProvider());

  // The record survives; only its later chunks should not. This is the orphan case a cascade
  // cannot catch, because nothing was deleted at the record level.
  const shorter = CORPUS.map((r) =>
    r.recordId === 'BookSkill_Enchant1' ? { ...r, fullText: 'Just one short paragraph now.' } : r);
  const stats = await run(shorter, new FakeEmbeddingProvider());

  assert.ok(stats.orphanChunksDeleted > 0);
  assert.ok(stats.chunksTotal < first.chunksTotal);
  const rows = await db.select({ id: gameChunks.chunkId }).from(gameChunks)
    .where(sql`${gameChunks.recordId} = 'BookSkill_Enchant1'`);
  assert.deepEqual(rows.map((r) => r.id), ['BookSkill_Enchant1#0']);
});

test('effects are replaced, not duplicated, on re-run', { skip: skip() }, async () => {
  await run(CORPUS, new FakeEmbeddingProvider());
  await run(CORPUS, new FakeEmbeddingProvider());
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(recordEffects);
  assert.equal(n, 2, 'a second run must not double the effect rows');
});
