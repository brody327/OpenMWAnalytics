'use client';

import { useSyncExternalStore } from 'react';

// Whether the OS is asking for a dark colour scheme.
//
// This existed three times, byte-identical, in the three chart files — each as a `useState` +
// `useEffect` pair that called `setDark(mq.matches)` on mount. That works, but it is the shape
// `react-hooks/set-state-in-effect` flags, and the rule is right: it renders once with the wrong
// answer, then immediately re-renders with the right one. On a chart that means a flash of
// light-theme axes on a dark page.
//
// `useSyncExternalStore` is the hook built for exactly this — reading a value that lives OUTSIDE
// React and changes on its own. React reads the current value during render, so the first paint
// is already correct, and there is no state to keep in sync.
//
// ⚠️ The third argument is the SERVER snapshot, and it is not optional here. These charts are
// imported by Server Components; without it React throws during SSR, because `window` does not
// exist. `false` is the honest server answer: the server cannot know the client's colour scheme,
// so it renders light and the client corrects on hydration.

const QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function useDarkMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches, // client snapshot
    () => false, // server snapshot — see above
  );
}
