'use client';

import { useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY } from './themeStorage';

// The theme, as a value that lives OUTSIDE React.
//
// ⭐ WHERE THE THEME ACTUALLY LIVES: the `data-theme` attribute on <html>. Not React state, not a
// context, not localStorage. Three things read the theme and they must never disagree:
//
//   1. CSS      — the `dark:` variant and every semantic token key off the attribute (globals.css)
//   2. Recharts — needs concrete hex strings, because it writes fill/stroke as SVG *attributes*,
//                 where `var()` does not resolve (see ConfrontationCharts)
//   3. The boot script in layout.tsx, which sets the attribute before React exists at all
//
// A React state variable could not be the source of truth for (1) or (3), so making it one would
// mean keeping a copy in sync with the DOM — the same duplicated-state failure `EventFilters` and
// `SearchBox` avoid by letting the URL own the query. The DOM already holds this value; React
// subscribes to it rather than owning it.
//
// localStorage is PERSISTENCE, not truth. It is written on change and read once, by the boot
// script. Nothing reads it during render, so a stale entry cannot desync the page.

export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Safari in private mode throws on setItem. The theme still applies for this page load;
    // only the persistence is lost, and a broken toggle would be the worse outcome.
  }
}

// Subscribing by MutationObserver rather than by a custom event is deliberate: it observes the
// ATTRIBUTE, so it fires for every writer — this module, the boot script, a devtools edit —
// instead of only for writers that remembered to dispatch. Same reason the store reads the DOM:
// there is one fact, and everything derives from it.
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

/**
 * The current theme, re-rendering the caller when it changes.
 *
 * ⚠️ THE SERVER SNAPSHOT IS `'light'` AND THAT IS A REAL, ACCEPTED COST. The server renders one
 * HTML document for every visitor and cannot know any individual's preference, so React must be
 * given an answer that matches the markup it sent. React uses this value during hydration too,
 * then re-renders with the client value.
 *
 * Concretely: CSS-driven colour has NO flash (the boot script sets the attribute before first
 * paint, and the variables resolve at paint time). Recharts colours DO flash — one frame of
 * light-theme axes on a dark page — because they are JS values baked into SVG attributes during
 * hydration. Removing that would mean either shipping no charts server-side or storing the theme
 * in a cookie the server can read. Both were judged more expensive than one frame, and the choice
 * is recorded here rather than rediscovered.
 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => 'light');
}
