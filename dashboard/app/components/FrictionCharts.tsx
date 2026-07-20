'use client';

// The sequence view: what players do AFTER a failed attempt (design docs 07 §4).
//
// COLOR DECISION (worth reading before changing it). The four buckets are not
// neutral identities — they are ORDERED by severity, from "engaged with the problem"
// to "stopped playing". So this is an ordinal scale, not a categorical one, and it
// gets a single-hue light→dark ramp rather than four unrelated hues.
//
// The status palette (good/warning/serious/critical) was tried first and REJECTED by
// the dataviz validator: warning ↔ serious measure normal-vision ΔE 13.6, below the
// hard floor of 15, and those two would sit adjacent in every stacked bar. The ramps
// below pass all four ordinal checks in both modes (monotone L, ΔL gaps ≥ 0.06,
// light end clears the surface, single hue) — verified by running the validator, not
// by eyeballing.
//
// Recharts sets fill/stroke as SVG *attributes*, where CSS var() does not resolve,
// so the theme is detected here and concrete hexes are passed per mode — same
// approach as ConfrontationCharts.

import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AfterFailureStat } from '../lib/stats';

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

// Ordered best → worst. The order IS the encoding; do not re-sort for aesthetics.
//
// Keep this list in sync with friction.ts's CASE expression. A bucket the SQL can emit
// but this list omits is silently DROPPED from the chart — which is exactly what happened
// when ConfrontationExited first started arriving.
export const ACTIONS = [
  { key: 'retried_same', label: 'Retried the topic' },
  { key: 'exited_solved', label: 'Left — suspect finished' },
  { key: 'switched_topic', label: 'Switched topic' },
  { key: 'abandoned', label: 'Abandoned the confrontation' },
  { key: 'session_end', label: 'Session ended' },
] as const;

// Validated ordinal ramps (blue), 5 steps. Light: 250/350/450/550/700.
// Dark: 150/250/350/450/600. Both pass all four ordinal checks — re-run the dataviz
// validator if this list ever changes length.
const RAMP_LIGHT = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
const RAMP_DARK = ['#b7d3f6', '#86b6ef', '#5598e7', '#2a78d6', '#184f95'];

// Everything the SQL can emit but ACTIONS does not name — today `left_area` and `other`,
// tomorrow whatever event type gets added next — folds here and is RENDERED, in neutral
// grey outside the ordinal ramp (it has no place on the severity scale). Folding rather
// than dropping is the point: an unnamed bucket must never silently vanish, because that
// failure looks exactly like "this never happens".
const OTHER_KEY = 'other';
const OTHER_LABEL = 'Other / unclassified';
const OTHER_FILL = { light: '#898781', dark: '#898781' };

function chrome(dark: boolean) {
  return dark
    ? { ink: '#ffffff', muted: '#898781', grid: '#2c2c2a', surface: '#1a1a19' }
    : { ink: '#0b0b0b', muted: '#898781', grid: '#e1e0d9', surface: '#fcfcfb' };
}

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

type Row = { label: string; total: number } & Record<string, string | number>;

/** Pivot the long-format API rows into one stacked row per topic. */
function toRows(data: AfterFailureStat[]): Row[] {
  const byTopic = new Map<string, Row>();
  for (const d of data) {
    const key = `${d.suspect}:${d.topic}`;
    let row = byTopic.get(key);
    if (!row) {
      row = { label: titleCase(d.topic), total: 0 } as Row;
      for (const a of ACTIONS) row[a.key] = 0;
      row[OTHER_KEY] = 0;
      byTopic.set(key, row);
    }
    // Named bucket, or fold into Other — never discard. See OTHER_KEY above.
    const bucket = ACTIONS.some((a) => a.key === d.next_action) ? d.next_action : OTHER_KEY;
    row[bucket] = (row[bucket] as number) + d.count;
    row.total += d.count;
  }
  return [...byTopic.values()].sort((a, b) => b.total - a.total);
}

export function AfterFailureChart({ data }: { data: AfterFailureStat[] }) {
  const dark = useDarkMode();
  const c = chrome(dark);
  const ramp = dark ? RAMP_DARK : RAMP_LIGHT;
  const rows = toRows(data);
  if (!rows.length) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        No failed attempts recorded yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 64 + 64)}>
      <BarChart layout="vertical" data={rows} margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
        <CartesianGrid horizontal={false} stroke={c.grid} />
        <XAxis
          type="number"
          allowDecimals={false}
          tick={{ fill: c.muted, fontSize: 12 }}
          stroke={c.grid}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={150}
          tick={{ fill: c.muted, fontSize: 12 }}
          stroke={c.grid}
        />
        <Tooltip
          cursor={{ fill: ramp[1], fillOpacity: 0.08 }}
          contentStyle={{
            background: c.surface,
            border: `1px solid ${c.grid}`,
            borderRadius: 6,
            fontSize: 13,
            color: c.ink,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: c.muted, paddingTop: 8 }} />
        {ACTIONS.map((a, i) => (
          <Bar
            key={a.key}
            dataKey={a.key}
            name={a.label}
            stackId="a"
            fill={ramp[i]}
            barSize={26}
            isAnimationActive={false}
            // 2px surface gap between stacked segments (dataviz mark spec).
            stroke={c.surface}
            strokeWidth={2}
            radius={0}
          />
        ))}
        <Bar
          key={OTHER_KEY}
          dataKey={OTHER_KEY}
          name={OTHER_LABEL}
          stackId="a"
          fill={dark ? OTHER_FILL.dark : OTHER_FILL.light}
          barSize={26}
          isAnimationActive={false}
          stroke={c.surface}
          strokeWidth={2}
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
