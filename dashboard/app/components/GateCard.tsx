import type { Gate, Insight, Reachability, Verdict } from '../lib/gaps';

// One content gap, with its generated insight if one has been approved.
//
// A pure Server Component -- no state, no effects, no 'use client'. It renders data the page
// already fetched, so shipping React to the browser for it would buy nothing.
//
// ⚠️ THE RENDERING RULES HERE ARE THE PRODUCT, not styling. Three of them are load-bearing:
//   1. `reachable: UNKNOWN` RENDERS. It is not hidden, greyed out, or collapsed into "no".
//   2. Sample size (`fails`) sits next to every rate-like number (10 §3.3).
//   3. A generated insight is visibly labelled as generated, next to the evidence-backed numbers
//      it sits beside -- a reader must never have to guess which half a machine wrote.

const VERDICT_COPY: Record<Verdict, { label: string; detail: string; tone: string }> = {
  no_remedy: {
    label: 'No remedy in the content',
    // Ends in "...so do X" (10 §2). A verdict a reader cannot act on is a statistic.
    detail: 'Nothing in the loaded content closes this gap. The fix is authoring or retuning.',
    tone: 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200',
  },
  gamble_only: {
    label: 'Passable only on a good roll',
    detail:
      'A remedy exists but never reliably clears the bar — the gate is a dice roll even for a prepared player.',
    tone: 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  },
  remedy_exists: {
    label: 'A reliable remedy exists',
    detail:
      'At least one item closes the gap on every roll. If players still fail, they cannot find it — signpost it.',
    tone: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  },
};

/**
 * ⚠️ `NOT_PLACED` DOES NOT MEAN UNOBTAINABLE, and the label says so in the UI rather than only in
 * the API's note. The survey covers loose items and containers; merchant inventories are
 * deliberately outside it, so a remedy that appears nowhere in the world may still be purchasable.
 * Rendering this as "unreachable" would be the exact overclaim `/stats/sufficiency` was built to
 * avoid, arriving through the front end instead.
 */
const REACHABLE_COPY: Record<Reachability, { label: string; title: string }> = {
  PLACED: {
    label: 'Found in the world',
    title: 'At least one gap-closing remedy appears loose or in a container in the surveyed world.',
  },
  NOT_PLACED: {
    label: 'Not found in the world',
    title:
      'No gap-closing remedy was found loose or in a container. Merchants are NOT surveyed, so this does NOT mean unobtainable.',
  },
  UNKNOWN: {
    label: 'Reachability unknown',
    title:
      'Either no world survey has been ingested, or no gap-closing remedy is of a type the survey can see (a spell is not an object in a container). We did not look, so we are not saying.',
  },
};

const SIGNPOST_COPY: Record<Insight['signposting'], string> = {
  SIGNPOSTED: 'The text points players here',
  NOT_SIGNPOSTED: 'The text never connects a remedy to this gate',
  UNCLEAR: 'Not enough retrieved prose to tell',
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-zinc-900 dark:text-zinc-100">{value}</dd>
    </div>
  );
}

export function GateCard({ gate, insight }: { gate: Gate; insight?: Insight }) {
  const verdict = VERDICT_COPY[gate.verdict];
  const reach = REACHABLE_COPY[gate.reachable];

  return (
    <li className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-mono text-sm text-zinc-900 dark:text-zinc-100">{gate.check_id}</h3>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {gate.stat} ({gate.stat_kind}) · threshold {gate.threshold}
          </p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${verdict.tone}`}>
          {verdict.label}
        </span>
      </div>

      <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{verdict.detail}</p>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {/* Sample size FIRST, because every other number on this card is only as good as it. */}
        <Stat label="Failures" value={String(gate.fails)} hint="Recorded failed attempts (n)." />
        <Stat
          label="Gap p90"
          value={String(gate.gap_p90)}
          hint="How many points short the 90th-percentile failing player was. p90, not max — max is an n=1 estimate."
        />
        <Stat label="Gap p50" value={String(gate.gap_p50)} hint="Median shortfall." />
        <Stat
          label="Reliable"
          value={String(gate.reliable)}
          hint="Remedies whose MINIMUM magnitude covers the gap — they work on every roll."
        />
        <Stat
          label="Possible"
          value={String(gate.possible)}
          hint="Remedies whose MAXIMUM magnitude covers the gap — they work on a good roll. A superset of reliable."
        />
      </dl>

      {gate.unknown_magnitude > 0 && (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {/* Carried, never counted and never dropped: 3 of the 4 commonest Fortify-Personality
              items have no recorded magnitude, so dropping them would report "7 instances exist"
              about a stat the world is generous with. */}
          + {gate.unknown_magnitude} ingredient
          {gate.unknown_magnitude === 1 ? '' : 's'} that affect this stat at a magnitude the game
          files do not record — counted separately, because neither including nor discarding them
          would be honest.
        </p>
      )}

      <p
        className="mt-3 inline-block rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        title={reach.title}
      >
        {reach.label}
        {gate.reachable === 'PLACED' && ` · ${gate.placed_areas} areas`}
      </p>

      {insight ? (
        <div className="mt-4 rounded-md border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-950/30">
          <div className="flex flex-wrap items-center gap-2">
            {/* The label is not decoration. A generated sentence renders in the same font and the
                same confident register as a computed one; the badge is the only thing telling a
                reader which is which. */}
            <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
              Generated · reviewed
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {SIGNPOST_COPY[insight.signposting]}
            </span>
          </div>

          <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {insight.headline}
          </p>
          <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{insight.rationale}</p>
          <p className="mt-2 text-sm text-zinc-900 dark:text-zinc-100">
            <span className="font-medium">Do this: </span>
            {insight.recommendation}
          </p>

          {insight.citations.length > 0 && (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              {/* Every id here was checked against the evidence before the row was stored. Showing
                  them lets a reader verify the claim rests on real records rather than trusting
                  that something upstream did. */}
              Cited records:{' '}
              <span className="font-mono">{insight.citations.join(', ')}</span>
            </p>
          )}
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            {insight.model} · every number and cited record checked against the evidence · says
            nothing about whether a remedy can be obtained
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
          {/* Absence stated, not implied. "No insight yet" and "the model found nothing" are
              different facts, and a blank space would let a reader pick either. */}
          No reviewed insight for this gate yet.
        </p>
      )}
    </li>
  );
}
