// ⚠️ THIS ONE CONSTANT LIVES ALONE, AND THE REASON IS A REAL BUG THAT WAS AVOIDED.
//
// It is needed in two places on opposite sides of the server/client boundary: the inline boot
// script that `app/layout.tsx` (a SERVER Component) serialises into the HTML, and `lib/theme.ts`
// (a `'use client'` module) which writes the value the script reads.
//
// It cannot be exported from `lib/theme.ts`, because every export of a `'use client'` module
// becomes a CLIENT REFERENCE when a Server Component imports it — a proxy standing in for
// "something that exists in the browser bundle", not the string. `JSON.stringify()` on that in
// the layout would embed a placeholder object into the script tag, the script would read a key
// nobody ever writes, and the failure would be perfectly silent: the toggle works, and the
// preference is forgotten on every reload.
//
// A module with no directive is importable from both sides as a plain value, so both halves are
// guaranteed to agree by construction rather than by two matching string literals.

/** Changing this strands every visitor's saved preference. */
export const THEME_STORAGE_KEY = 'omwa-theme';
