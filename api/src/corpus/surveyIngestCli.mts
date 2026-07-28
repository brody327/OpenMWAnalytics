import 'dotenv/config';
import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { parseSurveyManifest, validateLoadOrder, PERMITTED_EXTRAS } from './surveyManifest.js';

// npm run ingest-survey -- <openmw.log> [--allow-extra <file>]...
//
// Loads a world placement survey (11 §13) into `world_surveys` + `item_placements`.
//
// ⚠️ WHOLESALE REPLACEMENT, never a merge (decided 2026-07-28). A partial survey merged into an
// old one produces a world that NEVER EXISTED -- some areas from load order A, some from B -- and
// nothing about the result would look wrong. Replacement means the table always describes exactly
// one coherent world.
//
// ⚠️ REFUSES a contaminated load order rather than warning. Same rule as the multi-plugin corpus
// ingest: a warning printed over a destructive default is one nobody reads twice.

const args = process.argv.slice(2);
const logPath = args.find((a) => !a.startsWith('--'));
const allowExtra: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allow-extra' && args[i + 1]) allowExtra.push(args[i + 1]!);
}

if (!logPath) {
  console.error('usage: npm run ingest-survey -- <openmw.log> [--allow-extra <file>]...');
  process.exit(2);
}

// Print the target first, as the corpus CLI does: ingest is local-first and running it against the
// wrong database is a mistake worth making visible before anything is written.
const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').host;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
})();
console.log(`[survey] target database: ${dbHost}`);
console.log(`[survey] reading ${logPath}`);

const manifest = parseSurveyManifest(fs.readFileSync(logPath, 'utf8'));

console.log(`[survey] load order: ${manifest.loadOrder.length} files, hash ${manifest.loadOrderHash}`);
console.log(`[survey] cells scanned: ${manifest.cellsScanned}, placements: ${manifest.placements.length}`);

// One source of truth: PERMITTED_EXTRAS, plus whatever this run explicitly allows. Re-listing the
// defaults here would let the two copies drift, and the copy that silently won would decide what
// counts as contamination.
const verdict = validateLoadOrder(manifest.loadOrder, [
  ...PERMITTED_EXTRAS,
  ...allowExtra.map((f) => f.toLowerCase()),
]);

if (!verdict.ok) {
  console.error('\n[survey] ❌ REFUSED — this survey did not run against a controlled load order.\n');
  if (verdict.missing.length) {
    console.error(`  missing required: ${verdict.missing.join(', ')}`);
    console.error('  (a survey without the expansions describes a smaller world than the corpus)');
  }
  if (verdict.contaminants.length) {
    console.error(`  ${verdict.contaminants.length} unexpected content file(s), each able to place objects:`);
    for (const c of verdict.contaminants.slice(0, 20)) console.error(`    - ${c}`);
    if (verdict.contaminants.length > 20) console.error(`    ... and ${verdict.contaminants.length - 20} more`);
  }
  console.error(
    '\n  Lua cannot say which file placed a given object, so a survey is trustworthy only if\n' +
      '  NOTHING unexpected could have placed one. Re-run under the controlled profile, or pass\n' +
      '  --allow-extra <file> if a file genuinely belongs in the measured set.\n',
  );
  process.exit(1);
}

console.log('[survey] ✅ load order is the controlled set');

const surveyId = `survey-${manifest.loadOrderHash}-${Date.now()}`;

await db.transaction(async (tx) => {
  // Wholesale replacement. Inside ONE transaction so a failure cannot leave the table empty or
  // half-populated -- a half-survey is a world that never existed.
  await tx.execute(sql`delete from item_placements`);
  await tx.execute(sql`delete from world_surveys`);

  await tx.execute(sql`
    insert into world_surveys (survey_id, load_order, load_order_hash, cells_scanned, surveyed_at)
    values (${surveyId}, ${JSON.stringify(manifest.loadOrder)}::jsonb,
            ${manifest.loadOrderHash}, ${manifest.cellsScanned}, now())
  `);

  const CHUNK = 1000;
  for (let i = 0; i < manifest.placements.length; i += CHUNK) {
    const batch = manifest.placements.slice(i, i + CHUNK);
    const values = sql.join(
      batch.map((p) => sql`(${p.area}, ${p.is_exterior}, ${p.item_id}, ${p.count})`),
      sql`, `,
    );
    // The Lua GROUP BY is per (area, item) already, so a conflict here would mean the emitter
    // produced a duplicate key -- a real bug. Summing on conflict would HIDE it, so we don't.
    await tx.execute(sql`
      insert into item_placements (area, is_exterior, item_record_id, count) values ${values}
    `);
  }
});

const [{ n }] = (
  await db.execute(sql`select count(*)::int as n from item_placements`)
).rows as unknown as [{ n: number }];

console.log(`[survey] wrote ${n} placement rows (survey_id ${surveyId})`);

// Conservation check across the STAGE BOUNDARY, not just inside it. 2026-07-27's lesson: every
// check in this project lived inside a stage; nothing verified that what reached Postgres matched
// what went in.
if (n !== manifest.placements.length) {
  console.error(`[survey] ❌ ${manifest.placements.length} parsed but ${n} in the database`);
  process.exit(1);
}
console.log('[survey] ✅ parsed count matches database count');
process.exit(0);
