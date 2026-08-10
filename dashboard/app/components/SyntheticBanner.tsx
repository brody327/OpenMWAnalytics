// "Some of this is seeded" — shown on every view that includes fabricated events.
//
// ⚠️ THIS IS A CORRECTNESS COMPONENT, NOT A DESIGN ONE. On 2026-08-09 the production database was
// seeded with 180,003 synthetic events to give the engineering views real volume. Without this
// banner those pages present `n=3265` for a confrontation topic as though 3,265 people had played
// it. Nobody could tell, which is the whole problem — the same shape as an LLM's fabricated
// reachability claim: fluent, plausible, and indistinguishable from a measurement.
//
// ⭐ WHERE IT MUST NOT APPEAR: `/gaps`. Findings endpoints exclude `env='synthetic'` in SQL
// (design docs 06 §env scope), so that page is real-only and a banner there would be a lie in the
// other direction — undermining trust in the one view whose numbers are entirely genuine.
//
// So placement is per-page and deliberate, not a layout-level default. A global banner would be
// less code and would say something false on the most important page.

export function SyntheticBanner() {
  return (
    <div
      role="note"
      className="mb-6 rounded-lg border border-amber-border bg-amber-bg px-4 py-3 text-[13px] leading-relaxed text-amber"
    >
      <strong className="font-semibold">Includes seeded demo data.</strong>{' '}
      This public instance is padded with ~180,000 generated events so the aggregation, pagination
      and rollup behaviour have real volume to work against. Treat the magnitudes here as{' '}
      <em>shape</em>, not measurement — they describe no real play session.{' '}
      <a href="/gaps" className="underline underline-offset-2 hover:no-underline">
        Content gaps
      </a>{' '}
      is the exception: it excludes seeded rows in SQL and reports only genuine recorded play.
    </div>
  );
}
