// Corpus ingest (design docs 11 §8): parsed records -> game_records / game_chunks / record_effects.
//
//   esmtool dump -p  ->  parse  ->  chunk  ->  hash + diff  ->  embed (batched)  ->  upsert
//
// LOCAL-FIRST, like the shipper, for a different reason: the .esm files live on the author's
// machine and 80 MB of copyrighted Bethesda data is not going into a container image. Second
// time this project has hit "the data is trapped on the client" -- ship the computation to the
// data, not the data to the computation.
//
// ⚠️ EMBEDDING HAPPENS OUTSIDE THE TRANSACTION. The write is one transaction so a failed run
// leaves no half-corpus, but holding it open across minutes of network calls would pin a
// snapshot, block vacuum, and turn one slow API response into database-wide pressure.

import { inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import { gameRecords, gameChunks, recordEffects } from '../db/schema.js';
import { buildChunks, type ChunkRow } from './chunk.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { ParsedRecord } from './parseEsmDump.js';

export type Db = NodePgDatabase<typeof schema>;

export interface IngestStats {
  /** Records dropped because another record claimed the same id (last wins). See §0 below. */
  duplicateRecordsCollapsed: number;
  recordsUpserted: number;
  chunksTotal: number;
  /** Chunks whose text_hash + model + dims already matched -- no embedding, no write. */
  chunksSkipped: number;
  chunksWritten: number;
  /** Provider calls actually made, AFTER de-duplicating identical text. */
  textsEmbedded: number;
  /** Chunks that shared a hash with another chunk in the same run. */
  duplicatesCollapsed: number;
  effectsWritten: number;
  orphanRecordsDeleted: number;
  orphanChunksDeleted: number;
}

/** Postgres caps a statement at 65535 bind parameters; batch well under it for the widest table. */
const WRITE_BATCH = 500;

function* batches<T>(items: T[], size = WRITE_BATCH): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

export interface IngestOptions {
  db: Db;
  provider: EmbeddingProvider;
  records: ParsedRecord[];
  source: string;
  /** Progress hook so the CLI can report without this module owning console output. */
  onProgress?: (msg: string) => void;
}

export async function ingestCorpus(opts: IngestOptions): Promise<IngestStats> {
  const { db, provider, records: rawRecords, source, onProgress = () => {} } = opts;

  // --- 0. collapse duplicate ids, LAST WINS, and count it -----------------------------------
  //
  // The parser resolves INFO's collisions properly (its key is composite: topic + id). What is
  // left is genuinely duplicated in the source: 16 CELLs where a town spans several exterior
  // cells of the same name ('Sadrith Mora' x3), and one duplicated BSGN.
  //
  // Collapsing is not a workaround for cells -- it is the right answer for a SEARCH corpus,
  // where "Sadrith Mora" should be one result rather than three identical ones. But it is
  // reported rather than silent, because a number that grows is the signal that some new type
  // has started colliding for a reason nobody has looked at.
  const deduped = new Map<string, ParsedRecord>();
  for (const r of rawRecords) deduped.set(r.recordId, r);
  const records = [...deduped.values()];
  const duplicateRecordsCollapsed = rawRecords.length - records.length;

  const chunks = buildChunks(records);
  const stats: IngestStats = {
    duplicateRecordsCollapsed,
    recordsUpserted: records.length,
    chunksTotal: chunks.length,
    chunksSkipped: 0,
    chunksWritten: 0,
    textsEmbedded: 0,
    duplicatesCollapsed: 0,
    effectsWritten: 0,
    orphanRecordsDeleted: 0,
    orphanChunksDeleted: 0,
  };

  // --- 1. what is already stored, and with WHICH model ------------------------------------
  //
  // ⚠️ The skip test is text_hash AND embedding_model AND embedding_dims -- all three. A
  // text-only hash silently permits a model swap: unchanged text is skipped, leaving vectors
  // from two different models in one column, where the distances between them are arbitrary.
  // No error, results still return, rankings quietly wrong. An idempotency key must cover every
  // input the cached output depends on, and the vector is a function of (text, model, dims).
  const existing = new Map<string, string>();
  for (const row of await db
    .select({
      chunkId: gameChunks.chunkId,
      textHash: gameChunks.textHash,
      model: gameChunks.embeddingModel,
      dims: gameChunks.embeddingDims,
    })
    .from(gameChunks)) {
    existing.set(row.chunkId, `${row.textHash}|${row.model}|${row.dims}`);
  }

  const want = (c: ChunkRow) => `${c.textHash}|${provider.model}|${provider.dims}`;
  const stale = chunks.filter((c) => existing.get(c.chunkId) !== want(c));
  stats.chunksSkipped = chunks.length - stale.length;

  // --- 2. de-duplicate by content hash before spending anything ---------------------------
  //
  // 23% of this corpus is exact-duplicate text (repeated stock dialogue, plus records whose
  // full_text falls back to their name). Because the key is already a CONTENT hash, dedup is
  // the same lookup -- it costs nothing to add and removes ~8,000 API inputs.
  const uniqueTexts = new Map<string, string>();   // textHash -> text
  for (const c of stale) uniqueTexts.set(c.textHash, c.text);
  stats.duplicatesCollapsed = stale.length - uniqueTexts.size;

  // --- 3. embed (network; deliberately not inside the transaction) -------------------------
  const vectors = new Map<string, number[]>();      // textHash -> embedding
  if (uniqueTexts.size > 0) {
    const hashes = [...uniqueTexts.keys()];
    const texts = hashes.map((h) => uniqueTexts.get(h)!);
    onProgress(`embedding ${texts.length} unique text(s) with ${provider.model}@${provider.dims}`);
    const embedded = await provider.embed(texts);
    if (embedded.length !== texts.length) {
      throw new Error(`provider returned ${embedded.length} vectors for ${texts.length} inputs`);
    }
    embedded.forEach((v, i) => {
      if (v.length !== provider.dims) {
        // Catch a mis-configured provider here rather than at INSERT, where the error would be
        // a Postgres type mismatch pointing at the wrong layer.
        throw new Error(`vector ${i} has ${v.length} dims, provider declares ${provider.dims}`);
      }
      vectors.set(hashes[i], v);
    });
    stats.textsEmbedded = texts.length;
  }

  // --- 4. one transaction for every write --------------------------------------------------
  await db.transaction(async (tx) => {
    for (const group of batches(records)) {
      await tx
        .insert(gameRecords)
        .values(group.map((r) => ({
          recordId: r.recordId,
          source,
          type: r.type,
          name: r.name,
          fullText: r.fullText,
        })))
        .onConflictDoUpdate({
          target: gameRecords.recordId,
          set: {
            source: sql`excluded.source`,
            type: sql`excluded.type`,
            name: sql`excluded.name`,
            fullText: sql`excluded.full_text`,
          },
        });
    }

    // record_effects is REPLACED wholesale rather than diffed. It is ~3,000 rows for the whole
    // base game, so incrementality would buy nothing and cost a diffing bug. Deleting only the
    // effects of records we are re-inserting keeps other sources untouched.
    const effectRows = records.flatMap((r) =>
      r.effects.map((e) => ({
        recordId: r.recordId,
        ordinal: e.ordinal,
        effectId: e.effectId,
        effectName: e.effectName,
        affected: e.affected,
        affectedKind: e.affectedKind,
        magnitudeMin: e.magnitudeMin,
        magnitudeMax: e.magnitudeMax,
        duration: e.duration,
        range: e.range,
      })),
    );
    for (const group of batches(records.map((r) => r.recordId), 5000)) {
      await tx.delete(recordEffects).where(inArray(recordEffects.recordId, group));
    }
    for (const group of batches(effectRows)) {
      await tx.insert(recordEffects).values(group);
    }
    stats.effectsWritten = effectRows.length;

    for (const group of batches(stale)) {
      await tx
        .insert(gameChunks)
        .values(group.map((c) => ({
          chunkId: c.chunkId,
          recordId: c.recordId,
          ordinal: c.ordinal,
          text: c.text,
          textHash: c.textHash,
          embedding: vectors.get(c.textHash)!,
          embeddingModel: provider.model,
          embeddingDims: provider.dims,
        })))
        .onConflictDoUpdate({
          target: gameChunks.chunkId,
          set: {
            recordId: sql`excluded.record_id`,
            ordinal: sql`excluded.ordinal`,
            text: sql`excluded.text`,
            textHash: sql`excluded.text_hash`,
            embedding: sql`excluded.embedding`,
            embeddingModel: sql`excluded.embedding_model`,
            embeddingDims: sql`excluded.embedding_dims`,
          },
        });
    }
    stats.chunksWritten = stale.length;

    // --- orphans: content deleted from the plugin must leave the index ---------------------
    //
    // Computed as a set difference in JS rather than a NOT IN (34,000 params) -- the id sets fit
    // in memory trivially and the intent stays legible. Deleting a record cascades to its chunks
    // and effects; chunk-level orphans are the separate case of a BOOK that got SHORTER, whose
    // record survives while its tail chunks should not.
    const liveChunkIds = new Set(chunks.map((c) => c.chunkId));
    const liveRecordIds = new Set(records.map((r) => r.recordId));

    const storedRecordIds = (await tx.select({ id: gameRecords.recordId }).from(gameRecords))
      .map((r) => r.id);
    const orphanRecords = storedRecordIds.filter((id) => !liveRecordIds.has(id));
    for (const group of batches(orphanRecords)) {
      await tx.delete(gameRecords).where(inArray(gameRecords.recordId, group));
    }
    stats.orphanRecordsDeleted = orphanRecords.length;

    const storedChunkIds = (await tx.select({ id: gameChunks.chunkId }).from(gameChunks))
      .map((r) => r.id);
    const orphanChunks = storedChunkIds.filter((id) => !liveChunkIds.has(id));
    for (const group of batches(orphanChunks)) {
      await tx.delete(gameChunks).where(inArray(gameChunks.chunkId, group));
    }
    stats.orphanChunksDeleted = orphanChunks.length;
  });

  return stats;
}
