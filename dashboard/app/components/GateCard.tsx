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
//
// ⚠️ ONE DEVIATION FROM THE VISUAL HANDOFF, AND IT IS ON PURPOSE. The design reference tints a
// gate's verdict badge VIOLET when the gate has a pending insight. Not done. Violet has exactly
// one meaning in this system (13 §2): *a machine wrote this*. A verdict is computed by SQL over
// the parsed game files — colouring it violet would say a model decided it. The verdict badge
// therefore stays on the three-way semantic scale (red / amber / green) and violet appears only
// on the generated panel below, where it is true.

const VERDICT_COPY: Record<Verdict, { label: string; detail: string; tone: string }> = {
  no_remedy: {
    label: 'No remedy in the content',
    // Ends in "...so do X" (10 §2). A verdict a reader cannot act on is a statistic.
    detail: 'Nothing in the loaded content closes this gap. The fix is authoring or retuning.',
    tone: 'border-red-border bg-red-bg text-red',
  },
  gamble_only: {
    label: 'Passable only on a good roll',
    detail:
      'A remedy exists but never reliably clears the bar — the gate is a dice roll even for a prepared player.',
    tone: 'border-amber-border bg-amber-bg text-amber',
  },
  remedy_exists: {
    label: 'A reliable remedy exists',
    detail:
      'At least one item closes the gap on every roll. If players still fail, they cannot find it — signpost it.',
    tone: 'border-green-border bg-green-bg text-green',
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
      <dt className="text-[10px] uppercase tracking-[0.8px] text-text-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-[13px] text-text">{value}</dd>
    </div>
  );
}

export function GateCard({ gate, insight }: { gate: Gate; insight?: Insight }) {
  const verdict = VERDICT_COPY[gate.verdict];
  const reach = REACHABLE_COPY[gate.reachable];

  return (
    <li className="rounded-[10px] border border-border bg-surface p-[18px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          {/* ⚠️ The <h3> and the <p> immediately after it are how e2e/gaps.spec.ts reconstructs a
              gate's GRAIN to prove no two cards are the same gate. Keep them adjacent siblings
              and keep the stat/kind/threshold in that paragraph. */}
          {/* break-all — check ids are long single tokens with no wrap opportunity. */}
          <h3 className="break-all font-mono text-[13px] text-text">{gate.check_id}</h3>
          <p className="mt-1 text-xs text-text-faint">
            {gate.stat} ({gate.stat_kind}) · threshold {gate.threshold}
          </p>
        </div>
        <span
          className={`shrink-0 rounded border px-2 py-0.5 text-[11px] font-medium ${verdict.tone}`}
        >
          {verdict.label}
        </span>
      </div>

      <p className="mt-2.5 text-[13px] leading-relaxed text-text-muted">{verdict.detail}</p>

      <dl className="mt-3.5 grid grid-cols-2 gap-3 sm:grid-cols-5">
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
        <p className="mt-2.5 text-xs leading-relaxed text-text-faint">
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
        className="mt-3 inline-block rounded bg-surface-raised px-2 py-0.5 text-xs text-text-muted"
        title={reach.title}
      >
        {reach.label}
        {gate.reachable === 'PLACED' && ` · ${gate.placed_areas} areas`}
      </p>

      {insight ? (
        <div className="mt-4 rounded-lg border border-violet-border bg-violet-bg p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            {/* The label is not decoration. A generated sentence renders in the same font and the
                same confident register as a computed one; the badge is the only thing telling a
                reader which is which. */}
            <span className="rounded bg-violet px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bg">
              Generated · reviewed
            </span>
            <span className="text-xs text-text-muted">{SIGNPOST_COPY[insight.signposting]}</span>
          </div>

          <p className="mt-2.5 text-[13px] font-semibold text-text">{insight.headline}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-text-muted">{insight.rationale}</p>
          <p className="mt-2 text-[13px] leading-relaxed text-text">
            <span className="font-medium">Do this: </span>
            {insight.recommendation}
          </p>

          {/* ⚠️ Both provenance lines are `text-muted`, not `text-faint`. They sit on the
              violet-tinted panel, where the faint token measured 2.75:1 — the two sentences a
              reader needs in order to distrust the generated text would have been the hardest to
              read on the card. Faint is calibrated against the neutral surfaces only. */}
          {insight.citations.length > 0 && (
            <p className="mt-2 text-xs text-text-muted">
              {/* Every id here was checked against the evidence before the row was stored. Showing
                  them lets a reader verify the claim rests on real records rather than trusting
                  that something upstream did. */}
              Cited records: <span className="font-mono">{insight.citations.join(', ')}</span>
            </p>
          )}
          <p className="mt-1 text-xs text-text-muted">
            {insight.model} · every number and cited record checked against the evidence · says
            nothing about whether a remedy can be obtained
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs italic text-text-faint">
          {/* Absence stated, not implied. "No insight yet" and "the model found nothing" are
              different facts, and a blank space would let a reader pick either. */}
          No reviewed insight for this gate yet.
        </p>
      )}
    </li>
  );
}
