'use client';

import { useEffect, useRef, useState } from 'react';

// How wide is the box this chart is being drawn into?
//
// ⚠️ WHY THIS IS NEEDED AT ALL. Recharts' `ResponsiveContainer` makes the SVG fluid, which is the
// easy half. The hard half is that a horizontal bar chart's Y AXIS is a fixed pixel `width`, and
// on this dashboard those were 140–190px — chosen against a 920px container. On a 320px phone a
// 190px axis leaves ~90px for every bar, so the data occupies less than a third of the chart and
// the longest labels still truncate. `ResponsiveContainer` cannot fix that: it does not tell its
// children how much room they got.
//
// ⭐ WHY A ResizeObserver RATHER THAN `window.innerWidth`. The question is "how wide is this
// element", not "how wide is the viewport". Those differ whenever the chart is inside a card, a
// grid column, or a container with padding — which is every chart here — and they diverge again
// when the sidebar-free mobile layout changes the gutters. Measuring the element answers the
// question actually being asked, and it also updates on orientation change and on a desktop window
// drag without a resize listener of our own.
//
// ⚠️ The first render returns 0, deliberately. The element does not exist yet, so any other answer
// would be a guess that briefly renders a wrong-sized axis. Callers treat 0 as "not measured yet"
// and fall back to the desktop value, which is correct for the overwhelmingly common case and
// self-corrects on the very next frame.
export function useChartWidth<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Read once immediately: the observer fires asynchronously, and without this the chart paints
    // one frame at the fallback width even when the real width is already known.
    setWidth(el.getBoundingClientRect().width);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}

/**
 * The Y-axis width to use for a horizontal bar chart in a container of `containerWidth`.
 *
 * Category labels here are topic names and check ids, so they need real room — but never more
 * than a bounded share of the chart, or the bars stop being the point. `desktop` is the value the
 * chart was designed with and is returned unchanged once there is room for it.
 */
export function axisWidth(containerWidth: number, desktop: number): number {
  if (containerWidth === 0) return desktop; // not measured yet — see above
  // Never more than 40% of the chart, never less than 72px (below which even a truncated label
  // stops being identifiable), never more than the value the design chose.
  return Math.round(Math.max(72, Math.min(desktop, containerWidth * 0.4)));
}
