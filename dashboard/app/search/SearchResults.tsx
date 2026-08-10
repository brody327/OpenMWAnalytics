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
  const badge = 'rounded border px-1.5 py-0.5 text-[10.5px] font-medium';
  return (
    <span className="flex shrink-0 gap-1">
      {hit.lexical_rank !== null && (
        <span
          className={`${badge} border-blue-border bg-blue-bg text-blue`}
          title={`Ranked #${hit.lexical_rank} by full-text search (word match)`}
        >
          text #{hit.lexical_rank}
        </span>
      )}
      {hit.vector_rank !== null && (
        <span
          className={`${badge} border-violet-border bg-violet-bg text-violet`}
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
      <p className="rounded-lg border border-red-border bg-red-bg px-4 py-3 text-[13px] text-red">
        Search is unavailable — {error ?? 'no response'}.
      </p>
    );
  }

  if (result.results.length === 0) {
    return (
      <p className="text-[13px] text-text-muted">
        No matches for <span className="font-medium text-text">“{result.query}”</span>.
      </p>
    );
  }

  return (
    <div>
      {/* ── The degradation banner (design docs 13, Search screen) ──────────────────────────
          ⚠️ RENDERED FROM `result.mode`, NOT FROM A CONTROL. The visual handoff draws this as a
          two-tab segmented switch the user flips between "Hybrid" and "Word-match only". Its own
          state notes say the real app should reflect the API's ACTUAL degradation rather than a
          manual toggle, and that is right: a user cannot choose to turn the embedding provider
          off, and offering a switch would invite them to think a deliberately worse search is a
          feature. `mode: 'lexical'` means the embedding call FAILED and only half the search ran.

          Said out loud rather than degraded silently: the results are still useful, but a user
          who does not know the meaning-match is missing cannot interpret what they are seeing. */}
      {result.mode === 'lexical' && (
        <p className="mb-4 rounded-lg border border-amber-border bg-amber-bg px-4 py-3 text-[13px] leading-relaxed text-amber">
          <strong className="font-semibold">Word-match only.</strong> Meaning search is
          unavailable, so these results come from full-text matching alone — anything phrased
          differently from your query is missing from this list rather than absent from the corpus.
        </p>
      )}

      <p className="mb-4 text-xs text-text-faint">
        {result.results.length} result{result.results.length === 1 ? '' : 's'} in {result.took_ms}ms
        {' · '}
        {result.mode === 'hybrid' ? 'word + meaning, fused' : 'word match only'}
      </p>

      <ul className="space-y-2.5">
        {result.results.map((hit) => (
          // key = record_id: stable across renders and unique per row. Never the array index --
          // the list reorders on every new query, which is exactly when index keys corrupt state.
          <li
            key={hit.record_id}
            className="rounded-lg border border-border bg-surface px-4 py-3.5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.8px] text-text-faint">
                  {hit.type} · {hit.source}
                </p>
                <p className="mt-1 truncate text-[14.5px] font-semibold text-text">
                  {hit.name ?? <span className="text-text-faint">(unnamed)</span>}
                </p>
              </div>
              <RankBadges hit={hit} />
            </div>
            <p className="mt-2 line-clamp-3 text-[13.5px] leading-relaxed text-text-muted">
              {hit.snippet}
            </p>
            <p className="mt-2 font-mono text-[11px] text-text-faint">{hit.record_id}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
