import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateInsight,
  type GeneratedInsight,
  type InsightEvidence,
  type Violation,
} from './validate.js';

// Smallest-reproducible fixture: one gate, one remedy, one passage. Every number the model is
// allowed to write is visible here, which is what makes the whitelist assertions hand-checkable.
//
// Numbers present in this evidence: 40, 20, 60, 12, 1, 0 (and 01 inside the record id).
const evidence: InsightEvidence = {
  check_id: 'ccff_lelene_confrontation:persuade',
  stat: 'personality',
  stat_kind: 'attribute',
  threshold: 40,
  gap_p90: 20,
  fails: 60,
  reliable: 1,
  possible: 1,
  verdict: 'remedy_exists',
  remedies: [
    {
      record_id: 'CCFF_lelene_ring_en',
      name: 'Lelene Ring',
      type: 'ENCH',
      magnitude_min: 20,
      magnitude_max: 20,
    },
  ],
  passages: [
    {
      record_id: 'info_12345',
      name: 'little secret',
      text: 'They say Lelene never takes off that ring of hers.',
    },
  ],
};

const insight = (over: Partial<GeneratedInsight> = {}): GeneratedInsight => ({
  headline: 'The remedy exists but the text never connects it to this check',
  signposting: 'NOT_SIGNPOSTED',
  rationale: 'The dialogue mentions the ring without tying it to the personality check.',
  recommendation: 'Add a hint line that links the ring to this confrontation.',
  citations: ['CCFF_lelene_ring_en', 'info_12345'],
  ...over,
});

const rules = (v: Violation[]): string[] => v.map((x) => x.rule);

test('a clean insight passes', () => {
  const r = validateInsight(insight(), evidence);
  assert.equal(r.ok, true);
});

test('⭐⭐ a fabricated magnitude is REJECTED — the number was nowhere in the evidence', () => {
  // The failure this whole module exists for. "+15 Personality" is fluent, plausible, and exactly
  // the shape of claim a mod author would act on. 15 appears nowhere in the payload, so it cannot
  // have been read — it was invented, and set membership says so with no judgement call.
  const r = validateInsight(
    insight({ rationale: 'The ring grants +15 Personality, which clears the gap.' }),
    evidence,
  );
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && rules(r.violations).includes('unknown_number'));
});

test('a magnitude that IS in the evidence passes (20 is the ring\'s real magnitude)', () => {
  // The paired allow case. A guard that rejected this too would reject every correct insight —
  // and the previous test would still be green, which is precisely how an over-broad guard ships.
  const r = validateInsight(
    insight({ rationale: 'The ring grants 20 Personality, which exactly covers the 20-point gap.' }),
    evidence,
  );
  assert.equal(r.ok, true);
});

test('an invented record_id is REJECTED', () => {
  const r = validateInsight(insight({ citations: ['potion_of_nothing'] }), evidence);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && rules(r.violations).includes('uncited_record'));
});

test('⭐⭐ a lowercase citation of a mixed-case record is ACCEPTED, not a violation', () => {
  // THE ALLOW CASE THAT CARRIES THE BUG (the 2026-07-29 lesson, in a different guard).
  //
  // `CCFF_lelene_ring_en` is stored mixed-case; every other surface in this project reports record
  // ids lowercase. A case-sensitive membership test rejects a CORRECT citation of a real record —
  // and every deny test above stays green while it does, because they all use invented ids.
  //
  // A false violation is worse than a missing guard here: it makes valid insights un-publishable,
  // and the fix someone reaches for at 6pm is to turn the guard off.
  const r = validateInsight(insight({ citations: ['ccff_lelene_ring_en'] }), evidence);
  assert.equal(r.ok, true);
});

test('⭐ an obtainability claim is REJECTED even though it is probably TRUE of the real game', () => {
  // The named trap, verbatim from the 07-28 assessment. Note the assertion is not that the
  // sentence is false — it may well be accurate about Morrowind. It is that OUR DATA CANNOT
  // ESTABLISH IT, and a claim indistinguishable from a computed one must not ride along.
  const r = validateInsight(
    insight({ recommendation: 'Players can buy one from most apothecaries, so just add a hint.' }),
    evidence,
  );
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && rules(r.violations).includes('reachability_claim'));
});

test('an empty rationale is REJECTED — a headline with no support is an unbacked claim', () => {
  const r = validateInsight(insight({ rationale: '   ' }), evidence);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && rules(r.violations).includes('empty_field'));
});

test('violations accumulate — the report names every rule broken, not just the first', () => {
  const r = validateInsight(
    insight({
      rationale: 'A +15 boost is sold by merchants.',
      citations: ['nope'],
    }),
    evidence,
  );
  assert.equal(r.ok, false);
  assert.ok(r.ok === false);
  const broken = new Set(rules(r.violations));
  assert.ok(broken.has('unknown_number'));
  assert.ok(broken.has('reachability_claim'));
  assert.ok(broken.has('uncited_record'));
});

test('⚠️ DOCUMENTS A LIMIT: a whitelisted number used WRONGLY still passes', () => {
  // This test asserts the guard's boundary rather than its power, and it is here so the suite
  // cannot be read as proving more than it does.
  //
  // 60 is in the evidence (the fail count), so the whitelist permits it — even in a sentence that
  // reports it as a magnitude. Nothing here checks that a claim is a correct INFERENCE from the
  // evidence; that is what human review is for, and why review is a required step rather than a
  // nicety. If a future guard closes this, this test should FLIP, loudly.
  const r = validateInsight(
    insight({ rationale: 'The ring grants 60 Personality.' }),
    evidence,
  );
  assert.equal(r.ok, true);
});
