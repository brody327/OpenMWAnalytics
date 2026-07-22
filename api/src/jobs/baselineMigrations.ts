import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

// ONE-TIME, PER PRE-EXISTING DATABASE. Records migrations as already applied WITHOUT running
// their SQL (design docs 09 §7).
//
// THE PROBLEM IT SOLVES -- "baselining". Both databases already had the full schema before any
// migration existed; the generated 0000 baseline is a stack of bare CREATE TABLEs that would
// fail immediately against them. But if nothing is recorded, `migrate` would also try to run it
// on every deploy. Adopting a migration tool onto a live database always needs this step.
//
// WHY NOT just add IF NOT EXISTS to the baseline SQL: it would run green against a table whose
// shape had drifted, reporting success while the schema is wrong. That is the same class of
// failure as the outage this whole exercise is fixing. Recording the hash asserts exactly what
// is true -- "this migration's effect is already present" -- and asserts nothing about the rest.
//
// SAFETY: only ever INSERTs into drizzle.__drizzle_migrations, and skips hashes already there.
// It never touches application tables. Running it twice does nothing the second time.
//
//   npm run build && node dist/jobs/baselineMigrations.js [--run]
//
// Dry-run by default -- it prints what it would record and exits. Pass --run to write.

const RUN = process.argv.includes('--run');
const FOLDER = 'drizzle';

type JournalEntry = { idx: number; when: number; tag: string };
const journal = JSON.parse(fs.readFileSync(`${FOLDER}/meta/_journal.json`, 'utf8')) as {
  entries: JournalEntry[];
};

// Hash exactly as drizzle-orm/migrator does: sha256 of the raw file contents. Any difference
// (even whitespace) yields a different hash, and the migration would be re-applied.
const migrations = journal.entries.map((e) => ({
  tag: e.tag,
  when: e.when,
  hash: crypto
    .createHash('sha256')
    .update(fs.readFileSync(`${FOLDER}/${e.tag}.sql`).toString())
    .digest('hex'),
}));

const useSsl = process.env.DATABASE_SSL === 'true';
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

try {
  // Same DDL drizzle's migrator uses, so it adopts this table rather than creating its own.
  await client.query('create schema if not exists drizzle');
  await client.query(
    'create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)',
  );

  const { rows: existing } = await client.query<{ hash: string }>(
    'select hash from drizzle.__drizzle_migrations',
  );
  const have = new Set(existing.map((r) => r.hash));
  const pending = migrations.filter((m) => !have.has(m.hash));

  if (pending.length === 0) {
    console.log('[baseline] nothing to do -- every migration is already recorded');
  } else {
    for (const m of pending) console.log(`[baseline] ${RUN ? 'recording' : 'would record'} ${m.tag}`);
    if (RUN) {
      for (const m of pending) {
        await client.query(
          'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
          [m.hash, m.when],
        );
      }
      console.log(`[baseline] recorded ${pending.length} migration(s) as applied`);
    } else {
      console.log('[baseline] DRY RUN -- pass --run to write');
    }
  }
} finally {
  await client.end();
}
