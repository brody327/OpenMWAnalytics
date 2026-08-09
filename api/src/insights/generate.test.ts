import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { insights } from '../db/schema.js';
import { generateFromEvidence, PROMPT_VERSION } from './generate.js';
import { FakeInsightProvider } from './provider.js';
import type { InsightEvidence } from './validate.js';

// Fixture ids are prefixed `fixture_` — a CORRECTNESS requirement, not tidiness (11 §12). A test
// that built its fixture from real ids once upserted itself over genuine corpus rows on every
// `npm test`, undetected for a day. `check_id` is not a foreign key here, but the habit is the
// point: a test must not be able to collide with production data.
const CHECK_ID = 'fixture_insights_gate:persuade';

const evidence: InsightEvidence = {
  check_id: CHECK_ID,
  stat: 'personality',
  threshold: 40,
  gap_p90: 20,
  fails: 60,
  reliable: 1,
  possible: 1,
  verdict: 'remedy_exists',
  remedies: [
    {
      record_id: 'fixture_ring_en',
      name: 'Fixture Ring',
      type: 'ENCH',
      magnitude_min: 20,
      magnitude_max: 20,
    },
  ],
  passages: [
    { record_id: 'fixture_info_1', name: 'a rumour', text: 'She never takes that ring off.' },
  ],
};

const countRows = async (): Promise<number> => {
  const r = (await db.execute(
    sql`select count(*)::int as n from insights where check_id = ${CHECK_ID}`,
  )).rows as unknown as [{ n: number }];
  return r[0].n;
};

after(async () => {
  await db.delete(insights).where(eq(insights.checkId, CHECK_ID));
});

test('a valid insight is STORED, as pending, with its evidence and provenance', async () => {
  const before = await countRows();
  const result = await generateFromEvidence(evidence, new FakeInsightProvider());

  assert.equal(result.status, 'stored');
  assert.equal(await countRows(), before + 1);

  const [row] = await db.select().from(insights).where(eq(insights.checkId, CHECK_ID));

  // `pending`, not `approved`. This single assertion is what makes "human review" a true claim
  // rather than a word in a bullet point — if generation ever landed rows as approved, model
  // output would reach the public dashboard with nobody in the loop.
  assert.equal(row.status, 'pending');
  assert.equal(row.model, 'fake-deterministic');
  assert.equal(row.promptVersion, PROMPT_VERSION);

  // The evidence is stored VERBATIM. A reviewer judging "is this a correct inference?" needs the
  // payload the model actually saw; re-deriving it later would show them different evidence as
  // telemetry accumulates, and they would be reviewing a different claim than the one made.
  assert.deepEqual(row.evidence, evidence);
});

test('⭐⭐ a REJECTED insight leaves NO ROW BEHIND', async () => {
  // The rule the whole phase rests on. A fabricated claim stored as `pending` sits one UI click
  // from `approved` — so rejection cannot mean "saved with a bad flag", it has to mean the row
  // does not exist.
  //
  // The assertion discriminates: in a world where rejects are persisted "for audit", the count
  // goes up and this fails. A test that only checked `result.status === 'rejected'` would pass in
  // both worlds and prove nothing about the database.
  const before = await countRows();
  const liar = new FakeInsightProvider({
    rationale: 'The ring grants +15 Personality and is sold by every apothecary.',
    citations: ['record_that_does_not_exist'],
  });

  const result = await generateFromEvidence(evidence, liar);

  assert.equal(result.status, 'rejected');
  assert.equal(await countRows(), before, 'a rejected insight must not be stored');

  assert.ok(result.status === 'rejected');
  const broken = new Set(result.violations.map((v) => v.rule));
  assert.ok(broken.has('unknown_number'), '15 is nowhere in the evidence');
  assert.ok(broken.has('reachability_claim'), 'obtainability is not ours to assert');
  assert.ok(broken.has('uncited_record'), 'the cited record was never supplied');
});

test('a model refusal is reported, not stored', async () => {
  const before = await countRows();
  const refuser = {
    model: 'fake-refuser',
    async generate() {
      return { type: 'refused' as const, model: 'fake-refuser', category: 'cyber' };
    },
  };

  const result = await generateFromEvidence(evidence, refuser);
  assert.equal(result.status, 'refused');
  assert.equal(await countRows(), before);
});

test('malformed model output is reported, not stored', async () => {
  const before = await countRows();
  const garbage = {
    model: 'fake-garbage',
    async generate() {
      return { type: 'malformed' as const, model: 'fake-garbage', detail: 'not JSON' };
    },
  };

  const result = await generateFromEvidence(evidence, garbage);
  assert.equal(result.status, 'malformed');
  assert.equal(await countRows(), before);
});

test('the provider receives exactly the evidence — no hidden enrichment on the way', async () => {
  // The prompt payload IS the validator's oracle (prompt.ts). If anything were added between
  // assembly and the call, the model could legitimately cite facts the validator would then
  // reject — or worse, assert numbers the whitelist silently permits because they were added
  // downstream of where the whitelist is derived.
  const fake = new FakeInsightProvider();
  await generateFromEvidence(evidence, fake);
  assert.equal(fake.calls, 1);
  assert.deepEqual(fake.seen[0], evidence);
});
