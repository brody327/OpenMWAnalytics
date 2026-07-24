// Dashboard home — a Server Component, and now a MOD LIST rather than a single mod's
// cockpit. When the platform went multi-mod, a home page hard-wired to CCFF stopped being
// honest: it presented one mod's confrontation stats as if they were "the dashboard". So
// `/` is now the index -- every mod the platform has ever seen -- and each mod's depth
// lives at /mods/[modId]. CCFF's confrontation dashboard moved there (see
// components/ConfrontationDashboard); a mod with no bespoke view still gets an
// envelope-level summary on its page.

import Link from 'next/link';
import { getMods } from './lib/events';

export default async function Home() {
  const { mods, error } = await getMods();

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <header className="mb-8">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          OpenMW Analytics
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Mods</h1>
        <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Every mod the platform has recorded telemetry for. Pick one to see its activity —
          and, where the mod&apos;s events are understood, its gameplay analytics.
        </p>
      </header>

      {/* Unlike the old CCFF home, there is no snapshot fallback here: /mods is the live
          registry, and a mod list is not a reading anyone can be misled by. Upstream down
          is a plain "can't reach it" state. */}
      {error ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Could not reach the analytics API: {error}.
        </p>
      ) : mods.length === 0 ? (
        <p className="rounded-lg border border-black/10 bg-black/[0.02] p-4 text-sm text-zinc-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">
          No mods have reported telemetry yet.
        </p>
      ) : (
        // getMods() already returns the registry ordered by event volume, so the busiest
        // mods lead without any sorting here.
        <ul className="grid gap-4 sm:grid-cols-2">
          {mods.map((mod) => (
            <li key={mod.mod_id}>
              <Link
                href={`/mods/${encodeURIComponent(mod.mod_id)}`}
                className="block rounded-xl border border-black/10 bg-white p-5 transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:bg-zinc-900/40 dark:hover:bg-white/[0.05]"
              >
                <div className="text-lg font-semibold">{mod.display_name ?? mod.mod_id}</div>
                <div className="mt-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {mod.mod_id}
                </div>
                <div className="mt-3 flex gap-6 text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
                  <span>
                    <span className="font-semibold">{mod.events.toLocaleString()}</span> events
                  </span>
                  <span>
                    <span className="font-semibold">{mod.sessions.toLocaleString()}</span> sessions
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
