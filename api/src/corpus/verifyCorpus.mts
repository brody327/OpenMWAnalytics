// Corpus verification: does the DATABASE match the source dump?
//
// ⚠️ WHY THIS EXISTS. `parseEsmDump` already asserts `emitted + skipped + containers == headers`,
// and that discipline caught four bugs in one day (11 §6a). But every one of those checks lives
// INSIDE the parser. Nothing ever verified that what landed in Postgres matched the .esm — and on
// 2026-07-27 exactly that gap surfaced: `potion_skooma_01` was stored with 2 of its 4 effects.
//
// One record in 258. Two effects in 289. It went undetected for a day and then produced a flatly
// WRONG ANSWER on the first real use of the telemetry x corpus join: a player drank Skooma, gained
// Strength, and the corpus said Skooma does not touch Strength.
//
// > The rule was "when N things go in, assert N come out." It had been applied WITHIN a stage and
// > never ACROSS the stage boundary that actually persists.
//
// This is that missing half. It re-parses the dump and reconciles it against the database, per
// record type, and exits non-zero on any mismatch so it can gate a release.
//
//   npm run verify-corpus -- <dump.txt> <source>
import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';
import { parseEsmDump } from './parseEsmDump.js';

// ⚠️ VERIFIES THE MERGE, NOT ONE PLUGIN — corrected 2026-07-27 after the first version reported
// 3,189 false discrepancies.
//
// `record_id` is the primary key alone, so a later plugin OVERWRITES the records it overrides and
// `source` records only WHICH FILE WON. Verifying a single plugin against a per-source WHERE clause
// therefore reports every overridden record as "missing from Morrowind.esm" when it is present and
// correct, merely labelled Tribunal. Measured: Tribunal and Bloodmoon claim 3,189 Morrowind
// records, and spot-checking showed the content is BYTE-IDENTICAL — expansions re-serialise the
// dialogue topics they touch, so most "overrides" change nothing but the label.
//
// So the expected state is the MERGE of the whole load order, computed the same way ingest applies
// it: parse each dump in order, last writer wins. Anything else compares against a game that is
// not the one in the database.
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.length % 2 !== 0) {
  console.error(
    'usage: npm run verify-corpus -- <dump> <source> [<dump> <source> ...]\n' +
    '       plugins in LOAD ORDER, earliest first — the same list ingest was given.',
  );
  process.exit(2);
}
const plugins: Array<{ dumpPath: string; source: string }> = [];
for (let i = 0; i < argv.length; i += 2) {
  plugins.push({ dumpPath: argv[i]!, source: argv[i + 1]! });
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(2); }
// Print the target first: this reads a database that may be PROD, and knowing which one is
// answering is the difference between a passing check and a meaningless one.
console.log(`[verify] database  : ${new URL(url).host}`);
console.log(`[verify] load order: ${plugins.map((p) => p.source).join(' -> ')}`);

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

// Replay the merge in load order. Last writer wins, exactly as ingest applies it -- so the
// expectation is the EFFECTIVE game, which is what the corpus is supposed to hold.
const expected = new Map<string, number>();
let overridden = 0;
for (const { dumpPath, source } of plugins) {
  const parsed: any = parseEsmDump(fs.readFileSync(dumpPath, 'utf8'));
  const records: any[] = parsed.records ?? parsed;
  let claimed = 0;
  for (const r of records) {
    const id = String(r.recordId).toLowerCase();
    if (expected.has(id)) { claimed++; overridden++; }
    expected.set(id, r.effects.length);
  }
  console.log(`[verify] ${source}: ${records.length} records (${claimed} overriding an earlier plugin)`);
}
console.log(`[verify] merged   : ${expected.size} records, ${overridden} override(s) applied`);

// Scoped to the plugins under test, so an unrelated source (a mod's own plugin, the test fixture)
// is not mistaken for corpus corruption.
const sources = plugins.map((p) => p.source);
const { rows } = await client.query(
  `SELECT lower(r.record_id) AS id, r.type,
          count(e.*)::int AS effects
     FROM game_records r
     LEFT JOIN record_effects e ON e.record_id = r.record_id
    WHERE r.source = ANY($1)
    GROUP BY 1, 2`,
  [sources],
);
await client.end();

const actual = new Map(rows.map((r: any) => [r.id, r.effects as number]));
const typeOf = new Map(rows.map((r: any) => [r.id, r.type as string]));

// Classify every discrepancy rather than reporting a single pass/fail. A count that is merely
// "wrong" tells you nothing about WHERE to look; the class does.
const missing: string[] = [];     // in dump, absent from db
const extra: string[] = [];       // in db, absent from dump
const fewer: string[] = [];       // db lost effects
const more: string[] = [];        // db has effects the dump does not

for (const [id, n] of expected) {
  if (!actual.has(id)) { missing.push(id); continue; }
  const got = actual.get(id)!;
  if (got < n) fewer.push(`${id} [${typeOf.get(id)}] dump=${n} db=${got}`);
  else if (got > n) more.push(`${id} [${typeOf.get(id)}] dump=${n} db=${got}`);
}
for (const id of actual.keys()) if (!expected.has(id)) extra.push(id);

const sumDump = [...expected.values()].reduce((a, b) => a + b, 0);
const sumDb = [...actual.values()].reduce((a, b) => a + b, 0);

console.log('');
console.log(`  records   dump=${expected.size}  db=${actual.size}`);
console.log(`  effects   dump=${sumDump}  db=${sumDb}`);
console.log('');
const report = (label: string, list: string[]) => {
  console.log(`  ${label.padEnd(24)} ${list.length}`);
  for (const x of list.slice(0, 10)) console.log(`      ${x}`);
  if (list.length > 10) console.log(`      … and ${list.length - 10} more`);
};
report('records missing from db', missing);
report('records not in dump', extra);
report('records with FEWER effects', fewer);
report('records with MORE effects', more);

const bad = missing.length + extra.length + fewer.length + more.length;
console.log('');
if (bad === 0) {
  console.log('[verify] ✅ database matches the dump');
  process.exit(0);
}
// Non-zero so this can gate a release. A verification tool that always exits 0 is a log line,
// not a check -- the same failure mode as a test that cannot fail.
console.error(`[verify] ❌ ${bad} discrepanc${bad === 1 ? 'y' : 'ies'}`);
process.exit(1);
