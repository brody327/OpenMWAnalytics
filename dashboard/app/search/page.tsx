import { Suspense } from 'react';
import { SearchBox } from './SearchBox';
import { SearchResults } from './SearchResults';

// /search — hybrid search over the game corpus (design docs 11).
//
// A Server Component. The query arrives as `searchParams`, which is the whole design: a Server
// Component runs once per REQUEST and is then gone, so it has no instance and cannot hold
// state. The request IS its input, which makes the query string the page's props.
//
// ⚠️ Next 16: `searchParams` is a PROMISE and must be awaited (see dashboard/AGENTS.md).

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function one(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.trim() : '';
}

function ResultsSkeleton() {
  return (
    <ul className="space-y-2.5" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className="animate-pulse rounded-lg border border-border bg-surface px-4 py-3.5">
          <div className="h-4 w-1/3 rounded bg-surface-raised" />
          <div className="mt-2.5 h-3 w-full rounded bg-surface-raised" />
          <div className="mt-1.5 h-3 w-4/5 rounded bg-surface-raised" />
        </li>
      ))}
    </ul>
  );
}

export default async function SearchPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const q = one(params.q);

  return (
    <main className="mx-auto w-full max-w-[760px] px-4 pt-8 pb-16 sm:px-7 sm:pt-10 sm:pb-20">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[1.2px] text-text-faint">
          OpenMW Analytics
        </p>
        <h1 className="mt-2 font-display text-[26px] font-semibold text-text">Corpus search</h1>
        <p className="mt-2.5 max-w-[640px] text-sm leading-relaxed text-text-muted">
          Hybrid search over 36,567 chunks of Morrowind game data — dialogue, quests, items,
          spells, NPCs and cells. Word matching and meaning matching run separately and their
          rankings are fused, so a result can be found by either.
        </p>
      </header>

      {/* useSearchParams() suspends, so a Client Component that calls it needs a boundary.
          The fallback mirrors the real control's size to avoid a layout shift on hydration. */}
      <Suspense fallback={<div className="h-[42px] rounded-lg bg-surface-raised" />}>
        <SearchBox />
      </Suspense>

      <section className="mt-8">
        {q === '' ? (
          <p className="text-[13px] text-text-muted">
            Try <span className="font-medium text-text">guards demanding bribes</span> — the words
            never appear together in the corpus, so the meaning half has to earn it.
          </p>
        ) : (
          // ⚠️ key={q} is LOAD-BEARING. Without it, navigating ?q=a → ?q=b leaves React looking
          // at the same component in the same position, so it updates in place and the fallback
          // NEVER shows again -- the page would freeze on stale results with no indication.
          // The key tells React "this is a different thing", which re-suspends the boundary.
          //
          // DECISION 3 (2026-07-27): results CLEAR while loading rather than persisting. Search
          // here is submit-only, so an explicit trigger has already told us the user is done
          // with the old set -- and stale results after a submit are indistinguishable from a
          // finished search, which reads as silent failure and invites repeat submissions.
          <Suspense key={q} fallback={<ResultsSkeleton />}>
            <SearchResults q={q} />
          </Suspense>
        )}
      </section>
    </main>
  );
}
