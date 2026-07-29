import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGate, classifyGates, type GateGap } from './sufficiency.js';

// Smallest-reproducible fixture (teaching protocol §3.5). Four gates, one per branch plus the
// case that motivated three tiers instead of one number. Every field is hand-set; nothing here
// needs a database, which is the point of splitting the classifier out of the handler.
const gate = (over: Partial<GateGap>): GateGap => ({
  check_id: 'ccff_x:open',
  stat: 'security',
  stat_kind: 'skill',
  threshold: 25,
  fails: 100,
  gap_p50: 17,
  gap_p90: 25,
  reliable: 0,
  possible: 0,
  unknown_magnitude: 0,
  placed_remedies: 0,
  placed_areas: 0,
  surveyable_possible: 0,
  ...over,
});

test('no remedy at all -> no_remedy (the authoring/retune verdict)', () => {
  // shortblade @ 25 in the real corpus: nothing Fortify-Shortblade reaches a 25-point gap.
  assert.equal(classifyGate(gate({ reliable: 0, possible: 0 })).verdict, 'no_remedy');
});

test('⭐ possible but never reliable -> gamble_only, the case one predicate cannot express', () => {
  // security @ 25 in the real corpus: the ONLY remedy is `Wild Fortify Security Skill`, which
  // rolls 5-30. It can clear a 25 gap and routinely will not.
  //
  // This assertion is the whole argument for three tiers. Reporting `reliable` alone would call
  // this "no remedy" and send an author off to write content that already exists; reporting
  // `possible` alone would call it "a remedy" and hide that the gate is a dice roll. Both are
  // wrong, and they are wrong in OPPOSITE directions.
  const g = classifyGate(gate({ reliable: 0, possible: 1 }));
  assert.equal(g.verdict, 'gamble_only');
});

test('a reliable remedy exists -> remedy_exists (so the fix is signposting, not authoring)', () => {
  assert.equal(classifyGate(gate({ reliable: 3, possible: 4 })).verdict, 'remedy_exists');
});

test('unknown-magnitude items never change the verdict', () => {
  // luck @ 25 carries 5 INGR effects with no magnitude in the dump. They are REPORTED so the
  // absence is visible, but they must not manufacture a remedy: an item whose magnitude we do
  // not have cannot be shown to close a gap. If this ever fails, something started counting
  // them, which is exactly the "assert a magnitude we lack" error the tier exists to prevent.
  const g = classifyGate(gate({ reliable: 0, possible: 0, unknown_magnitude: 5 }));
  assert.equal(g.verdict, 'no_remedy');
  assert.equal(g.unknown_magnitude, 5);
});

test('⭐⭐ with NO survey ingested, reachability is UNKNOWN — never NOT_PLACED', () => {
  // The dangerous default. With no survey every gate reports zero placements, which is
  // indistinguishable from "surveyed and found nothing" -- and that is the more alarming reading,
  // the one that would send an author writing content that already exists. Absence of data must
  // not render as a finding.
  const g = classifyGate(gate({ possible: 4, placed_remedies: 0, placed_areas: 0 }), false);
  assert.equal(g.reachable, 'UNKNOWN');
  assert.equal(g.placed_remedies, 0);
});

test('with a survey and a placed remedy -> PLACED', () => {
  const g = classifyGate(
    gate({ possible: 4, surveyable_possible: 2, placed_remedies: 2, placed_areas: 35 }),
    true,
  );
  assert.equal(g.reachable, 'PLACED');
  assert.equal(g.placed_areas, 35);
});

test('with a survey, a surveyable remedy, and no placement -> NOT_PLACED (NOT "unobtainable")', () => {
  // Merchants are outside the survey by design, so this value means "not found in the world or a
  // container". The response-level note says so; this test pins that the value is reachable at all.
  const g = classifyGate(
    gate({ possible: 4, surveyable_possible: 3, placed_remedies: 0, placed_areas: 0 }),
    true,
  );
  assert.equal(g.reachable, 'NOT_PLACED');
});

test('⭐⭐ a SPELL-ONLY gate is UNKNOWN, never NOT_PLACED', () => {
  // The real security @ 25 gate: its only remedy is `Wild Fortify Security Skill`, a SPEL. Spells
  // are not objects lying in containers, and an ENCH record is an enchantment *definition* whose
  // carrying item is a different record -- measured, 372 SPEL + 251 ENCH fortify effects with 0
  // placements between them, by construction.
  //
  // Reporting NOT_PLACED here would claim we looked somewhere we cannot look. This is the same
  // overclaim as inferring reachability, reached from the opposite direction, and it is the bug
  // this field exists to prevent.
  const g = classifyGate(
    gate({ possible: 1, surveyable_possible: 0, placed_remedies: 0, placed_areas: 0 }),
    true,
  );
  assert.equal(g.reachable, 'UNKNOWN');
  assert.equal(g.verdict, 'gamble_only'); // the mechanical verdict is unaffected
});

test('⭐ the response note CHANGES with survey state, and names the merchant exclusion', () => {
  const without = classifyGates([gate({})], false);
  const withSurvey = classifyGates([gate({})], true);

  assert.equal(without.surveyed, false);
  assert.match(without.reachability_note, /UNKNOWN and must not be inferred/);

  assert.equal(withSurvey.surveyed, true);
  assert.match(withSurvey.reachability_note, /MERCHANT INVENTORIES ARE NOT SURVEYED/);
  assert.match(withSurvey.reachability_note, /does NOT mean unobtainable/);
});

test('reachable is UNKNOWN on every row, and the note survives on the response', () => {
  // The boundary the corpus cannot cross (11 §13). This is a CORRECTNESS test, not a formatting
  // one: the failure it guards against is a downstream consumer inferring reachability because
  // the field was absent rather than explicitly unknown.
  const rows = [gate({}), gate({ stat: 'luck', stat_kind: 'attribute', reliable: 1, possible: 5 })];
  const result = classifyGates(rows);

  assert.equal(result.gates.length, 2);
  for (const g of result.gates) assert.equal(g.reachable, 'UNKNOWN');
  assert.match(result.reachability_note, /UNKNOWN and must not be inferred/);
});

test('possible is treated as a superset of reliable', () => {
  // Guards the branch ORDER in the classifier. reliable > 0 implies possible > 0 in any row the
  // SQL can produce (max >= min), so this shape should never occur -- but if the SQL ever
  // regressed to produce it, silently calling it 'no_remedy' would hide a real remedy.
  const g = classifyGate(gate({ reliable: 2, possible: 0 }));
  assert.equal(g.verdict, 'no_remedy');
});
