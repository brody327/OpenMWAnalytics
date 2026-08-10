'use client';
// ^ This directive marks the whole FILE as a Client Component: its code is sent to the browser
//   and runs there. Without it, this would be a Server Component -- rendered once on the server,
//   with no hooks and no event handlers. We need it here for exactly one reason: usePathname()
//   asks "what URL is the user on?", which only the browser can answer.
//   Rule of thumb: default to Server Components; opt in to 'use client' when you need state,
//   effects, event handlers, or browser APIs.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MarkIcon } from './MarkIcon';
import { ThemeToggle } from './ThemeToggle';

// The top bar (design docs 13 §6). Sticky, persists across every screen.
//
// It exists because /events was unreachable except by typing the URL, which made two working
// pages feel like two unrelated apps. The refresh gives it the wordmark and the theme control,
// so it is now the one piece of chrome that is genuinely global.

// Plain data, defined outside the component. Anything that does not depend on props or state
// belongs out here: the component function re-runs on every render, so a value defined INSIDE
// would be rebuilt each time for no reason.
//
// ⚠️ FOUR TABS, NOT THE HANDOFF'S FIVE. The design reference lists "Mod Detail" as a nav
// destination; it is not one. /mods/[modId] is a DYNAMIC segment with no canonical instance —
// a tab pointing at it would have to hardcode a mod id, and would then be wrong for every other
// mod and broken the day that one stops reporting. It is reached by picking a mod from the
// overview, which is what the prototype's static screen was standing in for.
const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/events', label: 'Events' },
  { href: '/gaps', label: 'Content gaps' },
  { href: '/search', label: 'Search' },
];

export function NavBar() {
  // A HOOK. Returns the current path ('/events'). It re-runs this component whenever the path
  // changes, which is how the active link stays correct without us subscribing to anything --
  // the React equivalent of injecting Router and watching NavigationEnd.
  const pathname = usePathname();

  return (
    // `sticky` rather than `fixed`: sticky keeps the header in normal flow, so the content below
    // is not overlapped and needs no compensating top padding — a padding value that would have
    // to be kept in sync with this element's height by hand, forever.
    <header className="sticky top-0 z-50 border-b border-border bg-surface">
      {/* Full-bleed, not centred in a container: the bar is chrome, and chrome that stops short
          of the window edge reads as a floating card. The CONTENT below is what gets a measure. */}
      <nav className="flex w-full items-center gap-6 px-7 py-3.5">
        {/* ── Wordmark ─────────────────────────────────────────────────────────────────── */}
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          {/* The mark takes `currentColor`, so bronze is applied here rather than inside the
              icon — one asset, and the caller decides. */}
          <MarkIcon className="text-bronze" />
          <span className="flex flex-col leading-none">
            <span className="font-display text-[17px] font-semibold tracking-[0.2px]">
              OpenMW Analytics
            </span>
            {/* The subtitle says what this IS. A visitor landing on a public URL has no other way
                to know they are looking at an internal developer tool rather than a product. */}
            <span className="mt-1 font-mono text-[10px] uppercase tracking-[1px] text-text-faint">
              Internal telemetry &amp; insight tool
            </span>
          </span>
        </Link>

        {/* ── Tabs ─────────────────────────────────────────────────────────────────────────
            `flex-1` + `justify-center` centres this group in the space LEFT OVER by the wordmark
            and the toggle — the two fixed-width neighbours push against it equally. Using
            `mx-auto` instead would centre it against the wider of the two, so the tabs would
            drift right as the wordmark grows. */}
        <ul className="flex flex-1 flex-wrap items-center justify-center gap-1">
          {/* No *ngFor. `.map()` turns an array of data into an array of elements, and React
              renders arrays directly. The parentheses after => mean "return this JSX"
              (an arrow function returning an object literal would need them anyway). */}
          {LINKS.map((link) => {
            // Ordinary JavaScript -- this is a function body, so `const` and `if` are fine.
            // Anything more complex than an expression goes here rather than inside the JSX.
            const isActive =
              link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);

            return (
              <li key={link.href}>
                {/* `key` is Angular's trackBy: it identifies an item across re-renders so React
                    updates it instead of destroying and rebuilding. Must be stable and unique
                    among siblings -- the href is, an array index would NOT be. */}
                <Link
                  href={link.href}
                  // A template literal builds the class string. This is where JSX feels verbose
                  // compared to [ngClass], and it is the honest trade: no directive, just JS.
                  className={`block rounded-md px-4 py-2 text-[13px] font-medium transition-colors ${
                    isActive
                      ? 'bg-surface-raised text-text'
                      : 'text-text-muted hover:bg-surface-raised/60 hover:text-text'
                  }`}
                  // Tells assistive tech which item is current. `undefined` REMOVES the attribute
                  // -- in JSX a falsy value like undefined/null/false omits it entirely, rather
                  // than rendering aria-current="false", which would be a lie.
                  aria-current={isActive ? 'page' : undefined}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <ThemeToggle />
      </nav>
    </header>
  );
}
