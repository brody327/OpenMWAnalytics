'use client';

// Skill-check margins (design docs 07 §5b / 10 Q1.2).
//
// The chart answers "by how much did players fall short", one bar per check that has ever
// been failed, ordered closest-to-worst. Margin is negative by construction (value minus
// threshold, for failures), so bars extend LEFT from a zero baseline at the right edge —
// the visual reading is "distance from passing".
//
// DELIBERATELY A SINGLE SERIES COLOUR, not banded. Colouring bars by near_miss /
// moderate_gap / build_gap would mean re-implementing the band thresholds here, giving the
// rule two sources of truth that could silently drift apart. The bands are computed
// server-side and shown as their own tiles; this chart shows the raw distance. One rule,
// one place (api/src/stats/skills.ts).

import { useEffect, useState } from 'react';
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
import type { CheckStat } from '../lib/stats';

function useDarkMode(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

function chrome(dark: boolean) {
  return dark
    ? { ink: '#ffffff', muted: '#898781', grid: '#2c2c2a', surface: '#1a1a19', series: '#3987e5' }
    : { ink: '#0b0b0b', muted: '#898781', grid: '#e1e0d9', surface: '#fcfcfb', series: '#2a78d6' };
}

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** "ccff_j_mortar:analyze" -> "J Mortar · Analyze" — ids are stable but not readable. */
function labelFor(checkId: string): string {
  const [record = '', action = ''] = checkId.split(':');
  const rec = titleCase(record.replace(/^ccff_/, ''));
  return action ? `${rec} · ${titleCase(action)}` : rec;
}

type Row = { label: string; margin: number; skill: string; attempts: number };

function TooltipBody({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-lg dark:border-white/10 dark:bg-zinc-900">
      <div className="font-medium">{r.label}</div>
      <div className="text-zinc-500 dark:text-zinc-400">{titleCase(r.skill)}</div>
      <div className="mt-1 tabular-nums">
        {r.margin} from passing · {r.attempts} {r.attempts === 1 ? 'attempt' : 'attempts'}
      </div>
    </div>
  );
}

export function MarginChart({ data }: { data: CheckStat[] }) {
  const dark = useDarkMode();
  const c = chrome(dark);

  // Only checks that have actually been failed have a margin to show. A check that has
  // only ever passed is not "0 short" — it has no distance at all, and rendering it as a
  // zero-length bar would imply a near miss that never happened.
  const rows: Row[] = data
    .filter((d) => d.closest_fail_margin !== null)
    .map((d) => ({
      label: labelFor(d.check_id),
      margin: d.closest_fail_margin as number,
      skill: d.skill,
      attempts: d.attempts,
    }))
    .sort((a, b) => b.margin - a.margin);

  if (!rows.length) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        No failed skill checks recorded yet.
      </div>
    );
  }

  const min = Math.min(...rows.map((r) => r.margin));

  return (
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
          width={190}
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
  );
}
