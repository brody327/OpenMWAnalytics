'use client';

import { useEffect, useState } from 'react';
import type { EventPage, EventRow } from '../lib/events';

// The feed list. Client Component for two reasons: rows expand on click, and "Load more"
// appends pages without navigating.
//
// The first page is rendered ON THE SERVER and handed in as a prop, so the page is useful in
// its first paint with no client fetch and no loading flash. Only subsequent pages are fetched
// here. That split is the point of the App Router: server for the initial data, client for
// interaction, rather than an empty shell that fetches everything after mount.
//
// NOTE what is NOT here: a useEffect that fetches on mount. That is the reflex an Angular
// ngOnInit habit produces, and it would re-fetch data the server already sent, after paint,
// twice in dev StrictMode. useEffect is for SYNCHRONISING with something outside React -- and
// there is exactly one such case below, which is why it appears once and for that reason.

function fmtTime(epochMs: string): string {
  return new Date(Number(epochMs)).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function EventFeed({
  firstPage,
  query,
}: {
  firstPage: EventPage;
  /** The active filters, already serialised. Used verbatim for subsequent pages. */
  query: string;
}) {
  const [rows, setRows] = useState<EventRow[]>(firstPage.events);
  const [cursor, setCursor] = useState<string | null>(firstPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // The one legitimate synchronisation: when the SERVER sends a new first page (the user
  // changed a filter, so this component re-renders with different props), the accumulated
  // client-side pages belong to the OLD filters and must be discarded.
  //
  // Without this, page 2 of "all mods" would still be sitting under page 1 of "ccff only" --
  // stale rows that silently contradict the active filter. This is what useEffect is actually
  // for: reconciling state with a source of truth that lives outside React (here, the URL).
  useEffect(() => {
    setRows(firstPage.events);
    setCursor(firstPage.nextCursor);
    setError(null);
    setExpanded(null);
  }, [firstPage]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      // Same-origin Route Handler, not the Express API directly -- see app/api/events/route.ts.
      const res = await fetch(`/api/events?${query}${query ? '&' : ''}cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error(`request failed (${res.status})`);
      const page = (await res.json()) as EventPage;
      // Append, never replace: this is an accumulating feed. Functional update because the
      // previous value is what we are extending, and a stale closure would drop rows.
      setRows((prev) => [...prev, ...page.events]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load more');
    } finally {
      setLoading(false);
    }
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        No events match these filters.
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {rows.map((e) => {
          // (session_id, seq) is the primary key -- the only guaranteed-unique row identity.
          // Using the array index here would rebind state to the wrong row on append.
          const key = `${e.session_id}:${e.seq}`;
          const isOpen = expanded === key;
          return (
            <li key={key} className="py-2">
              <button
                type="button"
                className="flex w-full items-baseline gap-3 text-left hover:opacity-80"
                onClick={() => setExpanded(isOpen ? null : key)}
                aria-expanded={isOpen}
              >
                <span className="w-40 shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {fmtTime(e.ts)}
                </span>
                <span className="w-16 shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-center text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {e.mod_id}
                </span>
                <span className="font-medium">{e.type}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-zinc-400 dark:text-zinc-500">
                  {e.session_id.slice(0, 8)}…#{e.seq}
                </span>
              </button>
              {isOpen && (
                <pre className="mt-2 overflow-x-auto rounded bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
                  {JSON.stringify(e.data, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-6 flex items-center gap-3">
        {cursor ? (
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        ) : (
          // Explicit terminator from the API (nextCursor === null), not inferred from a short
          // page -- which would be wrong whenever a page lands exactly on the boundary.
          <span className="text-sm text-zinc-500 dark:text-zinc-400">End of feed.</span>
        )}
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {rows.length.toLocaleString()} loaded
        </span>
        {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </div>
  );
}
