'use client';

import { useState } from 'react';
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
// twice in dev StrictMode. useEffect is for SYNCHRONISING with something outside React, and
// this component has nothing outside React to synchronise with -- so it has NO effects at all.
// The one it used to have is dissected below, because why it was unnecessary is the useful part.

function fmtTime(epochMs: string): string {
  return new Date(Number(epochMs)).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// A one-line preview of the payload, so a collapsed row still says something specific (design
// docs 13 §6 — the explorer's job is confirming instrumentation fires with the payload you
// expect, and "ConfrontationAttempted" alone does not answer that).
//
// ⚠️ SLICED BEFORE IT IS RENDERED, not clipped with CSS. `data` is arbitrary mod-supplied JSON;
// a mod that ships a 40 KB blob would otherwise put 40 KB of text into the DOM on every row and
// hide it with `overflow`. Truncating the STRING keeps the cost proportional to what is shown.
const PREVIEW_MAX = 140;

function summarise(data: unknown): string {
  if (data === null || typeof data !== 'object') return '';
  const parts = Object.entries(data as Record<string, unknown>).map(([k, v]) => {
    const value =
      v === null || v === undefined
        ? '∅'
        : typeof v === 'object'
          ? Array.isArray(v)
            ? `[${v.length}]`
            : '{…}'
          : String(v);
    return `${k}=${value}`;
  });
  const line = parts.join(' · ');
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX)}…` : line;
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

  // ⚠️ There was a `useEffect` here that reset every piece of state when `firstPage` changed,
  // to stop page 2 of "all mods" sitting under page 1 of "ccff only". It was REDUNDANT: the
  // call site already renders `<EventFeed key={query} …>`, so a filter change gives React a
  // different key and it discards this component and mounts a fresh one. The props of a mounted
  // instance never change, and the effect could never fire.
  //
  // Two copies of one rule is worse than one, and the effect was the weaker copy — it reset four
  // state variables but forgot `loading`, so a filter changed mid-fetch would have left "Load
  // more" disabled forever. Remounting resets everything by construction, including the field a
  // hand-written reset can forget. Deleting it also clears `react-hooks/set-state-in-effect`,
  // which was pointing at a real smell rather than a false positive.

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
      <p className="rounded-lg border border-dashed border-border p-8 text-center text-[13px] text-text-faint">
        No events match these filters.
      </p>
    );
  }

  return (
    <div>
      {/* Cards with their own borders rather than a divided list: an expanded row's payload block
          needs a container to sit inside, and a `divide-y` list gives it none — the <pre> would
          bleed to the full page width and stop reading as part of its row. */}
      <ul className="space-y-2">
        {rows.map((e) => {
          // (session_id, seq) is the primary key -- the only guaranteed-unique row identity.
          // Using the array index here would rebind state to the wrong row on append.
          const key = `${e.session_id}:${e.seq}`;
          const isOpen = expanded === key;
          const preview = summarise(e.data);
          return (
            <li
              key={key}
              className={`rounded-lg border bg-surface transition-colors ${
                isOpen ? 'border-border-strong' : 'border-border'
              }`}
            >
              <button
                type="button"
                className="w-full px-3.5 py-2.5 text-left"
                onClick={() => setExpanded(isOpen ? null : key)}
                aria-expanded={isOpen}
              >
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-[11px] text-text-faint">{fmtTime(e.ts)}</span>
                  <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[11px] text-text-muted">
                    {e.mod_id}
                  </span>
                  <span className="text-[13px] font-semibold text-text">{e.type}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-text-faint">
                    {e.session_id.slice(0, 8)}…#{e.seq}
                  </span>
                </span>
                {preview && (
                  <span className="mt-1 block truncate font-mono text-[11px] text-text-muted">
                    {preview}
                  </span>
                )}
              </button>
              {isOpen && (
                <pre className="mx-3.5 mb-3 overflow-x-auto whitespace-pre-wrap break-words rounded bg-surface-raised p-3 font-mono text-[11px] leading-relaxed text-text-muted">
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
            className="rounded-md border border-border bg-surface px-3.5 py-2 text-[13px] font-medium text-text transition-colors hover:bg-surface-raised disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        ) : (
          // Explicit terminator from the API (nextCursor === null), not inferred from a short
          // page -- which would be wrong whenever a page lands exactly on the boundary.
          <span className="text-[13px] text-text-faint">End of feed.</span>
        )}
        <span className="text-[13px] text-text-muted">{rows.length.toLocaleString()} loaded</span>
        {error && <span className="text-[13px] text-red">{error}</span>}
      </div>
    </div>
  );
}
