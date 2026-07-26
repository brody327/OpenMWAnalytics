// The "where are players most stuck — look here first" view (design docs 07 / 10 Q1.1).
//
// NOT a client component and NOT a Recharts chart — on purpose. It is ordered data with a
// proportional bar, which a Server Component + a CSS width does better than a charting library:
// zero JS shipped, and the drill-down links are plain <Link>s (URL-as-state) exactly like the
// friction table. You reach for Recharts when you need an interactive plot; a ranked list is
// not that.
//
// WHY A LIST THAT SHOWS THE INGREDIENTS, not a bar chart of the score. The score is a COMPOSITE
// (shrunk_fail_rate × log(attempts), see api/src/stats/ranking.ts). A bare bar would hide WHY a
// row ranks where it does — you could not tell "genuinely brutal" from "merely popular". So the
// row exposes the ingredients: n, and raw_fail_rate → shrunk_fail_rate side by side, which is
// shrinkage visibly at work (a thin extreme rate dragged back toward the global C). Doc 10 §2:
// every view ends in "…so do X"; §3.3: sample size rides next to every rate.
//
// The bar (a single-hue magnitude meter) encodes stuck_score RELATIVE to the top row, so the eye
// lands on "look here first" without reading a number. Single series → no legend (the column
// header names it); one blue hue from the same validated ramp FrictionCharts uses, so the page
// reads as one system. Text stays in ink tokens, never the bar colour (dataviz mark spec).

import Link from 'next/link';
import type { RankedTopic } from '../lib/stats';

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function RankingList({
  data,
  modId,
  minConfidentN = 20,
}: {
  data: RankedTopic[];
  modId: string;
  /** Below this n a rate is de-emphasised, never hidden (design docs 10 §3.3). */
  minConfidentN?: number;
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        No confrontation attempts recorded yet.
      </div>
    );
  }

  // data arrives pre-sorted by stuck_score desc (the API sorts it), so the first row is the max.
  // The meter is proportional to THAT, not to 1.0: this is a relative "look here first" scan, not
  // an absolute scale. Guard a max of 0 (every topic single-attempt / zero-fail) so we never
  // divide by zero — in that case every meter is empty, which is the honest picture.
  const maxScore = data[0].stuck_score || 1;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm tabular-nums">
        <thead className="text-zinc-500 dark:text-zinc-400">
          <tr className="border-b border-black/10 dark:border-white/10">
            <th className="py-2 pr-3 font-medium">#</th>
            <th className="py-2 pr-4 font-medium">Suspect / topic</th>
            <th className="w-[28%] py-2 pr-4 font-medium">Stuck score</th>
            <th className="py-2 pr-4 text-right font-medium">n</th>
            <th className="py-2 pr-4 text-right font-medium">Raw fail</th>
            <th className="py-2 text-right font-medium">Adjusted fail</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r, i) => {
            const width = Math.max(0, (r.stuck_score / maxScore) * 100);
            const lowN = r.attempts < minConfidentN;
            return (
              <tr
                key={`${r.suspect}:${r.topic}`}
                className="border-b border-black/5 dark:border-white/5"
              >
                <td className="py-3 pr-3 text-zinc-400 dark:text-zinc-500">{i + 1}</td>

                <td className="py-3 pr-4">
                  {/* Drill-down: "show me every attempt behind this row" is just a pre-filtered
                      link into the explorer — the same URL-as-state payoff the friction table
                      uses. Nothing is wired; constructing the URL IS constructing the view. */}
                  <Link
                    href={`/events?mod_id=${encodeURIComponent(modId)}&type=ConfrontationAttempted&suspect=${encodeURIComponent(r.suspect)}&topic=${encodeURIComponent(r.topic)}`}
                    className="font-medium underline decoration-dotted underline-offset-4 hover:decoration-solid"
                    title={`See every attempt on ${titleCase(r.suspect)} / ${titleCase(r.topic)}`}
                  >
                    {titleCase(r.topic)}
                  </Link>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    {titleCase(r.suspect)}
                  </span>
                </td>

                {/* The meter. Track + fill; width encodes stuck_score relative to the top row.
                    Rounded right end (dataviz mark spec). Theme-aware via `dark:` (no JS): the
                    fill is one blue from the FrictionCharts ramp, so the page is one system. */}
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-2">
                    <div
                      className="h-2.5 flex-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]"
                      role="presentation"
                    >
                      <div
                        className="h-full rounded-full bg-[#2a78d6] dark:bg-[#5598e7]"
                        style={{ width: `${width.toFixed(1)}%` }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right text-xs text-zinc-500 dark:text-zinc-400">
                      {r.stuck_score.toFixed(2)}
                    </span>
                  </div>
                </td>

                {/* n, de-emphasised when small: shrinkage already demoted its score, but the
                    count itself must still be visible and honest (§3.3). */}
                <td
                  className={
                    lowN
                      ? 'py-3 pr-4 text-right font-normal text-zinc-400 dark:text-zinc-500'
                      : 'py-3 pr-4 text-right'
                  }
                >
                  {r.attempts}
                  {lowN && <span className="ml-1 text-xs">·small</span>}
                </td>

                {/* raw → adjusted, side by side: the whole story of shrinkage in two cells. A
                    thin-sample row shows a big gap (raw 100% → adjusted ~55%); a well-supported
                    row barely moves. Raw is muted because it is the number NOT to trust. */}
                <td className="py-3 pr-4 text-right text-zinc-400 line-through decoration-zinc-300 dark:decoration-zinc-600">
                  {pct(r.raw_fail_rate)}
                </td>
                <td className="py-3 text-right font-medium">{pct(r.shrunk_fail_rate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
