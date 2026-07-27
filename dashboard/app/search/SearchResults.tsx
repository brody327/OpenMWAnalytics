import { getSearch, type SearchHit } from '../lib/search';

// The results list. An ASYNC Server Component -- it awaits the fetch, which means it SUSPENDS,
// which is what lets the <Suspense> boundary in page.tsx show a skeleton.
//
// This is the structural reason the page is split into three files rather than one. A Suspense
// boundary can only suspend what is INSIDE it, so the awaiting work has to be a child. Keeping
// the fetch in page.tsx would suspend the whole page, taking the search box down with it -- and
// the search box is the client component holding `isPending`, so it must stay mounted.

/** How a hit was found. RRF's selling point over a weighted sum is that this is renderable. */
function RankBadges({ hit }: { hit: SearchHit }) {
  const badge = 'rounded px-1.5 py-0.5 text-[11px] font-medium';
  return (
    <span className="flex shrink-0 gap-1">
      {hit.lexical_rank !== null && (
        <span
          className={`${badge} bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300`}
          title={`Ranked #${hit.lexical_rank} by full-text search (word match)`}
        >
          text #{hit.lexical_rank}
        </span>
      )}
      {hit.vector_rank !== null && (
        <span
          className={`${badge} bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300`}
          title={`Ranked #${hit.vector_rank} by vector search (meaning match)`}
        >
          meaning #{hit.vector_rank}
        </span>
      )}
    </span>
  );
}

export async function SearchResults({ q, limit = 20 }: { q: string; limit?: number }) {
  const { result, error } = await getSearch(q, limit);

  if (error || !result) {
    return (
      <p className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800
                    dark:border-red-900 dark:bg-red-950 dark:text-red-300">
        Search is unavailable — {error ?? 'no response'}.
      </p>
    );
  }

  if (result.results.length === 0) {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        No matches for <span className="font-medium">“{result.query}”</span>.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
        {result.results.length} result{result.results.length === 1 ? '' : 's'} in {result.took_ms}ms
        {/* 'lexical' means the embedding call failed and only half the search ran. Said out
            loud rather than degraded silently: the results are still useful, but a user who
            does not know the meaning-match is missing cannot interpret what they are seeing. */}
        {result.mode === 'lexical' && (
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800
                           dark:bg-amber-950 dark:text-amber-300">
            word-match only — meaning search unavailable
          </span>
        )}
      </p>

      <ul className="space-y-3">
        {result.results.map((hit) => (
          // key = record_id: stable across renders and unique per row. Never the array index --
          // the list reorders on every new query, which is exactly when index keys corrupt state.
          <li
            key={hit.record_id}
            className="rounded-md border border-zinc-200 px-4 py-3 dark:border-zinc-800"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {hit.name ?? <span className="text-zinc-500">(unnamed)</span>}
                </p>
                <p className="mt-0.5 text-[11px] uppercase tracking-wide text-zinc-500">
                  {hit.type} · {hit.source}
                </p>
              </div>
              <RankBadges hit={hit} />
            </div>
            <p className="mt-2 line-clamp-3 text-sm text-zinc-600 dark:text-zinc-400">
              {hit.snippet}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
