'use client';

import { setTheme } from '../lib/theme';
import { useTheme } from '../lib/theme';

// The light/dark switch (design docs 13 §5).
//
// ⚠️ CHANGED FROM THE PROTOTYPE, DELIBERATELY. The design reference implements this as a
// `<div onClick>`. That is fine in a visual prototype and wrong in the product: a div is not
// focusable, is not reachable by keyboard, announces nothing to a screen reader, and has no
// pressed state to announce. A `<button role="switch">` with `aria-checked` gets Tab, Enter,
// Space and the announcement from the platform, for free.
//
// The pixel spec (44×24 pill, 18px knob travelling 2px ↔ 22px) is reproduced exactly; only the
// element it is built from changed. That is the right way round for a high-fidelity handoff —
// the visual decisions are the designer's, the semantics are the platform's.

export function ThemeToggle() {
  const theme = useTheme();
  const dark = theme === 'dark';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      // Sizes are fixed pixels rather than Tailwind's spacing scale because the knob travel
      // (2px ↔ 22px inside a 44px track) only lands correctly at these exact values.
      className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full border border-border transition-colors"
      style={{
        // The track: mid-grey on light so a near-white knob reads against it; a raised surface on
        // dark so the bronze knob does. Each mode picks the contrast partner for its own knob,
        // which is why this is not one colour with two lightnesses.
        backgroundColor: dark ? 'var(--surface-raised)' : 'var(--border-strong)',
      }}
    >
      <span
        aria-hidden
        className="absolute top-[2px] h-[18px] w-[18px] rounded-full transition-[left] duration-150"
        style={{
          left: dark ? '22px' : '2px',
          backgroundColor: dark ? 'var(--bronze)' : 'var(--surface)',
        }}
      />
    </button>
  );
}
