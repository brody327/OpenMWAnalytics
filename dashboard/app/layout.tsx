import type { Metadata } from "next";
import { Geist, Geist_Mono, Spectral } from "next/font/google";
import "./globals.css";
import { NavBar } from "./components/NavBar";
import { THEME_STORAGE_KEY } from "./lib/themeStorage";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The display face (design docs 13 §3) — page H1s and the wordmark, nowhere else. Only the two
// weights the design uses are requested; a serif has real per-weight weight, and asking for the
// full family would ship several hundred KB to render about eight words per page.
const spectral = Spectral({
  variable: "--font-spectral",
  subsets: ["latin"],
  weight: ["500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "OpenMW Analytics",
  description: "Telemetry dashboard for OpenMW mods",
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE BOOT SCRIPT — the load-bearing half of the theme system.
//
// ⭐ WHY A BLOCKING INLINE SCRIPT, which is normally a thing to avoid.
//
// The server renders one HTML document for everybody and cannot know a visitor's theme. So SOME
// code has to set `data-theme` in the browser. If that code is React, it cannot run until the
// bundle has downloaded, parsed and hydrated — and the browser will have painted a full light-
// theme page by then. A dark-mode user gets a white flash on EVERY navigation that reloads the
// document. That is the "flash of incorrect theme", and it is not a nicety: it is the single
// most visible bug a theme toggle can ship with.
//
// The fix is the only thing that beats first paint: a synchronous inline script in <head>.
// It is deliberately tiny and dependency-free, because everything after it waits on it.
//
// ⚠️ `suppressHydrationWarning` on <html> is REQUIRED and is not a way of ignoring a problem.
// This script mutates the very attribute React is about to hydrate against, so React WILL find
// the DOM different from its server output. That mismatch is intended and is the whole design;
// the attribute tells React so, and it is scoped to this one element rather than the tree.
//
// PRECEDENCE — an explicit choice beats an inferred one:
//   1. localStorage — the user pressed the toggle. Honour it on every device they set it on.
//   2. prefers-color-scheme — the OS default, for a first visit. This is the ONLY place the media
//      query still reaches the site (globals.css explains why), so deleting it does not fall back
//      to the OS; it pins everyone to light.
//   3. light — if both are unavailable.
//
// The try/catch matters: reading localStorage THROWS in Safari private mode and under some
// cookie-blocking settings. Unguarded, that exception kills the script before it sets the
// attribute, and the whole site renders unstyled-light for those users.
// ═══════════════════════════════════════════════════════════════════════════════════════════
const THEME_BOOT_SCRIPT = `
(function(){
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    var theme = stored === 'dark' || stored === 'light'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // ⚠️⚠️ DO NOT ADD `data-theme` HERE. IT WAS HERE, AND IT BROKE PRODUCTION ONLY.
      //
      // It was seeded to "light" so the server output looked self-contained. The consequence:
      // rendering the attribute as a PROP makes React the owner of it, and React is then entitled
      // to reassert its value on ANY root re-render — silently undoing the boot script.
      //
      // `suppressHydrationWarning` does NOT prevent this. It suppresses the *warning* about the
      // mismatch, not the *reconciliation* that follows it. That distinction is the whole bug.
      //
      // MEASURED on the live site (a stack-trace trap on `setAttribute`, because guessing is what
      // produced the previous two bad checks): two writes to `data-theme` on `/events` — "dark"
      // from the boot script, then "light" from the minified React chunk. Only `/events`, only on
      // Vercel; `next dev` and a local `next start` both showed ONE write and stayed dark. A local
      // check could not have found this, which is why it was found by re-running the theme audit
      // against production after deploying.
      //
      // With the attribute absent from the JSX, React never manages it and the boot script's value
      // stands. The server HTML then carries no `data-theme`, which is safe by construction:
      // globals.css puts the light tokens on `:root` unconditionally and gates dark behind
      // `[data-theme="dark"]`, so "no attribute" already renders as light.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${spectral.variable} h-full antialiased`}
    >
      <head>
        {/* Inline, so there is no `src` for `no-sync-scripts` to object to — and no second
            request, which would defeat the point of running before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      {/*
        `children` is what Angular's <router-outlet> does, but as a PROP rather than a directive:
        Next passes the matched page in, and this file wraps it. A layout does not re-render when
        you navigate between the pages inside it -- so the NavBar below is mounted once and keeps
        its state across navigations.

        Note this file has no 'use client' -- it is a SERVER Component rendering a CLIENT
        Component (NavBar). That direction is always allowed: the server renders the tree and
        marks the client parts for hydration in the browser. The reverse -- importing a Server
        Component into a Client Component -- is not, because by then we are already in the browser.
      */}
      <body className="min-h-full flex flex-col bg-bg text-text">
        <NavBar />
        {children}
      </body>
    </html>
  );
}
