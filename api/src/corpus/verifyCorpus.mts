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

const [dumpPath, source] = process.argv.slice(2);
if (!dumpPath || !source) {
  console.error('usage: npm run verify-corpus -- <dump.txt> <source>');
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(2); }
// Print the target first: this reads a database that may be PROD, and knowing which one is
// answering is the difference between a passing check and a meaningless one.
console.log(`[verify] database: ${new URL(url).host}`);
console.log(`[verify] dump    : ${dumpPath}  (source=${source})`);

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

// `source` is not a parser argument -- it is a database column, applied at ingest. Here it is
// only the WHERE clause that selects which stored rows this dump is supposed to account for.
const parsed: any = parseEsmDump(fs.readFileSync(dumpPath, 'utf8'));
const records: any[] = parsed.records ?? parsed;
console.log(`[verify] parsed  : ${records.length} records`);

// Expected effect count per record id, from the SOURCE.
const expected = new Map<string, number>();
for (const r of records) expected.set(String(r.recordId).toLowerCase(), r.effects.length);

const { rows } = await client.query(
  `SELECT lower(r.record_id) AS id, r.type,
          count(e.*)::int AS effects
     FROM game_records r
     LEFT JOIN record_effects e ON e.record_id = r.record_id
    WHERE r.source = $1
    GROUP BY 1, 2`,
  [source],
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
