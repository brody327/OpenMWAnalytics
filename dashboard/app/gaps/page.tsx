import type { Metadata } from 'next';
import { GateList } from '../components/GateList';
import { gateKey, getInsights, getSufficiency } from '../lib/gaps';

// /gaps — content sufficiency (design docs 10 Q3.6, 12).
//
// The only view in the platform that joins what players DID to what the game CONTAINS. Every
// other page can say *players are failing here*; this one can say **why that may not be the
// player's fault** — a gate with no remedy in the content is an authoring gap, not a tuning one.
//
// A Server Component: it fetches on the server, renders once, and ships no JavaScript for any of
// this. Both fetches run concurrently because neither needs the other's result — and critically,
// a failure of the INSIGHTS half must not blank the page. The gate numbers are computed and
// trustworthy on their own; the generated layer is the optional garnish, so it degrades to
// nothing while the measurements still render.

const GATE_LIMIT = 25;

export const metadata: Metadata = {
  title: 'Content gaps · OpenMW Analytics',
};

export default async function GapsPage() {
  const [{ result: suff, error: suffError }, { result: ins }] = await Promise.all([
    getSufficiency(GATE_LIMIT),
    getInsights(),
  ]);

  // ⚠️ Keyed on the FULL GATE GRAIN, not check_id. One check_id can be sixteen gates with
  // different stats, thresholds and verdicts (lib/gaps.ts `gateKey`), so a check_id-keyed map
  // would hand the `security@25` insight to the `shortblade@25` card — a real-looking,
  // actionable recommendation about the wrong gate, with nothing to notice.
  const byGate = new Map((ins?.insights ?? []).map((i) => [gateKey(i), i]));

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Content gaps</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
        Where players fail a check, and whether the game contains anything that could have helped
        them. Ordered by recorded failures, so the top of this list is what is hurting the most
        players.
      </p>

      {suffError && (
        <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {/* No snapshot fallback here (lib/gaps.ts): a stale claim about what the content
              contains is one an author would act on by writing content. Say it is down. */}
          Content analysis is unavailable — {suffError}. Nothing is shown rather than something
          stale, because a stale answer here reads exactly like a fresh one.
        </p>
      )}

      {suff && (
        <>
          <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            <span>
              Showing the worst{' '}
              <strong className="text-zinc-900 dark:text-zinc-100">{suff.gates.length}</strong> of{' '}
              {/* Truncation stated outright. 25 of 6,687 and 25 of 25 support opposite
                  conclusions about how much of the mod has a content problem. */}
              <strong className="text-zinc-900 dark:text-zinc-100">
                {suff.total_gates.toLocaleString()}
              </strong>{' '}
              gates
            </span>
            <span>
              World survey:{' '}
              <strong className="text-zinc-900 dark:text-zinc-100">
                {suff.surveyed ? 'ingested' : 'none — every reachability is UNKNOWN'}
              </strong>
            </span>
          </div>

          {/* The caveat rides on the API response and is rendered verbatim. A UI that dropped it
              would be making a claim the API did not. */}
          <p className="mt-3 rounded-md bg-zinc-100 px-4 py-3 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            {suff.reachability_note}
          </p>

          {suff.gates.length === 0 ? (
            <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
              No failed checks recorded yet — nothing to analyse.
            </p>
          ) : (
            <GateList gates={suff.gates} byGate={byGate} />
          )}
        </>
      )}
    </main>
  );
}
