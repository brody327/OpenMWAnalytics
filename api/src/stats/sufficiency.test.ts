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
