'use client';

import { useTheme } from './theme';

// Whether the page is currently rendering dark.
//
// ⚠️ THE SOURCE CHANGED, AND THAT IS THE POINT OF THIS FILE. It used to read
// `window.matchMedia('(prefers-color-scheme: dark)')` — correct while the OS was the only thing
// that could pick a theme. It no longer is: the site has a real toggle (design docs 13 §5), and
// the OS query cannot see it.
//
// Left as it was, this would have failed in the quietest possible way. Nothing throws, nothing
// logs, the page themes correctly — and the three Recharts files keep painting their axes,
// gridlines and tooltips for whatever the OS asked for, because they are the only consumers of
// this hook. A user who toggles to dark gets a dark page with light-theme charts on it.
//
// So the hook now delegates to the ONE source of truth (lib/theme.ts → the `data-theme`
// attribute) and every reader moves together by construction.
//
// The original reason for `useSyncExternalStore` still holds and is documented there: this is a
// value that lives outside React, React reads it during render rather than in an effect, and the
// server snapshot is the honest "the server cannot know".
//
// KEPT AS A SEPARATE HOOK rather than replacing the call sites with `useTheme() === 'dark'`.
// The charts want a boolean — every one of them immediately branches on it to pick a hex — and
// pushing that comparison into three files would put the string 'dark' in three more places for
// no gain.

export function useDarkMode(): boolean {
  return useTheme() === 'dark';
}
