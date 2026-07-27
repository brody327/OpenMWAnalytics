// Chunking: turning parsed records into the units we actually embed (design docs 11 §4).
//
// GRAIN, same rule as the friction rollup: store at the finest grain that retains the inputs and
// derive the coarse view. An embedding is a FIXED-SIZE array regardless of input length, so one
// vector for a 20-page book is the average of everything it discusses and sits close to none of
// it. Book-level results are recovered at read time with GROUP BY record_id + MAX(score).
//
// ⚠️ NOTE WHICH KNOBS ARE FREE AND WHICH ARE NOT:
//   MAX vs AVG rollup   -> query-time. Change it whenever; costs nothing.
//   chunk SIZE          -> NOT free. Different boundaries means different text, which means a
//                          different text_hash, which means re-embedding the whole corpus.
//                          (Four cents, but it is a re-run, not a config flip.)

import { createHash } from 'node:crypto';
import type { ParsedRecord } from './parseEsmDump.js';

/** Only long-form text is chunked. Everything else is 1-3 sentences; splitting shreds it. */
const CHUNKED_TYPES = new Set(['BOOK']);

/** Pack paragraphs up to roughly this size before starting a new chunk. */
const TARGET_CHARS = 1000;
/** A single paragraph longer than this is split internally rather than embedded whole. */
const MAX_CHARS = 1500;

export interface ChunkRow {
  chunkId: string;
  recordId: string;
  ordinal: number;
  text: string;
  textHash: string;
}

/** sha256 of the chunk text -- one third of the idempotency key (11 §8). */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Split one oversized paragraph on sentence boundaries. Falls back to emitting it whole rather
 * than cutting mid-word: a paragraph with no sentence breaks is rare, and a hard character cut
 * would produce a fragment whose embedding means little.
 */
function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  if (sentences.length === 1) return [paragraph];

  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && buf.length + s.length + 1 > TARGET_CHARS) {
      out.push(buf);
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Pack paragraphs into chunks. Merging small paragraphs matters as much as splitting large ones:
 * embedding a lone "Chapter Two" produces a vector that is confidently about nothing.
 */
export function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf) chunks.push(buf);
    buf = '';
  };

  for (const p of paragraphs) {
    if (p.length > MAX_CHARS) {
      flush();
      chunks.push(...splitLongParagraph(p));
      continue;
    }
    if (buf && buf.length + p.length + 2 > TARGET_CHARS) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

/**
 * The text we EMBED, which is deliberately not always the text we DISPLAY.
 *
 * ⚠️ THE PROBLEM THIS SOLVES, found by actually querying (2026-07-26): asking
 * *"a potion that makes you more persuasive"* returned Cheap Potion of Paralyze, Invisibility and
 * Light. An ALCH record has no prose, so its full_text is just its NAME -- the vector encoded
 * "cheap potion of…" and matched on the word *potion*. What an item actually DOES lives in
 * record_effects: relational, queryable, and never embedded. The semantic half was searching
 * labels, not meaning.
 *
 * So for effect-bearing records (ALCH / SPEL / ENCH / INGR) we append the effects as readable
 * text. `full_text` is untouched -- 11 §6 keeps display and retrieval separate, and this is the
 * retrieval side.
 *
 * MAGNITUDES AND DURATIONS ARE DELIBERATELY OMITTED. "20-20" contributes almost nothing to an
 * embedding and would dilute the words that carry meaning; magnitude is a *relational* filter
 * (`WHERE affected='personality' AND magnitude_min >= 10`), which is precisely why the effects
 * live in a child table rather than in the prose.
 *
 * ⚠️ This changes chunk text, therefore the text_hash, therefore re-embeds exactly the affected
 * rows on the next ingest -- the idempotency key doing its job, loudly and by construction.
 */
export function searchableText(record: ParsedRecord): string {
  if (record.effects.length === 0) return record.fullText;

  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const e of record.effects) {
    // "Fortify Attribute personality" -- the effect name plus its target is the whole semantic
    // payload. Duplicates are common (two effects of the same kind on different targets are
    // distinct; identical pairs are not) and repeating them only skews the vector.
    const phrase = e.affected ? `${e.effectName} ${e.affected}` : e.effectName;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    phrases.push(phrase);
  }
  return `${record.fullText}. ${phrases.join('. ')}.`;
}

/**
 * Records -> chunk rows. `chunk_id` is DERIVED (`${recordId}#${ordinal}`) rather than a sequence,
 * so re-running ingest produces the same ids for the same input and the upsert can be a plain
 * ON CONFLICT -- no lookup table, no coordination, no surrogate keys to keep stable.
 */
export function buildChunks(records: ParsedRecord[]): ChunkRow[] {
  const rows: ChunkRow[] = [];
  for (const record of records) {
    // Books are the only chunked type and they never carry effects, so the two paths never meet.
    const texts = CHUNKED_TYPES.has(record.type)
      ? chunkText(record.fullText)
      : [searchableText(record)];

    texts.forEach((text, ordinal) => {
      if (!text) return;
      rows.push({
        chunkId: `${record.recordId}#${ordinal}`,
        recordId: record.recordId,
        ordinal,
        text,
        textHash: hashText(text),
      });
    });
  }
  return rows;
}
