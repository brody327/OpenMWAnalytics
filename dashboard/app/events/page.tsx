import { Suspense } from 'react';
import { getEvents, getMods, toQuery, type EventFilters } from '../lib/events';
import { EventFilters as FilterBar } from './EventFilters';
import { EventFeed } from './EventFeed';

// /events — the raw event explorer (design docs 07).
//
// A Server Component, and the filters arrive as `searchParams`. That is not a stylistic
// preference: a Server Component runs once per REQUEST and then is gone -- there is no
// instance, so it cannot hold state. The request IS its input, which makes the query string
// the page's props.
//
// Consequence: changing a filter changes the URL, which is a new request, which re-runs this
// function and its fetch. The client components below are re-rendered with new props but NOT
// remounted, so scroll position and open rows survive.

// ⚠️ Next 16: `searchParams` is a PROMISE and must be awaited. Verified against this project's
// generated types (.next/types/routes.d.ts), not from memory -- see dashboard/AGENTS.md, which
// exists because this Next version postdates most training data.
type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const FILTER_KEYS = ['mod_id', 'type', 'env', 'session_id', 'suspect', 'topic'] as const;

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : undefined;
}

export default async function EventsPage({ searchParams }: PageProps) {
  const params = await searchParams;

  const filters: EventFilters = {};
  for (const key of FILTER_KEYS) {
    const value = one(params[key]);
    if (value) filters[key] = value;
  }

  // The two fetches are independent, so they run concurrently rather than in series. The mod
  // list only populates a dropdown -- if it fails the feed must still render.
  const [{ page, error }, { mods }] = await Promise.all([getEvents(filters, 50), getMods()]);

  // Serialised filters WITHOUT the cursor: "Load more" appends its own, and a stale cursor from
  // the URL would make every subsequent page start from the same place.
  const query = toQuery(filters);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-12">
      <header className="mb-8">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          OpenMW Analytics
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Event explorer</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          Every event as it was recorded. Use it to confirm new instrumentation is firing with
          the payload you expect, or to drill into the individual sessions behind an aggregate.
        </p>
      </header>

      {/* useSearchParams() suspends, so the filter bar needs a boundary. Falling back to a
          fixed-height block keeps the feed from jumping as it hydrates. */}
      <Suspense fallback={<div className="mb-6 h-24 rounded-lg border border-zinc-200 dark:border-zinc-800" />}>
        <FilterBar mods={mods} />
      </Suspense>

      {/* No snapshot fallback here, unlike /stats/* -- an explorer that quietly shows old rows
          while claiming to be a live feed would defeat its own purpose. */}
      {error || !page ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Could not reach the analytics API{error ? `: ${error}` : ''}. The feed is live-only, so
          there is nothing to show until it is reachable.
        </p>
      ) : (
        // `key` forces a fresh component when filters change, so the accumulated pages from the
        // previous filter set cannot leak into the new one.
        <EventFeed key={query} firstPage={page} query={query} />
      )}
    </main>
  );
}
