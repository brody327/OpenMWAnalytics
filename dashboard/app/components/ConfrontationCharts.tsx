'use client';

// Recharts must run client-side (SVG + hooks), so this is the 'use client'
// boundary. The Server Component fetches and passes plain data in as props.
//
// Colors come from the dataviz skill's validated default palette. Recharts sets
// `fill`/`stroke` as SVG *attributes*, where CSS var() does not resolve — so we
// detect the theme here and pass concrete hexes per mode (blue is a contrast-safe
// slot on both surfaces). Single series ⇒ no legend (the card title names it);
// values are direct-labelled; a tooltip and a table view round out accessibility.

import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReasonStat, TopicStat } from '../lib/stats';

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

function palette(dark: boolean) {
  return dark
    ? { ink: '#ffffff', muted: '#898781', grid: '#2c2c2a', series: '#3987e5' }
    : { ink: '#0b0b0b', muted: '#898781', grid: '#e1e0d9', series: '#2a78d6' };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

type TooltipEntry = { payload: TopicStat };
function TopicTooltip({ active, payload }: { active?: boolean; payload?: TooltipEntry[] }) {
  if (!active || !payload?.length) return null;
  const t = payload[0].payload;
  return (
    <div className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-lg dark:border-white/10 dark:bg-zinc-900">
      <div className="font-medium">{titleCase(t.topic)}</div>
      <div className="text-zinc-500 dark:text-zinc-400">{titleCase(t.suspect)}</div>
      <div className="mt-1 tabular-nums">
        {pct(t.pass_rate)} passed · {t.passes}/{t.attempts} attempts
      </div>
    </div>
  );
}

export function PassRateChart({ data }: { data: TopicStat[] }) {
  const dark = useDarkMode();
  const c = palette(dark);
  if (!data.length) return <Empty />;
  const rows = data.map((d) => ({ ...d, label: titleCase(d.topic) }));

  return (
    <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 56 + 40)}>
      <BarChart layout="vertical" data={rows} margin={{ top: 4, right: 44, bottom: 4, left: 8 }}>
        <CartesianGrid horizontal={false} stroke={c.grid} />
        <XAxis
          type="number"
          domain={[0, 1]}
          tickFormatter={pct}
          tick={{ fill: c.muted, fontSize: 12 }}
          stroke={c.grid}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={140}
          tick={{ fill: c.muted, fontSize: 12 }}
          stroke={c.grid}
        />
        <Tooltip cursor={{ fill: c.series, fillOpacity: 0.08 }} content={<TopicTooltip />} />
        <Bar dataKey="pass_rate" fill={c.series} radius={[0, 4, 4, 0]} barSize={22} isAnimationActive={false}>
          {/* A data point may lack the key, so Recharts widens this formatter's arg to
              RenderableText (string | number | null | undefined). Leave it un-annotated —
              contextual typing supplies the exact type — and narrow instead of asserting,
              so a missing value renders no label rather than "NaN%". */}
          <LabelList
            dataKey="pass_rate"
            position="right"
            formatter={(v) => (typeof v === 'number' ? pct(v) : '')}
            fill={c.ink}
            fontSize={12}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function FailureReasonChart({ data }: { data: ReasonStat[] }) {
  const dark = useDarkMode();
  const c = palette(dark);
  if (!data.length) return <Empty label="No failed attempts yet." />;
  const rows = data.map((d) => ({ ...d, label: titleCase(d.reason) }));

  return (
    <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 44 + 40)}>
      <BarChart layout="vertical" data={rows} margin={{ top: 4, right: 36, bottom: 4, left: 8 }}>
        <CartesianGrid horizontal={false} stroke={c.grid} />
        <XAxis type="number" allowDecimals={false} tick={{ fill: c.muted, fontSize: 12 }} stroke={c.grid} />
        <YAxis type="category" dataKey="label" width={160} tick={{ fill: c.muted, fontSize: 12 }} stroke={c.grid} />
        <Tooltip cursor={{ fill: c.series, fillOpacity: 0.08 }} />
        <Bar dataKey="count" fill={c.series} radius={[0, 4, 4, 0]} barSize={18} isAnimationActive={false}>
          {rows.map((_, i) => (
            <Cell key={i} />
          ))}
          <LabelList dataKey="count" position="right" fill={c.ink} fontSize={12} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function Empty({ label = 'No data yet.' }: { label?: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
      {label}
    </div>
  );
}
