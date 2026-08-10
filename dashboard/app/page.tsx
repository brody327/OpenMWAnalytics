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
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <header className="mb-10">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          OpenMW Analytics
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          What players did, joined to what the game contains.
        </h1>
        <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
          A telemetry platform for Morrowind mods. Most analytics can tell an author{' '}
          <em>players are failing here</em>. Because this one also indexes the game&apos;s own data
          files, it can sometimes say something more useful:{' '}
          <em>the failure may not be the player&apos;s fault.</em>
        </p>
      </header>

      {/* ── 1. THE FINDING ───────────────────────────────────────────────────────────────── */}
      {noRemedy && (
        <section className="mb-10 rounded-xl border border-red-200 bg-red-50/60 p-6 dark:border-red-900 dark:bg-red-950/30">
          <p className="text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">
            A real finding, from real play
          </p>
          <h2 className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            Nothing in the loaded content can satisfy this check.
          </h2>
          <p className="mt-3 text-zinc-700 dark:text-zinc-300">
            <code className="font-mono text-sm">{noRemedy.check_id}</code> asks for{' '}
            <strong>
              {noRemedy.stat} {noRemedy.threshold}
            </strong>
            . The 90th-percentile failing player was{' '}
            <strong>{noRemedy.gap_p90} points short</strong> — and across Morrowind, Tribunal,
            Bloodmoon and the mod itself there is{' '}
            <strong>no item, potion, spell or enchantment</strong> that closes a gap that size.
          </p>
          {/* ⚠️ NO HARDCODED CORPUS COUNT HERE. The first draft said "47,732 game records" — the
              figure from the design docs. Prod actually holds 47,747, because the corpus has been
              re-ingested since. A constant in the copy sitting beside live-fetched numbers is
              derived-artefact drift in the presentation layer, and it would be wrong again after
              the next ingest. Either fetch it or do not state it; this states it qualitatively. */}
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
            That is an authoring gap, not a tuning one: no amount of player preparation reaches it.
            Found by joining {noRemedy.fails} recorded failures against every record parsed out of
            the loaded game files — neither half could have found it alone.
          </p>
          {/* Sample size stated inline, per the inventory's rule that no rate appears without n.
              20 failures is a real signal about the CONTENT and a thin one about the population,
              and the copy should not let a reader blur the two. */}
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
            n = {noRemedy.fails} recorded failures. The claim is about what the content contains,
            which does not depend on how many players hit it.
          </p>
          <Link
            href="/gaps"
            className="mt-4 inline-block text-sm font-medium text-red-800 underline underline-offset-4 hover:no-underline dark:text-red-300"
          >
            See all {suff?.total_gates ?? ''} gates →
          </Link>
        </section>
      )}

      {/* ── 2. HOW ───────────────────────────────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold">How it gets there</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          The Lua sandbox has no network and no filesystem write access, so ingestion is a{' '}
          <em>pull</em> pipeline — the mod prints structured lines and an external shipper tails the
          log.
        </p>
        <ol className="mt-4 space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
          {[
            ['Mod emits', 'a structured event line into openmw.log'],
            ['Shipper tails', 'the log and POSTs batches — at-least-once, durable offsets'],
            ['API validates', 'the envelope and upserts idempotently on (session_id, seq)'],
            ['Postgres aggregates', 'via scheduled incremental rollups and index-only scans'],
            ['The corpus joins in', 'the game files themselves, parsed and hybrid-searchable'],
            ['The dashboard asks', '“is there a remedy for this, and can players find it?”'],
          ].map(([a, b]) => (
            <li key={a} className="flex gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-600" />
              <span>
                <strong className="font-medium text-zinc-900 dark:text-zinc-100">{a}</strong> {b}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {/* ── 3. THE MODEL, IN ITS PLACE ───────────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold">Where a language model earns its keep</h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
          Exactly one question here resists SQL. When a remedy <em>does</em> exist, does the
          game&apos;s own dialogue ever point a player at it? That is a judgement about prose, so a
          single bounded call makes it — with every number and every cited record checked against
          the evidence it was given, and a human approving before anything appears here.
        </p>

        {insight ? (
          <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50/50 p-4 dark:border-violet-900 dark:bg-violet-950/30">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                Generated · reviewed
              </span>
              <code className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                {insight.check_id}
              </code>
            </div>
            <p className="mt-2 font-medium text-zinc-900 dark:text-zinc-100">{insight.headline}</p>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              <span className="font-medium">Do this: </span>
              {insight.recommendation}
            </p>
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-500">
            No insight has been reviewed and approved yet.
          </p>
        )}

        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-500">
          Four of the six pipeline steps are database queries. The model is given a fixed evidence
          payload, no tools, and one question — and anything it writes that is not traceable to that
          payload is rejected before a human ever sees it.
        </p>
      </section>

      {/* ── 4. THE REGISTRY ──────────────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold">Mods reporting telemetry</h2>
        <p className="mt-1 mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Every mod the platform has recorded events for. Pick one for its activity and, where the
          events are understood, its gameplay analytics.
        </p>

        {/* The banner sits HERE, not at the top of the page: it labels the volume figures below,
            which include seeded rows, and would be false if read as applying to the finding
            above — that section is computed from real play only. */}
        <SyntheticBanner />

        {error ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Could not reach the analytics API: {error}.
          </p>
        ) : mods.length === 0 ? (
          <p className="rounded-lg border border-black/10 bg-black/[0.02] p-4 text-sm text-zinc-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">
            No mods have reported telemetry yet.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {mods.map((mod) => (
              <li key={mod.mod_id}>
                <Link
                  href={`/mods/${encodeURIComponent(mod.mod_id)}`}
                  className="block rounded-xl border border-black/10 bg-white p-5 transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:bg-zinc-900/40 dark:hover:bg-white/[0.05]"
                >
                  <div className="text-lg font-semibold">{mod.display_name ?? mod.mod_id}</div>
                  <div className="mt-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {mod.mod_id}
                  </div>
                  <div className="mt-3 flex gap-6 text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
                    <span>
                      <span className="font-semibold">{mod.events.toLocaleString()}</span> events
                    </span>
                    <span>
                      <span className="font-semibold">{mod.sessions.toLocaleString()}</span> sessions
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
