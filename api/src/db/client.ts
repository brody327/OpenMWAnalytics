import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

// A single shared connection pool for the process.
//
// RDS (and most managed Postgres) refuses plaintext connections, so we enable TLS
// when DATABASE_SSL=true. We leave it OFF by default so local dev against the Docker
// Postgres (no TLS) is untouched — only the cloud pod sets the flag.
//
// `rejectUnauthorized: false` encrypts the wire but does NOT verify RDS's certificate
// chain. That's acceptable for this deploy; the strict version pins Amazon's RDS CA
// bundle (`ssl: { ca: <rds-combined-ca-bundle.pem> }`) and is a documented follow-up.
const useSsl = process.env.DATABASE_SSL === 'true';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
export { pool };
