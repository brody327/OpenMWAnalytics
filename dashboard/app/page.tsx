// Dashboard home.
//
// ⭐ WHAT THIS PAGE LEADS WITH, AND WHY IT IS NOT "AI".
//
// The temptation was a hero banner announcing the LLM layer, since that is the newest and
// flashiest part. Deliberately not done. The question this platform answers well is *"does the
// game contain a remedy for the thing players keep failing?"* — and the honest description of the
// model's role is that it answers ONE question out of six pipeline steps, four of which are SQL.
//
// Leading with "AI" invites the question "so what does the model actually do?", whose honest
// answer is modest. Leading with the FINDING — a skill check nothing in the loaded content can
// satisfy — and then showing the model earning a narrow, defensible keep is the stronger claim,
// because it is the one that survives being asked about. Restraint about where ML belongs is the
// thing worth demonstrating, not enthusiasm for it.
//
// So the order is: the finding → how it was reached → where a model was warranted → the raw
// registry. Each section is what justifies the next.
//
// ⚠️ THE VISUAL REFRESH (design docs 13) CHANGED NO COPY ON THIS PAGE. Every string, every
// sample-size line and the ORDER of the sections are load-bearing claims, several of them pinned
// by e2e/provenance.spec.ts. Colours, type and spacing moved; the argument did not.

import Link from 'next/link';
import { SyntheticBanner } from './components/SyntheticBanner';
import { getMods } from './lib/events';
import { getInsights, getSufficiency } from './lib/gaps';

export default async function Home() {
  // Three independent reads, none blocking the others. A failure in any one degrades its own
  // section rather than the page — the finding is worth showing even if the mod registry is down,
  // and vice versa.
  const [{ mods, error }, { result: suff }, { result: ins }] = await Promise.all([
    getMods(),
    getSufficiency(50),
    getInsights(),
  ]);

  // The headline: a gate with no remedy anywhere in the content. Chosen from live data rather
  // than hardcoded — if the corpus or the telemetry changes and no such gate exists, the section
  // disappears instead of asserting something that stopped being true.
  const noRemedy = suff?.gates.find((g) => g.verdict === 'no_remedy');
  const insight = ins?.insights[0];

  return (
    <main className="mx-auto w-full max-w-[920px] px-4 pt-8 pb-16 sm:px-7 sm:pt-10 sm:pb-20">
      <header className="mb-9">
        <p className="text-xs font-semibold uppercase tracking-[1.2px] text-text-faint">
          OpenMW Analytics
        </p>
        {/* Spectral, and only here. The display face is reserved for page titles and the
            wordmark (13 §3) — a serif on a data label would cost legibility for atmosphere. */}
        <h1 className="mt-2 font-display text-[30px] font-semibold leading-[1.25] text-text">
          What players did, joined to what the game contains.
        </h1>
        <p className="mt-3 max-w-[640px] text-[15px] leading-relaxed text-text-muted">
          A telemetry platform for Morrowind mods. Most analytics can tell an author{' '}
          <em>players are failing here</em>. Because this one also indexes the game&apos;s own data
          files, it can sometimes say something more useful:{' '}
          <em>the failure may not be the player&apos;s fault.</em>
        </p>
      </header>

      {/* ── 1. THE FINDING ───────────────────────────────────────────────────────────────── */}
      {noRemedy && (
        <section className="mb-8 rounded-[10px] border border-red-border bg-red-bg p-[22px]">
          <p className="text-xs font-semibold uppercase tracking-[1.2px] text-red">
            A real finding, from real play
          </p>
          <h2 className="mt-2 text-lg font-semibold text-text">
            Nothing in the loaded content can satisfy this check.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-text">
            {/* `break-all`: `ccff_jeanus_inventory_lockbox_puzzle:guess` is a single unbreakable
                token 43 characters long. Without this it overflowed a 320px screen by ~60px and
                dragged the whole page into horizontal scroll — ids are the one content type here
                that cannot rely on word wrapping. */}
            <code className="break-all font-mono text-[13px]">{noRemedy.check_id}</code> asks for{' '}
            <strong className="font-semibold">
              {noRemedy.stat} {noRemedy.threshold}
            </strong>
            . The 90th-percentile failing player was{' '}
            <strong className="font-semibold">{noRemedy.gap_p90} points short</strong> — and across
            Morrowind, Tribunal, Bloodmoon and the mod itself there is{' '}
            <strong className="font-semibold">no item, potion, spell or enchantment</strong> that
            closes a gap that size.
          </p>
          {/* ⚠️ NO HARDCODED CORPUS COUNT HERE. The first draft said "47,732 game records" — the
              figure from the design docs. Prod actually holds 47,747, because the corpus has been
              re-ingested since. A constant in the copy sitting beside live-fetched numbers is
              derived-artefact drift in the presentation layer, and it would be wrong again after
              the next ingest. Either fetch it or do not state it; this states it qualitatively. */}
          <p className="mt-3 text-[13px] leading-relaxed text-text-muted">
            That is an authoring gap, not a tuning one: no amount of player preparation reaches it.
            Found by joining {noRemedy.fails} recorded failures against every record parsed out of
            the loaded game files — neither half could have found it alone.
          </p>
          {/* Sample size stated inline, per the inventory's rule that no rate appears without n.
              20 failures is a real signal about the CONTENT and a thin one about the population,
              and the copy should not let a reader blur the two. */}
          {/* ⚠️ `text-muted`, not `text-faint`, because this sits on the RED-TINTED card rather
              than on the page. The tint raises the background, and the faint token measured
              2.78:1 against it — the sample-size caveat would have been the least readable
              sentence in the section it qualifies. Faint is calibrated against the three neutral
              surfaces only. */}
          <p className="mt-3 text-xs text-text-muted">
            n = {noRemedy.fails} recorded failures. The claim is about what the content contains,
            which does not depend on how many players hit it.
          </p>
          <Link
            href="/gaps"
            className="mt-4 inline-block text-[13px] font-medium text-red underline underline-offset-4 hover:no-underline"
          >
            See all {suff?.total_gates ?? ''} gates →
          </Link>
        </section>
      )}

      {/* ── 2. HOW ───────────────────────────────────────────────────────────────────────── */}
      <section className="mb-9">
        <h2 className="text-[15px] font-semibold text-text">How it gets there</h2>
        <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-text-muted">
          The Lua sandbox has no network and no filesystem write access, so ingestion is a{' '}
          <em>pull</em> pipeline — the mod prints structured lines and an external shipper tails the
          log.
        </p>
        <ol className="mt-4 space-y-2 text-[13px] text-text-muted">
          {[
            ['Mod emits', 'a structured event line into openmw.log'],
            ['Shipper tails', 'the log and POSTs batches — at-least-once, durable offsets'],
            ['API validates', 'the envelope and upserts idempotently on (session_id, seq)'],
            ['Postgres aggregates', 'via scheduled incremental rollups and index-only scans'],
            ['The corpus joins in', 'the game files themselves, parsed and hybrid-searchable'],
            ['The dashboard asks', '“is there a remedy for this, and can players find it?”'],
          ].map(([a, b]) => (
            <li key={a} className="flex gap-3">
              <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-border-strong" />
              <span>
                <strong className="font-semibold text-text">{a}</strong> {b}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {/* ── 3. THE MODEL, IN ITS PLACE ───────────────────────────────────────────────────── */}
      <section className="mb-9">
        <h2 className="text-[15px] font-semibold text-text">Where a language model earns its keep</h2>
        <p className="mt-1 mb-3.5 max-w-[600px] text-[13px] leading-relaxed text-text-muted">
          Exactly one question here resists SQL. When a remedy <em>does</em> exist, does the
          game&apos;s own dialogue ever point a player at it? That is a judgement about prose, so a
          single bounded call makes it — with every number and every cited record checked against
          the evidence it was given, and a human approving before anything appears here.
        </p>

        {insight ? (
          <div className="rounded-[10px] border border-violet-border bg-violet-bg p-[22px]">
            <div className="flex flex-wrap items-center gap-2">
              {/* The badge's text colour is the PAGE BACKGROUND token, not white. On the light
                  palette a white-on-violet pill at 10px is under the contrast floor; `bg` is the
                  furthest-away neutral in each mode by construction, so the pill stays legible
                  in both without a second rule. */}
              <span className="rounded bg-violet px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bg">
                Generated · reviewed
              </span>
              {/* muted, not faint — violet-tinted background, same reason as the n= line above */}
              <code className="font-mono text-[11px] text-text-muted">{insight.check_id}</code>
            </div>
            <p className="mt-2.5 font-semibold text-text">{insight.headline}</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
              <span className="font-medium text-text">Do this: </span>
              {insight.recommendation}
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-text-faint">
            No insight has been reviewed and approved yet.
          </p>
        )}

        {/* Same measure as every other paragraph on the page. Left unconstrained it ran the full
            920px container while the copy above it wrapped at 600 — one line of text visibly
            wider than the argument it belongs to. */}
        <p className="mt-3 max-w-[600px] text-xs leading-relaxed text-text-faint">
          Four of the six pipeline steps are database queries. The model is given a fixed evidence
          payload, no tools, and one question — and anything it writes that is not traceable to that
          payload is rejected before a human ever sees it.
        </p>
      </section>

      {/* ── 4. THE REGISTRY ──────────────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-[15px] font-semibold text-text">Mods reporting telemetry</h2>
        <p className="mt-1 mb-4 max-w-[640px] text-[13px] leading-relaxed text-text-muted">
          Every mod the platform has recorded events for. Pick one for its activity and, where the
          events are understood, its gameplay analytics.
        </p>

        {/* The banner sits HERE, not at the top of the page: it labels the volume figures below,
            which include seeded rows, and would be false if read as applying to the finding
            above — that section is computed from real play only. */}
        <SyntheticBanner />

        {error ? (
          <p className="rounded-[10px] border border-amber-border bg-amber-bg p-4 text-[13px] text-amber">
            Could not reach the analytics API: {error}.
          </p>
        ) : mods.length === 0 ? (
          <p className="rounded-[10px] border border-border bg-surface-raised p-4 text-[13px] text-text-muted">
            No mods have reported telemetry yet.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {mods.map((mod) => (
              <li key={mod.mod_id}>
                <Link
                  href={`/mods/${encodeURIComponent(mod.mod_id)}`}
                  className="block rounded-[10px] border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-surface-raised"
                >
                  <div className="text-[15px] font-semibold text-text">
                    {mod.display_name ?? mod.mod_id}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-text-faint">{mod.mod_id}</div>
                  <div className="mt-3 flex gap-6 text-[13px] tabular-nums text-text-muted">
                    <span>
                      <span className="font-semibold text-text">{mod.events.toLocaleString()}</span>{' '}
                      events
                    </span>
                    <span>
                      <span className="font-semibold text-text">
                        {mod.sessions.toLocaleString()}
                      </span>{' '}
                      sessions
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
