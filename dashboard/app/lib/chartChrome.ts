'use client';

import { useDarkMode } from './useDarkMode';

// The non-data colours a Recharts chart needs: axis ink, tick text, gridlines, tooltip surface.
//
// ⭐ WHY THIS EXISTS AT ALL — Recharts writes `fill` and `stroke` as SVG PRESENTATION ATTRIBUTES,
// which are set from JavaScript values. A Tailwind class cannot reach them and `var(--text)` does
// not resolve there, so the theme has to be read in JS and handed over as a concrete string.
//
// ⭐ WHY IT IS ONE MODULE AND NOT THREE COPIES. Before the refresh, `chrome()` / `palette()` was
// duplicated byte-for-byte in ConfrontationCharts, FrictionCharts and SkillCharts, and RankingList
// had a fourth copy of two of the values inlined as hex literals. That is four places to update
// and three chances to miss one — and a missed one is invisible: the chart renders, it is just
// wearing the previous palette's greys against the new surface.
//
// ⭐ AND WHY IT READS THE CSS VARIABLES RATHER THAN RESTATING THEM. Hardcoding hexes here would
// recreate the same problem one level up: `globals.css` and this file would each hold a copy of
// the palette, and nothing would fail when they drifted. This is the exact shape of the
// derived-artefact bug this project keeps finding — a value copied out of its source, with no
// check capable of noticing the copy went stale. Reading the variable means there is one palette.
//
// ⚠️ THE SSR FALLBACK IS NOT DECORATION, and it is not the palette either. These charts are
// imported by Server Components, so this runs where `document` does not exist. The fallbacks are
// deliberately the LIGHT palette's values, matching `useTheme`'s server snapshot — if they
// disagreed, the server would render one theme's HTML and claim another.

type Chrome = {
  /** Direct data labels — the highest-contrast text on the chart. */
  ink: string;
  /** Axis ticks and legend text. */
  muted: string;
  /** Gridlines and axis lines. */
  grid: string;
  /** Tooltip background, and the gap stroke between stacked segments. */
  surface: string;
  /**
   * The neutral-data series colour (the palette's `blue`). Here rather than as a `var(--blue)`
   * constant at the call site because `var()` genuinely does not resolve in an SVG presentation
   * attribute — the same reason this whole module exists. A `fill="var(--blue)"` renders BLACK,
   * not "unstyled", so the mistake looks like a deliberate design choice.
   */
  series: string;
};

// Light-palette literals, used ONLY where `document` is unavailable (server render). Kept in sync
// with :root in globals.css by being the same three values; if they drift the cost is one frame
// of slightly-off axes before hydration corrects them, not a wrong page.
const SSR_FALLBACK: Chrome = {
  ink: 'oklch(22% 0.006 60)',
  muted: 'oklch(58% 0.008 60)',
  grid: 'oklch(88% 0.007 60)',
  surface: 'oklch(99% 0.002 60)',
  series: 'oklch(50% 0.13 235)',
};

function readVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Chart chrome for the theme currently on screen.
 *
 * ⚠️ Takes `useDarkMode()` as a dependency even though it never reads the boolean. That is the
 * point: the hook is what SUBSCRIBES this component to theme changes, so the `getComputedStyle`
 * read below re-runs on the render that follows a toggle. Drop the call and the values are read
 * once at mount and then silently frozen — the charts would keep the theme they were born in.
 */
export function useChartChrome(): Chrome {
  useDarkMode();

  if (typeof document === 'undefined') return SSR_FALLBACK;

  return {
    ink: readVar('--text', SSR_FALLBACK.ink),
    muted: readVar('--text-faint', SSR_FALLBACK.muted),
    grid: readVar('--border', SSR_FALLBACK.grid),
    surface: readVar('--surface', SSR_FALLBACK.surface),
    series: readVar('--blue', SSR_FALLBACK.series),
  };
}
