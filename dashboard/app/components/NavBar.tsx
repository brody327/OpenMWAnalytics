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

  // One tab, rendered identically in both layouts — extracted so the active-state rule cannot
  // drift between the mobile row and the desktop row.
  const tabs = LINKS.map((link) => {
    // Ordinary JavaScript -- this is a function body, so `const` and `if` are fine.
    // Anything more complex than an expression goes here rather than inside the JSX.
    const isActive = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);

    return (
      <li key={link.href} className="shrink-0">
        {/* `key` is Angular's trackBy: it identifies an item across re-renders so React
            updates it instead of destroying and rebuilding. Must be stable and unique
            among siblings -- the href is, an array index would NOT be. */}
        <Link
          href={link.href}
          // A template literal builds the class string. This is where JSX feels verbose
          // compared to [ngClass], and it is the honest trade: no directive, just JS.
          className={`block whitespace-nowrap rounded-md px-3 py-2 text-[13px] font-medium transition-colors sm:px-4 ${
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
  });

  return (
    // `sticky` rather than `fixed`: sticky keeps the header in normal flow, so the content below
    // is not overlapped and needs no compensating top padding — a padding value that would have
    // to be kept in sync with this element's height by hand, forever.
    <header className="sticky top-0 z-50 border-b border-border bg-surface">
      {/* ═══════════════════════════════════════════════════════════════════════════════════
          ⚠️ THIS HEADER SET A 476px MINIMUM WIDTH FOR THE ENTIRE SITE. Measured, not guessed:
          at every viewport below 476px the theme toggle sat at exactly `right: 476`, and the
          document scrolled sideways by precisely `476 − viewport`. Every page inherited it.

          Cause: the wordmark was `shrink-0` (so the long mono subtitle never yielded), the tab
          list was `flex-1 flex-wrap` (so instead of shrinking it wrapped into a VERTICAL stack
          beside the wordmark), and the toggle was pushed off the right edge — unreachable on a
          phone, which is how this was reported.

          ⭐ NO HAMBURGER, and that is a decision rather than a shortcut. A disclosure menu costs
          open/close state, a focus trap, `aria-expanded`, an outside-click handler and an escape
          key — and it would hide FOUR short words behind an extra tap. A horizontally scrollable
          row keeps every destination visible and one tap away, with no JavaScript at all. Reach
          for the menu when the nav outgrows a row, not before.

          The layout below is two rows on a phone and one row from `md` up:

            < md   [ mark + wordmark ................ toggle ]     ← toggle ALWAYS reachable
                   [ tabs → → → scrollable ............... ]
            ≥ md   [ mark + wordmark ]  [ tabs ]  [ toggle ]
          ═══════════════════════════════════════════════════════════════════════════════════ */}
      <nav className="w-full px-4 py-3 sm:px-7 sm:py-3.5">
        <div className="flex w-full items-center gap-4 md:gap-6">
          {/* ── Wordmark ───────────────────────────────────────────────────────────────────
              `min-w-0` is what lets this shrink at all: a flex item's default `min-width:auto`
              refuses to go below its content, which is what pinned the old header open. */}
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            {/* The mark takes `currentColor`, so bronze is applied here rather than inside the
                icon — one asset, and the caller decides. */}
            <MarkIcon className="shrink-0 text-bronze" />
            <span className="flex min-w-0 flex-col leading-none">
              <span className="truncate font-display text-[15px] font-semibold tracking-[0.2px] sm:text-[17px]">
                OpenMW Analytics
              </span>
              {/* The subtitle says what this IS — a visitor landing on a public URL has no other
                  way to know they are looking at an internal developer tool rather than a
                  product. Hidden below `sm` because at 320px it is the single widest element in
                  the header, and a truncated "INTERNAL TELEME…" communicates nothing. */}
              <span className="mt-1 hidden font-mono text-[10px] uppercase tracking-[1px] text-text-faint sm:block">
                Internal telemetry &amp; insight tool
              </span>
            </span>
          </Link>

          {/* ── Tabs, desktop ────────────────────────────────────────────────────────────
              `flex-1` + `justify-center` centres this group in the space LEFT OVER by the
              wordmark and the toggle — the two neighbours push against it equally. `mx-auto`
              would centre it against the wider of the two, so the tabs would drift as the
              wordmark grows. Hidden below `md`, where it becomes its own row. */}
          <ul className="hidden flex-1 items-center justify-center gap-1 md:flex">{tabs}</ul>

          {/* `ml-auto` on mobile (no flex-1 sibling to push it) and `shrink-0` always, so the
              control the user came for is the last thing that would ever be squeezed. */}
          <div className="ml-auto shrink-0 md:ml-0">
            <ThemeToggle />
          </div>
        </div>

        {/* ── Tabs, mobile ──────────────────────────────────────────────────────────────────
            A scrollable row rather than a wrapping one: wrapping is what turned four tabs into
            a vertical stack and broke the header in the first place. `-mx-4 px-4` lets the row
            scroll edge-to-edge while its first and last items still clear the page gutter.
            `[scrollbar-width:none]` hides the bar on Firefox; the WebKit pseudo-element does the
            same elsewhere. The row is still scrollable by touch, wheel and keyboard. */}
        <ul className="-mx-4 mt-2 flex items-center gap-1 overflow-x-auto px-4 pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
          {tabs}
        </ul>
      </nav>
    </header>
  );
}
