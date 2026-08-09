import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvScope, envPredicate, envNote, SYNTHETIC } from './envScope.js';

// The predicate is a drizzle SQL fragment; assert on the values it binds and the operator it
// emits, which is what actually reaches Postgres.
const rendered = (scope: Parameters<typeof envPredicate>[0]) => {
  const q = envPredicate(scope);
  return { chunks: JSON.stringify(q), params: q.queryChunks.filter((c) => typeof c !== 'object') };
};

test('default is `real` — an unasked-for read never sees fabricated rows', () => {
  assert.equal(parseEnvScope(undefined), 'real');
  assert.equal(parseEnvScope(''), 'real');
  assert.equal(parseEnvScope('prod'), 'real');
});

test('⭐ an unrecognised value falls back to `real`, never to `all`', () => {
  // A typo must show FEWER things, not more. `?env=prodd` widening the set to include seeded rows
  // would be a silent provenance mix caused by a misspelling.
  assert.equal(parseEnvScope('prodd'), 'real');
  assert.equal(parseEnvScope('ALL'), 'real');
  assert.equal(parseEnvScope(123), 'real');
  assert.equal(parseEnvScope(['synthetic']), 'synthetic'); // arrays: express gives ?env=a&env=b
});

test('explicit opt-ins are honoured', () => {
  assert.equal(parseEnvScope('synthetic'), 'synthetic');
  assert.equal(parseEnvScope('all'), 'all');
});

test('⭐⭐ `real` EXCLUDES synthetic rather than listing known-good values', () => {
  // The direction matters. An inclusion list (`env IN ('prod','dev')`) makes a future env value
  // silently invisible until someone remembers this file exists; an exclusion makes it visible by
  // default. Being wrong by showing a new real env is recoverable; hiding it is not noticeable.
  const r = rendered('real');
  assert.match(r.chunks, /<>/, 'must be an exclusion');
  assert.ok(!/ IN /.test(r.chunks), 'must not be an inclusion list');
});

test('`synthetic` selects only seeded rows', () => {
  assert.match(rendered('synthetic').chunks, /=/);
});

test('`all` emits TRUE, not an empty fragment', () => {
  // Callers splice this in as `AND ${envPredicate(scope)}`. A fragment that is sometimes empty
  // produces `WHERE type = 'x' AND` — a syntax error that only appears on one code path.
  assert.match(rendered('all').chunks, /TRUE/);
});

test('the note names the provenance for every scope', () => {
  assert.match(envNote('real'), /excluded/i);
  assert.match(envNote('synthetic'), /SEEDED/);
  assert.match(envNote('all'), /MIXED/);
});

test('SYNTHETIC is the single marker the whole system agrees on', () => {
  // If the seeder and the filter ever disagree on this string, the filter silently stops working
  // and every dashboard quietly includes fabricated rows. One constant, imported by both.
  assert.equal(SYNTHETIC, 'synthetic');
});
