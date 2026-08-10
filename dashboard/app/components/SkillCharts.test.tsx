import { describe, test, expect } from 'vitest';
import { collapseToChecks } from './SkillCharts';
import type { CheckStat } from '../lib/stats';

// THE GRAIN RULE FOR THE MARGIN CHART — `byCheck` is (check_id, skill, stat_type), not check_id.
//
// ⭐ WHY THIS FILE EXISTS AT ALL. The margin chart claimed "one bar per check" while drawing one
// bar per (check, skill, stat_type): `ccff_j_mortar:force` alone is twelve rows, and they all
// rendered under one axis label. Measured 2026-08-10 against live data — 205 rows over 17 checks.
//
// ⚠️ NOTHING WOULD HAVE CAUGHT IT. Recharts sets no React keys here, so there was no console
// warning (unlike the sibling defect in ConfrontationDashboard's table, which the user spotted the
// same day). Playwright cannot read a category axis meaningfully. The only observation a broken
// world is incapable of producing is *the shape of the collapsed array*, which is why the
// collapse was extracted from the render into a function that can be called directly.
//
// This is the third appearance of "check_id is not a key" in the codebase (see 12 §6, GateList).
// Each previous one was fixed at its own call site; this test is the first one that pins the rule.

/** Only the fields the collapse reads; the rest of CheckStat is noise for this rule. */
function row(
  check_id: string,
  skill: string,
  stat_type: string,
  closest_fail_margin: number | null,
  attempts = 10,
): CheckStat {
  return {
    check_id,
    skill,
    stat_type,
    attempts,
    passes: 0,
    pass_rate: 0,
    fluke_passes: 0,
    avg_fail_margin: closest_fail_margin,
    closest_fail_margin,
    worst_fail_margin: closest_fail_margin,
  };
}

describe('collapseToChecks', () => {
  test('⭐⭐ many (skill, stat_type) rows for one check collapse to ONE bar', () => {
    // The defect, stated as data: the shape that used to produce three bars sharing a label.
    const rows = collapseToChecks([
      row('ccff_j_mortar:force', 'security', 'attribute', -3),
      row('ccff_j_mortar:force', 'security', 'skill', -12),
      row('ccff_j_mortar:force', 'personality', 'attribute', -20),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].variants, 'the bar must know it summarises three rows').toBe(3);
  });

  test('⭐ the representative row is the CLOSEST margin, per 07 §5c', () => {
    // Not the first row, not the worst, not an average. "How far short did they fall" is answered
    // by the best attempt — the same rule failureDistance already applies across attempts.
    //
    // Ordered worst-first here on purpose: a `.find()` or a "keep the first" implementation
    // returns -20 and passes any test that only counts bars.
    const rows = collapseToChecks([
      row('ccff_j_mortar:force', 'personality', 'attribute', -20),
      row('ccff_j_mortar:force', 'security', 'skill', -12),
      row('ccff_j_mortar:force', 'security', 'attribute', -3),
    ]);

    expect(rows[0].margin).toBe(-3);
    expect(rows[0].skill).toBe('security');
    expect(rows[0].statType).toBe('attribute');
  });

  test('attempts belongs to the representative row and is NEVER summed', () => {
    // One player action can test several stats, so these rows overlap. Summing would report 300
    // attempts for a check nobody attempted 300 times — a fabricated number, which is the exact
    // failure mode the sample-size discipline in 10 §3.3 exists to prevent.
    const rows = collapseToChecks([
      row('ccff_attic_vent_in:open', 'strength', 'attribute', -5, 100),
      row('ccff_attic_vent_in:open', 'agility', 'skill', -30, 100),
      row('ccff_attic_vent_in:open', 'acrobatics', 'skill', -40, 100),
    ]);

    expect(rows[0].attempts, 'the winning row had 100, not 300').toBe(100);
  });

  test('a tie on margin breaks toward the better-supported row', () => {
    // Without this the representative row depends on API ordering, so the tooltip would name a
    // different stat between two requests with identical data and nothing would look wrong.
    const rows = collapseToChecks([
      row('c:a', 'agility', 'skill', -7, 5),
      row('c:a', 'security', 'skill', -7, 90),
    ]);

    expect(rows[0].skill).toBe('security');
    expect(rows[0].attempts).toBe(90);
  });

  test('a check that has only ever PASSED is absent, not a zero-length bar', () => {
    // null margin means no distance at all. A 0 would read as "missed it by nothing" — a near
    // miss that never happened.
    const rows = collapseToChecks([
      row('c:passed', 'security', 'skill', null),
      row('c:failed', 'security', 'skill', -4),
    ]);

    expect(rows.map((r) => r.label)).toEqual(['C · Failed']);
  });

  test('a check whose SOME variants passed still uses its failed ones', () => {
    // The paired case for the filter above: dropping the whole check because one variant never
    // failed would silently delete real failures.
    const rows = collapseToChecks([
      row('c:mixed', 'security', 'skill', null),
      row('c:mixed', 'agility', 'skill', -9),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].margin).toBe(-9);
    expect(rows[0].variants, 'the null-margin row is not a counted variant').toBe(1);
  });

  test('distinct checks stay distinct, ordered closest-to-worst', () => {
    // The paired case for the collapse: an implementation that returned one row per check_id by
    // throwing rows away would satisfy every test above.
    const rows = collapseToChecks([
      row('c:far', 'security', 'skill', -40),
      row('c:near', 'security', 'skill', -2),
      row('c:mid', 'security', 'skill', -15),
    ]);

    expect(rows.map((r) => r.margin)).toEqual([-2, -15, -40]);
  });

  test('empty input yields no rows rather than throwing', () => {
    expect(collapseToChecks([])).toEqual([]);
  });
});
