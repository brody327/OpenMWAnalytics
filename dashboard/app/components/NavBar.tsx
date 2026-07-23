'use client';
// ^ This directive marks the whole FILE as a Client Component: its code is sent to the browser
//   and runs there. Without it, this would be a Server Component -- rendered once on the server,
//   with no hooks and no event handlers. We need it here for exactly one reason: usePathname()
//   asks "what URL is the user on?", which only the browser can answer.
//   Rule of thumb: default to Server Components; opt in to 'use client' when you need state,
//   effects, event handlers, or browser APIs.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// The site nav. Small on purpose -- it exists because /events was unreachable except by typing
// the URL, which made two working pages feel like two unrelated apps.

// Plain data, defined outside the component. Anything that does not depend on props or state
// belongs out here: the component function re-runs on every render, so a value defined INSIDE
// would be rebuilt each time for no reason.
const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/events', label: 'Events' },
];

export function NavBar() {
  // A HOOK. Returns the current path ('/events'). It re-runs this component whenever the path
  // changes, which is how the active link stays correct without us subscribing to anything --
  // the React equivalent of injecting Router and watching NavigationEnd.
  const pathname = usePathname();

  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <nav className="mx-auto flex w-full max-w-5xl items-center gap-6 px-6 py-3">
        {/* {expression} drops out of markup into JavaScript. Here it is just a string. */}
        <Link href="/" className="text-sm font-semibold">
          OpenMW Analytics
        </Link>

        <ul className="flex items-center gap-4">
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
                  className={`text-sm transition-colors ${
                    isActive
                      ? 'font-medium text-zinc-900 dark:text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
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
      </nav>
    </header>
  );
}
