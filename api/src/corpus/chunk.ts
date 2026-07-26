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
 * Records -> chunk rows. `chunk_id` is DERIVED (`${recordId}#${ordinal}`) rather than a sequence,
 * so re-running ingest produces the same ids for the same input and the upsert can be a plain
 * ON CONFLICT -- no lookup table, no coordination, no surrogate keys to keep stable.
 */
export function buildChunks(records: ParsedRecord[]): ChunkRow[] {
  const rows: ChunkRow[] = [];
  for (const record of records) {
    const texts = CHUNKED_TYPES.has(record.type)
      ? chunkText(record.fullText)
      : [record.fullText];

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
