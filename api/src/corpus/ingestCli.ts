// Entrypoint for corpus ingest. The logic lives in ingest.ts; this is only the process wrapper
// -- arguments, provider selection, logging, exit code, pool teardown.
//
//   1. produce a dump per plugin (local; needs the game files + the OpenMW install):
//        "H:/OpenMW 0.51.0/esmtool.exe" dump -p ".../Morrowind.esm" > mw.txt
//   2. ingest the WHOLE LOAD ORDER, earliest first:
//        npm run ingest-corpus -- mw.txt Morrowind.esm tri.txt Tribunal.esm bm.txt Bloodmoon.esm
//        npm run ingest-corpus -- ... --fake      # offline, no spend
//
// ⚠️ A SINGLE PLUGIN IS REFUSED unless you pass --single, and that is a correctness guard rather
// than ceremony. `game_records.record_id` is the primary key ALONE, so `source` is a label, not a
// namespace: later plugins OVERWRITE the records they override, which is exactly right (the corpus
// holds the EFFECTIVE game). But it makes a single-file run destructive in a way nothing reports --
// re-ingesting Morrowind.esm on its own silently re-asserts Morrowind's text over every Tribunal
// and Bloodmoon override, and the corpus goes quietly stale. No error, no count, no tell.
//
// ⚠️ SCOPE (11 §13): the corpus describes the STABLE BASE every mod author shares -- Morrowind +
// Tribunal + Bloodmoon -- plus the ONE mod being measured. It is deliberately NOT one author's
// personal load order: that is unstable, unique to them, and would make the corpus unreproducible.
//
// It takes dump FILES rather than shelling out to esmtool: the tool's path varies per machine, and
// keeping the steps separate means a parser change can be re-run against saved dumps without
// re-extracting 31 MB.
//
// ⚠️ Ingest runs LOCALLY and writes to whatever DATABASE_URL points at. That is deliberate --
// the .esm files cannot leave this machine (11 §8) -- but it means pointing it at prod is one
// env var away, so it prints the target host before doing anything.
import { readFileSync } from 'node:fs';
import { db, pool } from '../db/client.js';
import { parseEsmDump } from './parseEsmDump.js';
import { ingestCorpus } from './ingest.js';
import { FakeEmbeddingProvider, OpenAIEmbeddingProvider, type EmbeddingProvider } from './embeddings.js';

const argv = process.argv.slice(2);
const useFake = argv.includes('--fake');
const allowSingle = argv.includes('--single');
const positional = argv.filter((a) => !a.startsWith('--'));

const USAGE =
  'usage: ingest-corpus <dump> <source> [<dump> <source> ...] [--fake] [--single]\n' +
  '       plugins must be listed in LOAD ORDER, earliest first.';

if (positional.length === 0 || positional.length % 2 !== 0) {
  console.error(USAGE);
  process.exit(2);
}

const plugins = [];
for (let i = 0; i < positional.length; i += 2) {
  plugins.push({ dumpPath: positional[i]!, source: positional[i + 1]! });
}

// The guard. Refuses rather than warns: a warning on a destructive default is a warning nobody
// reads twice. --single exists for the legitimate case (re-ingesting only the measured mod's
// plugin, which overrides nothing) and forces that intent to be stated.
if (plugins.length === 1 && !allowSingle) {
  console.error(
    `[corpus] REFUSING a single-plugin ingest.\n` +
    `[corpus] record_id is the primary key, so a later plugin OVERWRITES the records it overrides.\n` +
    `[corpus] Running one file re-asserts its text over every later override -- silently.\n` +
    `[corpus] Pass the whole load order, or --single if you really mean just this one.\n\n` +
    USAGE,
  );
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
  console.log(`[corpus] load order (${plugins.length}): ${plugins.map((p) => p.source).join(' -> ')}`);
  console.log(`[corpus] target: ${dbHost}`);

  // Sequential and IN ORDER -- the later plugin must see the earlier one's rows to override them.
  //
  // ⚠️ Each plugin is its own transaction, so a failure partway leaves the earlier plugins applied
  // rather than rolling the whole merge back. Holding one transaction across all of them would pin
  // a snapshot for minutes of embedding calls (11 §8's reasoning). The recovery is simply to re-run
  // the full merge, which is idempotent -- hash-diff means unchanged chunks cost nothing.
  for (const { dumpPath, source } of plugins) {
    const { records, skippedEmpty } = parseEsmDump(readFileSync(dumpPath, 'utf8'));
    console.log(
      `[corpus] ${source}: parsed ${records.length} record(s) from ${dumpPath} ` +
      `(${skippedEmpty} skipped as empty)`,
    );

    const stats = await ingestCorpus({
      db, provider, records, source,
      onProgress: (m) => console.log(`[corpus]   ${m}`),
    });

    console.log(
      `[corpus] ${source}: upserted ${stats.recordsUpserted} ` +
      `(${stats.duplicateRecordsCollapsed} dup id(s) collapsed) · ` +
      `chunks ${stats.chunksWritten} written / ${stats.chunksSkipped} skipped · ` +
      `embedded ${stats.textsEmbedded} · effects ${stats.effectsWritten} · ` +
      `orphans ${stats.orphanRecordsDeleted} rec / ${stats.orphanChunksDeleted} chunk`,
    );
  }

  console.log(`[corpus] done in ${Date.now() - t0} ms`);
} catch (err) {
  // Non-zero so a wrapper script or CI notices.
  console.error('[corpus] FAILED', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
