'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ModRow } from '../lib/events';

// The filter bar. A Client Component -- it needs onChange handlers, which only exist in the
// browser -- but note what it does NOT have: any filter state.
//
// It READS the current filters from the URL and WRITES new ones back to the URL. The answer
// then arrives as fresh props from the server. There is no store, no context, no useEffect
// syncing anything, because there is only ONE copy of this state and the browser owns it.
//
// (Coming from Angular this is the part that feels wrong: no service, no BehaviorSubject, no
// route subscription. The bidirectional sync those exist to manage is not solved here -- it
// is absent, because a second copy of the state never gets created.)
//
// What the URL buys, concretely: every filtered view is shareable, bookmarkable, survives a
// reload, and the BACK BUTTON undoes a filter change for free. A chart elsewhere can deep-link
// into a filtered feed with a plain <a href>. None of that needs code.

/** Filters that live in the URL. `cursor` is deliberately NOT here -- see resetCursor below. */
const FILTER_KEYS = ['mod_id', 'type', 'env', 'session_id', 'suspect', 'topic'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

// Event types worth offering as a quick filter. Not fetched from the API: the type vocabulary
// is governed by the event registry (design docs 03), and a dropdown built from "whatever
// happens to be in the table" would quietly omit an event that has never fired -- which is
// exactly the case you most want to look for when debugging instrumentation.
const KNOWN_TYPES = [
  'ConfrontationAttempted',
  'ConfrontationTopicEntered',
  'ConfrontationExited',
  'EvidenceCollected',
  'SkillCheckResolved',
  'PuzzleAttempted',
  'AreaEntered',
];

export function EventFilters({ mods }: { mods: ModRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // useTransition marks the navigation as non-urgent, which gives us `isPending` while the
  // server renders. Without it the UI would simply freeze on click -- every filter change is a
  // server round-trip, and pretending otherwise is what makes this pattern feel slow.
  const [isPending, startTransition] = useTransition();

  // DRAFT state: what is typed but not yet committed. Local on purpose -- an uncommitted
  // keystroke is not a view anyone would share, and putting it in the URL would mean a request
  // (and a history entry) per character.
  const [draftSession, setDraftSession] = useState(searchParams.get('session_id') ?? '');

  function commit(next: Partial<Record<FilterKey, string>>) {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key); // absent, not empty -- an empty param would still be sent upstream
    }

    // ⚠️ ALWAYS drop the cursor when filters change. A cursor encodes a POSITION WITHIN A
    // SPECIFIC ORDERING of a specific result set; carry it across a filter change and it points
    // into a result set that no longer exists, silently returning a wrong slice with no error.
    params.delete('cursor');

    startTransition(() => {
      // push (not replace) so each filter change is its own history entry and Back undoes it.
      // A drag-frequency control would use replace instead, to avoid flooding history.
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  const current = (key: FilterKey) => searchParams.get(key) ?? '';
  const activeCount = FILTER_KEYS.filter((k) => searchParams.get(k)).length;

  return (
    <div
      className="mb-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      // Communicates "working" to assistive tech, not just visually.
      aria-busy={isPending}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">Mod</span>
          <select
            className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            value={current('mod_id')}
            onChange={(e) => commit({ mod_id: e.target.value })}
          >
            <option value="">All mods</option>
            {mods.map((m) => (
              <option key={m.mod_id} value={m.mod_id}>
                {m.display_name ?? m.mod_id} ({m.events.toLocaleString()})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">Event type</span>
          <select
            className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            value={current('type')}
            onChange={(e) => commit({ type: e.target.value })}
          >
            <option value="">All types</option>
            {KNOWN_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">Source</span>
          <select
            className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
            value={current('env')}
            onChange={(e) => commit({ env: e.target.value })}
          >
            <option value="">dev + prod</option>
            <option value="prod">prod (real players)</option>
            <option value="dev">dev (author)</option>
          </select>
        </label>

        {/* Draft state: committed on submit, not on keystroke. A <form> gives us Enter-to-submit
            for free, and keeps the interaction working without JavaScript reasoning. */}
        <form
          className="flex flex-col gap-1 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            commit({ session_id: draftSession });
          }}
        >
          <label className="text-zinc-500 dark:text-zinc-400" htmlFor="session-filter">
            Session id
          </label>
          <input
            id="session-filter"
            className="rounded border border-zinc-300 bg-transparent px-2 py-1 font-mono text-xs dark:border-zinc-700"
            placeholder="uuid, then Enter"
            value={draftSession}
            onChange={(e) => setDraftSession(e.target.value)}
            size={30}
          />
        </form>

        {activeCount > 0 && (
          <button
            type="button"
            className="rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            onClick={() => {
              setDraftSession('');
              commit(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])));
            }}
          >
            Clear {activeCount} filter{activeCount > 1 ? 's' : ''}
          </button>
        )}

        {isPending && (
          <span className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</span>
        )}
      </div>
    </div>
  );
}
