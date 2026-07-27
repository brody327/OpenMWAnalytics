'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

// The search input. A Client Component for exactly two reasons: it needs an onSubmit handler,
// and it needs `isPending`. Note what it does NOT own: the query. The URL owns that.
//
// DECISION 1 (2026-07-27): submit-only, not type-ahead. The distinction that settles it is
// FILTER vs QUERY -- filtering narrows a set the client already holds, so it should feel
// instant and free; querying crosses the network to a system that must do real work (an OpenAI
// embedding call, then an HNSW scan) and needs an explicit trigger. A debounce long enough to
// protect this backend would already have destroyed the type-ahead feel it exists to provide.
//
// DECISION 2: router.push rather than <form method="get">. A plain GET form needs zero
// JavaScript, but it costs a FULL DOCUMENT LOAD per search -- and that cost is additive with
// the embedding round-trip, not an alternative to it. On a page people search repeatedly, that
// is the difference between an app and a document.

export function SearchBox({ placeholder }: { placeholder?: string }) {
  const router = useRouter();
  // Read the committed query from the URL, so Back/Forward put the right text in the box.
  // (This is why useSearchParams is used instead of a `q` prop: a prop would seed useState once
  // and then never resync, leaving the input showing a query the page is no longer displaying.)
  const searchParams = useSearchParams();
  const committed = searchParams.get('q') ?? '';

  // DRAFT state -- what is typed but not yet submitted. Local on purpose, same reasoning as
  // EventFilters: an uncommitted keystroke is not a view anyone would share.
  const [draft, setDraft] = useState(committed);

  // DECISION 3: useTransition is what actually produces the pending state. router.push alone
  // gives none -- the browser simply sits on the old HTML until the server responds, which is
  // WORSE than a full reload because a reload at least shows the browser's own spinner.
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = draft.trim();
    if (next === '' || next === committed) return; // no empty searches, no duplicate work

    startTransition(() => {
      // push, not replace: each search is its own history entry, so Back returns to the
      // previous result set for free.
      router.push(`/search?q=${encodeURIComponent(next)}`);
    });
  }

  return (
    // A real <form> rather than a div + button: Enter-to-submit, and the implicit
    // submit-button semantics, are behaviours the platform already has.
    <form onSubmit={submit} className="flex gap-2">
      <input
        type="search"
        name="q"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder ?? 'Search the game corpus…'}
        aria-label="Search the game corpus"
        className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm
                   placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none
                   dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-600"
      />
      <button
        type="submit"
        // Disabled while in flight so a second Enter cannot queue a duplicate navigation.
        disabled={isPending || draft.trim() === ''}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white
                   disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {isPending ? 'Searching…' : 'Search'}
      </button>
    </form>
  );
}
