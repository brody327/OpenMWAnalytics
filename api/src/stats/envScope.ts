// Which events a read is allowed to see (design docs 06, 10 §3.3).
//
// ⚠️ THE OBVIOUS IMPLEMENTATION IS WRONG, and it is the one this project wrote down. Doc 00 has
// carried an open item for weeks reading *"filter /stats/* to env = 'prod'"*. Measured 2026-08-09,
// before writing any of it:
//
//     PROD:   dev 145                                    <- every real event, and none are 'prod'
//     LOCAL:  synthetic 1,000,000 | dev 1,146 | prod 12
//
// `env = 'prod'` would have blanked the entire public dashboard. Real gameplay from the author's
// own machine ships as `dev`, and that is still real data.
//
// ⭐ The distinction that matters is REAL vs FABRICATED, not prod vs dev. A play session is a play
// session wherever it happened; a seeded row is a seeded row. So the predicate is a single
// exclusion, and every new env value is real-by-default -- which is the safe direction to be wrong
// in. Adding `staging` later must not silently vanish from the dashboard.

import { sql, type SQL } from 'drizzle-orm';

/** The env value the seeder writes. The ONE fabricated marker; everything else is real. */
export const SYNTHETIC = 'synthetic';

export type EnvScope =
  /** Everything that is not seeded. THE DEFAULT, everywhere. */
  | 'real'
  /** Seeded rows only -- for demonstrating behaviour at volume. */
  | 'synthetic'
  /** Both, mixed. Only ever by explicit request, and the response says so. */
  | 'all';

/**
 * Parse `?env=` into a scope.
 *
 * ⭐ DEFAULTS TO `real`, AND THAT DEFAULT IS THE SAFETY PROPERTY. A reader who asks for nothing
 * gets nothing fabricated. Seeded volume has to be requested by name, which means no endpoint can
 * ever quietly start blending demo data into a finding because someone ran the seeder.
 *
 * Unrecognised values fall back to `real` rather than erroring: a typo'd `?env=prodd` should show
 * fewer things, never more.
 */
export function parseEnvScope(raw: unknown): EnvScope {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === 'synthetic' || v === 'all') return v;
  return 'real';
}

/**
 * The SQL predicate for a scope, as a fragment to AND into a WHERE clause.
 *
 * Returns `TRUE` rather than an empty fragment for `all`, so callers can always splice it in with
 * `AND ${envPredicate(scope)}` without special-casing -- a conditional that sometimes emits
 * nothing is how you end up with `WHERE type = 'x' AND` in production.
 *
 * @param column qualified column reference, e.g. `events.env` or `e.env`
 */
export function envPredicate(scope: EnvScope, column = sql`env`): SQL {
  switch (scope) {
    case 'synthetic':
      return sql`${column} = ${SYNTHETIC}`;
    case 'all':
      return sql`TRUE`;
    case 'real':
    default:
      // NOT '= any of the real values'. An exclusion means a future env value is visible by
      // default; an inclusion list means it silently disappears until someone remembers this file.
      return sql`${column} <> ${SYNTHETIC}`;
  }
}

/**
 * What to put on the response so a consumer cannot lose track of provenance.
 *
 * Same rule as `total_gates` and `reachable: UNKNOWN` -- a payload that mixes fabricated and real
 * rows without saying so is the failure; mixing them on request and announcing it is fine.
 */
export function envNote(scope: EnvScope): string {
  switch (scope) {
    case 'synthetic':
      return 'SEEDED DATA ONLY. These rows were generated to demonstrate behaviour at volume and describe no real play session.';
    case 'all':
      return 'MIXED: real play data AND seeded demo rows, counted together. Treat magnitudes as shape, not measurement.';
    case 'real':
    default:
      return 'Real recorded play only; seeded demo rows are excluded.';
  }
}
