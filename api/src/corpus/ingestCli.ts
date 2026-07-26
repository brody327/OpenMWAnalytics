// Entrypoint for corpus ingest. The logic lives in ingest.ts; this is only the process wrapper
// -- arguments, provider selection, logging, exit code, pool teardown.
//
//   1. produce the dump (local, needs the game files + the OpenMW install):
//        "H:/OpenMW 0.51.0/esmtool.exe" dump -p "H:/Morrowind - OpenMW/Data Files/Morrowind.esm" > mw.txt
//   2. ingest it:
//        npm run ingest-corpus -- mw.txt Morrowind.esm            # real embeddings, needs a key
//        npm run ingest-corpus -- mw.txt Morrowind.esm --fake     # offline, no spend
//
// It takes a dump FILE rather than shelling out to esmtool: the tool's path varies per machine,
// and keeping the two steps separate means a parser change can be re-run against a saved dump
// without re-extracting 31 MB.
//
// ⚠️ Ingest runs LOCALLY and writes to whatever DATABASE_URL points at. That is deliberate --
// the .esm files cannot leave this machine (11 §8) -- but it means pointing it at prod is one
// env var away, so it prints the target host before doing anything.
import { readFileSync } from 'node:fs';
import { db, pool } from '../db/client.js';
import { parseEsmDump } from './parseEsmDump.js';
import { ingestCorpus } from './ingest.js';
import { FakeEmbeddingProvider, OpenAIEmbeddingProvider, type EmbeddingProvider } from './embeddings.js';

const [dumpPath, source, ...flags] = process.argv.slice(2);
const useFake = flags.includes('--fake');

if (!dumpPath || !source) {
  console.error('usage: ingest-corpus <esmtool-dump-file> <source-name> [--fake]');
  process.exit(2);
}

let provider: EmbeddingProvider;
if (useFake) {
  // Loud, because a corpus embedded with the fake is SEARCHABLE BUT MEANINGLESS: every query
  // returns ten confident results in an arbitrary order. That is harder to notice than an empty
  // table, so the warning names the consequence rather than just the mode.
  console.warn(
    '[corpus] ⚠️  FAKE embeddings: vectors are deterministic but NOT semantic.\n' +
    '[corpus] ⚠️  Search will return results and they will be meaningless. Never for measurement.',
  );
  provider = new FakeEmbeddingProvider();
} else {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[corpus] OPENAI_API_KEY is not set. Pass --fake to run offline.');
    process.exit(2);
  }
  provider = new OpenAIEmbeddingProvider({ apiKey });
}

const dbHost = (() => {
  try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '(unparsed)'; }
})();

const t0 = Date.now();
try {
  const dump = readFileSync(dumpPath, 'utf8');
  const { records, skippedEmpty } = parseEsmDump(dump);
  console.log(
    `[corpus] parsed ${records.length} record(s) from ${dumpPath} ` +
    `(${skippedEmpty} skipped as empty) -> ${dbHost}`,
  );

  const stats = await ingestCorpus({
    db, provider, records, source,
    onProgress: (m) => console.log(`[corpus] ${m}`),
  });

  console.log(
    `[corpus] done in ${Date.now() - t0} ms\n` +
    `  records upserted   ${stats.recordsUpserted}   (${stats.duplicateRecordsCollapsed} duplicate id(s) collapsed)\n` +
    `  chunks total       ${stats.chunksTotal}\n` +
    `  chunks skipped     ${stats.chunksSkipped}   (hash + model + dims already matched)\n` +
    `  chunks written     ${stats.chunksWritten}\n` +
    `  texts embedded     ${stats.textsEmbedded}   (${stats.duplicatesCollapsed} duplicate(s) collapsed)\n` +
    `  effects written    ${stats.effectsWritten}\n` +
    `  orphan records     ${stats.orphanRecordsDeleted}\n` +
    `  orphan chunks      ${stats.orphanChunksDeleted}`,
  );
} catch (err) {
  // Non-zero so a wrapper script or CI notices. The write is one transaction, so a failure has
  // already rolled back -- there is no partial corpus to clean up, which is the whole reason the
  // embedding step happens before the transaction opens.
  console.error('[corpus] FAILED', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
