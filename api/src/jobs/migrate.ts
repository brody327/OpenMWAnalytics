import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';

// Applies pending SQL migrations from drizzle/ (design docs 09 §7).
//
// WHY THIS EXISTS: CI shipped code automatically and schema by memory, and on 2026-07-22 that
// put a production 500 on /stats/confrontations -- the deployed image queried generated columns
// that had never been applied to RDS. This is the missing link: schema now lands as part of the
// rollout, in the same image, from the same commit.
//
// It runs as an initContainer on the API Deployment, so the app container CANNOT start until
// migrations succeed. That ordering is the whole point -- a pod that can't migrate must not
// serve traffic against a schema it doesn't understand.
//
// Idempotent by design: drizzle records each applied migration's file hash in
// drizzle.__drizzle_migrations and skips what is already there, so restarts and re-rolls are
// free. Exits non-zero on failure so Kubernetes reports CrashLoopBackOff on the initContainer
// rather than starting an app that would 500.

// A DEDICATED CLIENT, not the shared pool: the advisory lock below is SESSION-scoped, so it
// belongs to one connection. A pooled `db` could run the lock on one connection and the
// migration on another, and the lock would protect nothing.
const useSsl = process.env.DATABASE_SSL === 'true';
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

const t0 = Date.now();
await client.connect();
const db = drizzle(client);

try {
  // Serialize migrators the same way the rollup fold serializes folds. Today the Deployment has
  // one replica so nothing contends -- but scale to two and both pods run this initContainer
  // simultaneously, and drizzle's "which migrations are applied?" read is not atomic with the
  // writes that follow. Two migrators could both decide the same migration is pending.
  //
  // NOT pg_advisory_XACT_lock here (unlike the rollup fold): migrate() runs its own
  // transactions, so a transaction-scoped lock would be released by the first COMMIT, part-way
  // through. This is the session-scoped variant, released explicitly in `finally`.
  await db.execute(sql`select pg_advisory_lock(hashtext('omwa_schema_migrate'))`);
  await migrate(db, { migrationsFolder: 'drizzle' });
  console.log(`[migrate] schema up to date in ${Date.now() - t0} ms`);
} catch (err) {
  console.error('[migrate] FAILED', err);
  process.exitCode = 1;
} finally {
  await client
    .query(`select pg_advisory_unlock(hashtext('omwa_schema_migrate'))`)
    .catch(() => {}); // the lock dies with the connection anyway; this is just tidy
  await client.end();
}
