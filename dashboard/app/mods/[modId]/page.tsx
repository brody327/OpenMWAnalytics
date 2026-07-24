// app/mods/[modId]/page.tsx
//
// The per-mod page. The folder name `[modId]` makes this a DYNAMIC SEGMENT:
//   /mods/ccff   -> modId === 'ccff'
//   /mods/base   -> modId === 'base'
// one file serves every mod. `modId` arrives via the `params` prop (the PATH),
// which is a Promise in Next 16 -- await it. (Query-string values, if you ever
// need them, come from a SEPARATE `searchParams` prop; not needed here.)
//
// This is a Server Component (no 'use client'): it can `await` the data layer
// directly. It shows only what the registry already returns from GET /mods
// (name, counts, first/last seen) -- deliberately NOT per-mod pass-rates etc.,
// which would need a mod_id-filtered stats endpoint we have not designed yet.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMods } from '../../lib/events';
import { MOD_DASHBOARDS } from '../../components/modDashboards';

// first_seen_at / last_seen_at arrive as epoch-MILLISECOND strings (the API casts a
// bigint, which JSON serialises as a string), so Number() before Date(). Passing the
// raw string to Date() would try to parse it as a date STRING and yield Invalid Date.
const fmtDate = (epochMs: string) =>
  new Date(Number(epochMs)).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export default async function ModPage({
  params,
}: {
  params: Promise<{ modId: string }>;
}) {
  const { modId } = await params;

  const { mods, error } = await getMods();

  // Two different "no data" cases that must NOT collapse into one:
  //  - error: the API is unreachable, so we cannot say whether this mod exists.
  //    404 would be a lie ("this mod does not exist") when the truth is "we could
  //    not check". Surface the outage instead.
  //  - fetch succeeded but the id is not in the registry: THAT is a real 404.
  if (error) {
    return (
      <main className="mx-auto w-full max-w-4xl px-6 py-12">
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Could not reach the analytics API: {error}. Try again once it is back.
        </p>
      </main>
    );
  }

  const mod = mods.find((m) => m.mod_id === modId);

  // notFound() throws, unwinding to the nearest not-found.tsx boundary (and a 404
  // status). It never returns, so TypeScript narrows `mod` to defined below it --
  // no non-null assertion needed.
  if (!mod) notFound();

  // Does this mod have a bespoke, domain-aware dashboard? undefined for every mod we
  // have no schema knowledge of (base, unknown, future mods) -- those get only the
  // envelope summary above. The registry is the dispatch; see components/modDashboards.
  const Dashboard = MOD_DASHBOARDS[mod.mod_id];

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <header className="mb-8">
        <Link
          href="/"
          className="text-sm text-zinc-500 underline decoration-dotted underline-offset-4 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          ← Overview
        </Link>
        <p className="mt-4 text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Mod
        </p>
        {/* display_name is nullable (a mod that has only ever been auto-registered from
            traffic has no friendly name yet), so fall back to the id. */}
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {mod.display_name ?? mod.mod_id}
        </h1>
        <p className="mt-2 font-mono text-sm text-zinc-500 dark:text-zinc-400">{mod.mod_id}</p>
      </header>

      <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Events" value={mod.events.toLocaleString()} />
        <StatTile label="Sessions" value={mod.sessions.toLocaleString()} />
        <StatTile label="First seen" value={fmtDate(mod.first_seen_at)} />
        <StatTile label="Last seen" value={fmtDate(mod.last_seen_at)} />
      </section>

      {/* The URL-as-state payoff again, in the other direction: "show me this mod's raw
          events" is just a pre-filtered link into the explorer, no wiring. */}
      <Link
        href={`/events?mod_id=${encodeURIComponent(mod.mod_id)}`}
        className="inline-block rounded-lg border border-black/10 bg-white px-4 py-2 text-sm font-medium hover:bg-black/[0.03] dark:border-white/10 dark:bg-zinc-900/40 dark:hover:bg-white/[0.05]"
      >
        Browse {mod.mod_id} events →
      </Link>

      {/* The domain-aware depth, when this mod has any. Rendered as an async Server
          Component that fetches its own data -- the page never learns what that data is. */}
      {Dashboard && (
        <div className="mt-14">
          <Dashboard />
        </div>
      )}
    </main>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-900/40">
      <div className="text-sm text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
