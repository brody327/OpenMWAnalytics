'use client';

// Skill-check margins (design docs 07 §5b / 10 Q1.2).
//
// The chart answers "by how much did players fall short", one bar per check that has ever
// been failed, ordered closest-to-worst. Margin is negative by construction (value minus
// threshold, for failures), so bars extend LEFT from a zero baseline at the right edge —
// the visual reading is "distance from passing".
//
// ⚠️ "ONE BAR PER CHECK" REQUIRES AN AGGREGATION, and for a long time it silently did not do one.
//
// `byCheck`'s grain is **(check_id, skill, stat_type)**, not `check_id`. `ccff_j_mortar:force` is
// TWELVE rows — security/attribute, security/skill, personality/attribute, … — each with its own
// attempts and margins. Measured against live data 2026-08-10: 205 rows over 17 check_ids.
//
// Feeding those straight to a category axis keyed on `labelFor(check_id)` drew twelve bars sharing
// one axis label, so the sentence above was false and the chart overstated how many distinct
// checks exist. **Nothing warned** — Recharts sets no keys here, so unlike the sibling defect in
// ConfrontationDashboard's table this produced no console error. It is `12 §6` ("`check_id` is not
// a gate key") wearing different clothes, for the third time in this codebase.
//
// ⭐ WHICH ROW REPRESENTS THE CHECK: the one with the GREATEST (least negative) margin — the
// closest anyone got. That is not a new judgement. `07 §5c` already collapses many attempts to
// `max(margin)`, because "how far short did they fall" is best answered by the best attempt.
// Collapsing across stats the same way keeps ONE rule in the product rather than two.
//
// ⚠️ WHAT IS DELIBERATELY *NOT* AGGREGATED: `attempts`. One player action can test several stats,
// so these rows overlap and summing them would count the same attempt repeatedly — a check-level
// total this payload cannot support. The number shown belongs to the single row that produced the
// closest margin, and the tooltip names that stat instead of implying a total.
//
// DELIBERATELY A SINGLE SERIES COLOUR, not banded. Colouring bars by near_miss /
// moderate_gap / build_gap would mean re-implementing the band thresholds here, giving the
// rule two sources of truth that could silently drift apart. The bands are computed
// server-side and shown as their own tiles; this chart shows the raw distance. One rule,
// one place (api/src/stats/skills.ts).

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useChartChrome } from '../lib/chartChrome';
import { axisWidth, useChartWidth } from '../lib/useChartWidth';
import type { CheckStat } from '../lib/stats';

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** "ccff_j_mortar:analyze" -> "J Mortar · Analyze" — ids are stable but not readable. */
function labelFor(checkId: string): string {
  const [record = '', action = ''] = checkId.split(':');
  const rec = titleCase(record.replace(/^ccff_/, ''));
  return action ? `${rec} · ${titleCase(action)}` : rec;
}

type Row = {
  label: string;
  margin: number;
  /** The stat that achieved the closest margin — NOT "the stat this check tests". */
  skill: string;
  statType: string;
  /** Attempts on that one stat. See the header: this is not a check-level total. */
  attempts: number;
  /** How many (skill, stat_type) variants this check was recorded against. */
  variants: number;
};

/**
 * Collapse `byCheck`'s (check_id, skill, stat_type) rows to one row per check.
 *
 * Exported so the rule is testable on its own rather than only through a rendered chart — the
 * grain is the part worth pinning, and it is invisible in the SVG.
 */
export function collapseToChecks(data: CheckStat[]): Row[] {
  const byCheck = new Map<string, { best: CheckStat; variants: number }>();

  for (const d of data) {
    // A check that has only ever passed has no distance at all. Rendering it as a zero-length
    // bar would imply a near miss that never happened.
    if (d.closest_fail_margin === null) continue;

    const entry = byCheck.get(d.check_id);
    if (!entry) {
      byCheck.set(d.check_id, { best: d, variants: 1 });
      continue;
    }
    entry.variants += 1;

    // Greatest margin wins (closest to passing). Ties break on attempts, so the representative
    // row is the better-supported one rather than whichever the API happened to order first —
    // otherwise the chart's tooltip changes between requests for no visible reason.
    const best = entry.best.closest_fail_margin as number;
    const here = d.closest_fail_margin as number;
    if (here > best || (here === best && d.attempts > entry.best.attempts)) entry.best = d;
  }

  return [...byCheck.values()]
    .map(({ best, variants }) => ({
      label: labelFor(best.check_id),
      margin: best.closest_fail_margin as number,
      skill: best.skill,
      statType: best.stat_type,
      attempts: best.attempts,
      variants,
    }))
    .sort((a, b) => b.margin - a.margin);
}

function TooltipBody({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] shadow-lg">
      <div className="font-medium text-text">{r.label}</div>
      <div className="mt-1 tabular-nums text-text">
        {r.margin} from passing — closest on{' '}
        <span className="font-medium">
          {titleCase(r.skill)} ({r.statType})
        </span>
      </div>
      <div className="mt-1 tabular-nums text-text-muted">
        {r.attempts} {r.attempts === 1 ? 'attempt' : 'attempts'} on that stat
      </div>
      {/* Stated, because the bar is a summary of several rows and a reader who does not know that
          would read it as the whole story for this check. */}
      {r.variants > 1 && (
        <div className="mt-1 text-xs text-text-faint">
          closest of {r.variants} stats recorded for this check
        </div>
      )}
    </div>
  );
}

export function MarginChart({ data }: { data: CheckStat[] }) {
  const c = useChartChrome();
  // 190px was the widest fixed axis in the app — on a 320px phone it left ~90px for the bars,
  // i.e. the chart was mostly labels. See lib/useChartWidth.
  const { ref, width } = useChartWidth();

  // One row per check_id. The filtering, collapsing and ordering all live in `collapseToChecks`
  // so the grain rule is a testable function rather than a chain buried in a render.
  const rows = collapseToChecks(data);

  if (!rows.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[13px] text-text-faint">
        No failed skill checks recorded yet.
      </div>
    );
  }

  const min = Math.min(...rows.map((r) => r.margin));

  return (
    <div ref={ref}>
    <ResponsiveContainer width="100%" height={Math.max(140, rows.length * 44 + 48)}>
      <BarChart
        layout="vertical"
        data={rows}
        margin={{ top: 4, right: 12, bottom: 4, left: 8 }}
      >
        <CartesianGrid horizontal={false} stroke={c.grid} />
        <XAxis
          type="number"
          domain={[Math.floor(min * 1.15), 0]}
          allowDecimals={false}
          tick={{ fill: c.muted, fontSize: 12 }}
          stroke={c.grid}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={axisWidth(width, 190)}
          tick={{ fill: c.muted, fontSize: 12 }}
          stroke={c.grid}
        />
        <Tooltip cursor={{ fill: c.series, fillOpacity: 0.08 }} content={<TooltipBody />} />
        {/* The pass line: bars measure distance from it. */}
        <ReferenceLine x={0} stroke={c.muted} strokeWidth={1} />
        <Bar
          dataKey="margin"
          fill={c.series}
          radius={[4, 0, 0, 4]}
          barSize={20}
          isAnimationActive={false}
        >
          <LabelList
            dataKey="margin"
            position="left"
            formatter={(v) => (typeof v === 'number' ? String(v) : '')}
            fill={c.ink}
            fontSize={12}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    </div>
  );
}
