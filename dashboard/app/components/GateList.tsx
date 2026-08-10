import { GateCard } from './GateCard';
import { gateKey } from '../lib/gaps';
import type { Gate, Insight } from '../lib/gaps';

// The gate list, extracted from `app/gaps/page.tsx` for ONE reason: so that the `key=` below is
// production code a test can render.
//
// ⚠️ It is load-bearing. A gate is identified by (check_id, stat, stat_kind, threshold) — a single
// check_id such as `ccff_j_mortar:force` expands to sixteen distinct gates. Keying on check_id
// alone gives React sixteen siblings with the same key, and React's reconciler is then free to
// reuse the wrong element's state across a re-render.
//
// This lives here rather than inline in the page because the page is an `async` Server Component:
// rendering it in a test is not possible, and a test that re-implemented the `.map()` would be
// asserting on its own copy of the code rather than on the code that ships.
export function GateList({ gates, byGate }: { gates: Gate[]; byGate: Map<string, Insight> }) {
  return (
    <ul className="mt-6 space-y-4">
      {gates.map((g) => (
        <GateCard key={gateKey(g)} gate={g} insight={byGate.get(gateKey(g))} />
      ))}
    </ul>
  );
}
