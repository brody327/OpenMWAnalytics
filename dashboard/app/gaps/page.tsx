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

// A tile in the summary strip. `tone` is passed as a full class string rather than a colour name
// so Tailwind's scanner can see every literal it must compile — a class assembled from a variable
// at runtime (`border-${tone}-border`) is invisible to the scanner and ships as no CSS at all.
function SummaryTile({
  label,
  value,
  note,
  tone = 'border-border bg-surface text-text',
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <div className={`rounded-[10px] border p-4 ${tone}`}>
      <div className="text-[22px] font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[13px] font-medium">{label}</div>
      <p className="mt-1 text-xs leading-snug opacity-80">{note}</p>
    </div>
  );
}

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

  // ⚠️ SCOPED TO WHAT WAS FETCHED, AND THE LABEL SAYS SO. This counts no-remedy gates among the
  // 25 the endpoint returned, not among all `total_gates` — the other 6,000-odd were never sent,
  // so any figure about them would be invented. The tile's note carries the scope rather than
  // leaving a bare number to be read as a total.
  const noRemedyShown = suff?.gates.filter((g) => g.verdict === 'no_remedy').length ?? 0;

  return (
    <main className="mx-auto w-full max-w-[920px] px-4 pt-8 pb-16 sm:px-7 sm:pt-10 sm:pb-20">
      <p className="text-xs font-semibold uppercase tracking-[1.2px] text-text-faint">
        OpenMW Analytics
      </p>
      <h1 className="mt-2 font-display text-[26px] font-semibold text-text">Content gaps</h1>
      <p className="mt-2.5 max-w-[620px] text-sm leading-relaxed text-text-muted">
        Where players fail a check, and whether the game contains anything that could have helped
        them. Ordered by recorded failures, so the top of this list is what is hurting the most
        players.
      </p>

      {suffError && (
        <p className="mt-6 rounded-lg border border-amber-border bg-amber-bg px-4 py-3 text-[13px] leading-relaxed text-amber">
          {/* No snapshot fallback here (lib/gaps.ts): a stale claim about what the content
              contains is one an author would act on by writing content. Say it is down. */}
          Content analysis is unavailable — {suffError}. Nothing is shown rather than something
          stale, because a stale answer here reads exactly like a fresh one.
        </p>
      )}

      {suff && (
        <>
          {/* ── The summary strip (design docs 13 §6) ────────────────────────────────────────
              ⚠️ THE HANDOFF'S THIRD TILE IS "PENDING REVIEW" AND IT IS NOT BUILT. `GET /insights`
              serves `status = 'approved'` ONLY, enforced in SQL with no parameter to widen it
              (lib/gaps.ts) — so this page cannot count pending items, and rendering a `0` would
              publish a number nobody measured. The honest third tile is how many reviewed
              insights are actually live. A pending count needs a new endpoint and an authenticated
              reviewer view, which is a feature, not a style. */}
          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            <SummaryTile
              label="Gates analysed"
              value={suff.total_gates.toLocaleString()}
              note="Every (check, stat, threshold) combination players have failed at least once."
            />
            <SummaryTile
              label="With no remedy"
              value={String(noRemedyShown)}
              note={`Of the ${suff.gates.length} worst gates shown below — not of all ${suff.total_gates.toLocaleString()}.`}
              tone="border-red-border bg-red-bg text-red"
            />
            <SummaryTile
              label="Reviewed insights live"
              value={String(ins?.insights.length ?? 0)}
              note="Generated, checked against their evidence, and approved by a human."
              tone="border-violet-border bg-violet-bg text-violet"
            />
          </div>

          <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] text-text-muted">
            <span>
              Showing the worst{' '}
              <strong className="font-semibold text-text">{suff.gates.length}</strong> of{' '}
              {/* Truncation stated outright. 25 of 6,687 and 25 of 25 support opposite
                  conclusions about how much of the mod has a content problem. */}
              <strong className="font-semibold text-text">
                {suff.total_gates.toLocaleString()}
              </strong>{' '}
              gates
            </span>
            <span>
              World survey:{' '}
              <strong className="font-semibold text-text">
                {suff.surveyed ? 'ingested' : 'none — every reachability is UNKNOWN'}
              </strong>
            </span>
          </div>

          {/* The caveat rides on the API response and is rendered verbatim. A UI that dropped it
              would be making a claim the API did not. */}
          <p className="mt-3 rounded-lg bg-surface-raised px-4 py-3 text-xs leading-relaxed text-text-muted">
            {suff.reachability_note}
          </p>

          {suff.gates.length === 0 ? (
            <p className="mt-6 text-[13px] text-text-faint">
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
