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
import { useChartChrome } from '../lib/chartChrome';
import { axisWidth, useChartWidth } from '../lib/useChartWidth';
import { useDarkMode } from '../lib/useDarkMode';
import type { AfterFailureStat } from '../lib/stats';

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
// Deliberately OFF the ordinal ramp and off the semantic palette — it is the bucket with no
// position on the severity scale, and a neutral grey is the only honest place for it.
const OTHER_FILL = '#898781';

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
  const c = useChartChrome();
  const { ref, width } = useChartWidth();
  // ⚠️ The ordinal RAMP still branches on the theme by hand, and does not come from the token
  // palette. That is correct: these five steps were validated as a ramp — monotone lightness,
  // ΔL gaps ≥ 0.06, light end clearing the surface — and the semantic tokens are three unrelated
  // values per hue, not a scale. Pulling the ramp from `--blue*` would silently discard that.
  const dark = useDarkMode();
  const ramp = dark ? RAMP_DARK : RAMP_LIGHT;
  const rows = toRows(data);
  if (!rows.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[13px] text-text-faint">
        No failed attempts recorded yet.
      </div>
    );
  }

  return (
    <div ref={ref}>
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
          width={axisWidth(width, 150)}
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
        {/*
          ⚠️ `formatter` IS LOAD-BEARING HERE, NOT COSMETIC. Recharts paints each legend LABEL in
          its series' colour by default, and `wrapperStyle.color` does not override it — the
          colour is set per item. That put "Retried the topic" on screen as 12px text in the
          ramp's lightest blue: measured 2.05:1 against the card, the worst contrast anywhere in
          the app.

          The swatch already encodes the series. The label is text, so it renders as ink and the
          colour stays where colour belongs.
        */}
        <Legend
          wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
          formatter={(value) => <span style={{ color: c.muted }}>{value}</span>}
        />
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
          fill={OTHER_FILL}
          barSize={26}
          isAnimationActive={false}
          stroke={c.surface}
          strokeWidth={2}
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
    </div>
  );
}
