import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GateList } from './GateList';
import type { Gate, Insight } from '../lib/gaps';

// THE REACT-KEY HALF OF THE GATE-GRAIN BUG — recorded as a known gap in TESTING.md until now.
//
// The bug: `check_id` is not a key. One check such as `ccff_j_mortar:force` expands into sixteen
// gates that differ by (stat, stat_kind, threshold). Keying the list on check_id alone hands
// React sixteen siblings with the same key.
//
// ⚠️ Why the existing E2E test does NOT catch this, and why this file exists:
//   1. The E2E test asserts that rendered cards are distinct. They ARE — wrong keys still render
//      correct markup on a first paint. The damage is state reuse across a re-render, not output.
//   2. React only emits the duplicate-key warning in a DEVELOPMENT build. Playwright drives
//      `next start`, a production build, which strips it. The check is unavailable there by
//      construction.
//
// Vitest runs React in development, so the warning exists to be caught. That is the whole reason
// this one component is worth a jsdom test.

// No `as Gate` cast — the fixture is fully typed on purpose. A cast here would let the fixture
// drift from the real shape and turn a compile error into a runtime one inside the renderer.
const gate = (over: Partial<Gate> = {}): Gate => ({
  check_id: 'ccff_j_mortar:force',
  stat: 'strength',
  stat_kind: 'attribute',
  threshold: 40,
  fails: 9,
  gap_p50: 12,
  gap_p90: 24,
  reliable: 0,
  possible: 0,
  unknown_magnitude: 0,
  placed_remedies: 0,
  placed_areas: 0,
  surveyable_possible: 0,
  verdict: 'no_remedy',
  reachable: 'UNKNOWN',
  ...over,
});

/** Capture React's dev warnings without letting them clutter the run. */
function captureConsole() {
  const messages: string[] = [];
  const record = (...args: unknown[]) => void messages.push(args.map(String).join(' '));
  const errSpy = vi.spyOn(console, 'error').mockImplementation(record);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(record);
  return { messages, restore: () => (errSpy.mockRestore(), warnSpy.mockRestore()) };
}

afterEach(() => vi.restoreAllMocks());

describe('GateList keys', () => {
  // Two gates from the SAME check, differing only in threshold — the exact shape that broke.
  const sameCheckDifferentGates = [gate({ threshold: 40 }), gate({ threshold: 60 })];

  test('⭐⭐ two gates sharing a check_id do not collide on the React key', () => {
    const { messages, restore } = captureConsole();
    try {
      render(<GateList gates={sameCheckDifferentGates} byGate={new Map<string, Insight>()} />);
    } finally {
      restore();
    }

    const dupe = messages.filter((m) => /same key|unique "?key"?/i.test(m));
    expect(dupe, `React reported a key collision:\n${dupe.join('\n')}`).toEqual([]);
  });

  test('the check above is capable of failing — a check_id-only key DOES warn', () => {
    // ⚠️ The mutation check, kept as a test rather than performed once by hand. Without it the
    // assertion above is satisfied by any world in which React never warns at all: a renamed
    // warning string, a React version that dropped it, or jsdom swallowing console output would
    // each turn it permanently green. This proves the detector still detects.
    function BadlyKeyedList({ gates }: { gates: Gate[] }) {
      return (
        <ul>
          {gates.map((g) => (
            <li key={g.check_id}>{g.check_id}</li>
          ))}
        </ul>
      );
    }

    const { messages, restore } = captureConsole();
    try {
      render(<BadlyKeyedList gates={sameCheckDifferentGates} />);
    } finally {
      restore();
    }

    expect(messages.some((m) => /same key|unique "?key"?/i.test(m))).toBe(true);
  });

  test('both gates render, so the keys are not deduplicating real rows', () => {
    // The paired case. "No key warning" is trivially satisfiable by rendering one gate, or none.
    render(<GateList gates={sameCheckDifferentGates} byGate={new Map<string, Insight>()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
