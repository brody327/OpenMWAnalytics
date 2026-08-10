// The CCFF-specific dashboard body: confrontations, friction, and skill checks.
//
// Extracted from the old home page when `/` became a mod list (Option A). It now renders
// inside /mods/ccff via the mod-dashboard registry (./modDashboards). It is an async Server
// Component that fetches its OWN data, which is the point: the mod page picks a dashboard by
// mod_id without knowing what data each one needs.
//
// Deliberately NOT generic. Every aggregate here reads CCFF's event schema
// (suspect / topic / passed / skill margins) -- there is no way to read an arbitrary mod's
// jsonb "usefully", because usefulness IS domain knowledge. A mod whose events we don't
// understand gets the envelope-level summary the mod page already shows, not this.

import Link from 'next/link';
import {
  getConfrontationStats,
  getFrictionStats,
  getSkillStats,
  getRankingStats,
} from '../lib/stats';
import { PassRateChart, FailureReasonChart } from './ConfrontationCharts';
import { AfterFailureChart } from './FrictionCharts';
import { MarginChart } from './SkillCharts';
import { RankingList } from './RankingList';

// This dashboard is CCFF-specific; the id scopes the drill-down links into the explorer.
const MOD_ID = 'ccff';

// What each band means for the author — the whole point of bucketing by margin is that
// each band implies a DIFFERENT kind of work. Labels/blurbs live here; the thresholds
// themselves live server-side (api/src/stats/skills.ts) as the single source of truth.
//
// `tone` is a complete class string rather than a colour name spliced into a template. Tailwind
// scans source for literal class names; `border-${x}-border` is invisible to it and compiles to
// nothing, which fails as an unstyled tile rather than as an error.
const BANDS: Record<string, { label: string; implication: string; tone: string }> = {
  near_miss: {
    label: 'Near miss',
    implication: 'Close enough that the bar itself may be a point or two too high.',
    tone: 'border-blue-border bg-blue-bg text-blue',
  },
  moderate_gap: {
    label: 'Moderate gap',
    implication: 'A real gap, but a plausible build could close it.',
    tone: 'border-amber-border bg-amber-bg text-amber',
  },
  build_gap: {
    label: 'Build gap',
    implication: 'Not built for this route. Tuning the threshold will not help.',
    tone: 'border-red-border bg-red-bg text-red',
  },
};

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const pct = (v: number) => `${Math.round(v * 100)}%`;

// Sample-size discipline (design docs 10 §3.3). The population here is one player who
// is also the mod's author, so a rate over a handful of attempts is an anecdote, not a
// measurement. Rendering a confident "70%" over two attempts is the kind of dishonesty
// that makes an analytics dashboard worse than no dashboard. Below this threshold a
// rate is shown but visibly de-emphasised, never hidden — hiding it would be its own
// distortion.
const MIN_CONFIDENT_N = 20;

const whenCaptured = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'an earlier session';

export async function ConfrontationDashboard() {
  // Two independent endpoints, fetched concurrently: neither depends on the other, and
  // each degrades on its own, so one being down must not blank the other.
  const [{ stats, source, capturedAt, error }, friction, skills, ranking] = await Promise.all([
    getConfrontationStats(),
    getFrictionStats(),
    getSkillStats(),
    getRankingStats(),
  ]);

  const byTopic = stats.byTopic;
  const totalAttempts = byTopic.reduce((n, t) => n + t.attempts, 0);
  const totalPasses = byTopic.reduce((n, t) => n + t.passes, 0);
  const overallRate = totalAttempts ? totalPasses / totalAttempts : 0;

  return (
    <>
      {source === 'snapshot' && (
        <div className="mb-8 rounded-lg border border-amber-border bg-amber-bg px-4 py-3 text-[13px] leading-relaxed text-amber">
          <strong className="font-semibold">Showing a saved snapshot.</strong> The live
          analytics API is unreachable, so these figures are from{' '}
          {whenCaptured(capturedAt)} rather than right now.
          <span className="mt-1 block text-xs opacity-70">{error}</span>
        </div>
      )}

      {/* Look here first. A RANKED triage lens over everything below — not a report of the data
          but a judgement about which content deserves attention, from an explicit scoring
          function (design docs 10 Q1.1). It fetches independently, so it states its own
          provenance and degrades on its own. */}
      <section className="mb-14">
        {/* Sans, NOT the display face. Design docs 13 §3 scopes Spectral to page H1s and the
            wordmark; a section heading is navigation furniture inside a data view, and putting a
            serif on it starts the slide toward "a serif site". */}
        <h2 className="text-[19px] font-semibold tracking-tight text-text">Where players are most stuck</h2>
        <p className="mt-2 max-w-2xl text-text-muted">
          Every topic, ranked by a single <em>stuck score</em> so the content that most deserves
          a look sits at the top — high failure that players actually ran into, not a scary
          percentage over one unlucky attempt.
        </p>

        {ranking.source === 'unavailable' ? (
          <div className="mt-6 rounded-[10px] border border-border bg-surface-raised px-4 py-3 text-[13px] leading-relaxed text-text-muted">
            The ranking endpoint is unreachable and no saved snapshot covers it yet, so there is
            nothing to rank right now.
            <span className="mt-1 block text-xs opacity-70">{ranking.error}</span>
          </div>
        ) : (
          <>
            <StaleNotice source={ranking.source} capturedAt={ranking.capturedAt} />
            <Card title="Ranked by stuck score" subtitle="Highest first — start at the top">
              <RankingList data={ranking.stats.ranked} modId={MOD_ID} minConfidentN={MIN_CONFIDENT_N} />
              <p className="mt-4 text-xs leading-relaxed text-text-faint">
                <strong className="font-semibold text-text">How this is ranked.</strong>{' '}
                Stuck score = <em>adjusted</em> failure rate × attempt volume (log-damped). The
                adjusted rate pulls each topic toward the overall failure rate of{' '}
                {pct(ranking.stats.globalFailRate)} by an amount that fades as attempts accrue
                (strength ≈ {ranking.stats.priorStrength} attempts) — so a topic failed once can’t
                outrank one failed forty times, and a single attempt scores zero. It is a
                deliberate, inspectable heuristic, not a model.
              </p>
            </Card>
          </>
        )}
      </section>

      <section>
        {/* Sans, NOT the display face. Design docs 13 §3 scopes Spectral to page H1s and the
            wordmark; a section heading is navigation furniture inside a data view, and putting a
            serif on it starts the slide toward "a serif site". */}
        <h2 className="text-[19px] font-semibold tracking-tight text-text">Confrontations</h2>
        <p className="mt-2 max-w-2xl text-text-muted">
          Where players get stuck: pass-rate and attempt volume per suspect &amp; topic, and
          the failure reasons behind the misses.
        </p>

        <section className="mb-10 mt-6 grid grid-cols-3 gap-4">
          <StatTile label="Attempts" value={totalAttempts.toLocaleString()} />
          <StatTile
            label="Overall pass-rate"
            value={pct(overallRate)}
            lowConfidence={totalAttempts < MIN_CONFIDENT_N}
            note={`n = ${totalAttempts}`}
          />
          <StatTile label="Topics contested" value={byTopic.length.toLocaleString()} />
        </section>

        {totalAttempts < MIN_CONFIDENT_N && (
          <div className="mb-8 rounded-[10px] border border-border bg-surface-raised px-4 py-3 text-[13px] leading-relaxed text-text-muted">
            <strong className="font-semibold text-text">Small sample.</strong>{' '}
            {totalAttempts} recorded {totalAttempts === 1 ? 'attempt' : 'attempts'} across a
            single player. Rates below are shown for shape, not as measurements — treat every
            percentage on this page as an anecdote until the counts grow.
          </div>
        )}

        <Card title="Pass-rate by topic" subtitle="Share of committed attempts that landed">
          <PassRateChart data={byTopic} />
        </Card>

        <Card title="Why players miss" subtitle="Failure reasons across all failed attempts">
          <FailureReasonChart data={stats.byReason} />
        </Card>

        <Card title="Table view">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm tabular-nums">
              <thead className="text-[11px] uppercase tracking-[0.6px] text-text-faint">
                <tr className="border-b border-border">
                  <th className="py-2 pr-4 font-medium">Suspect</th>
                  <th className="py-2 pr-4 font-medium">Topic</th>
                  <th className="py-2 pr-4 text-right font-medium">Attempts</th>
                  <th className="py-2 pr-4 text-right font-medium">Passes</th>
                  <th className="py-2 text-right font-medium">Pass-rate</th>
                </tr>
              </thead>
              <tbody>
                {byTopic.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-4 text-text-faint">
                      No confrontation data yet.
                    </td>
                  </tr>
                ) : (
                  byTopic.map((t) => (
                    <tr key={`${t.suspect}:${t.topic}`} className="border-b border-border/60">
                      <td className="py-2 pr-4">{titleCase(t.suspect)}</td>
                      <td className="py-2 pr-4">{titleCase(t.topic)}</td>
                      <td className="py-2 pr-4 text-right">{t.attempts}</td>
                      <td className="py-2 pr-4 text-right">{t.passes}</td>
                      <td className="py-2 text-right">{pct(t.pass_rate)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      <section className="mt-14">
        {/* Sans, NOT the display face. Design docs 13 §3 scopes Spectral to page H1s and the
            wordmark; a section heading is navigation furniture inside a data view, and putting a
            serif on it starts the slide toward "a serif site". */}
        <h2 className="text-[19px] font-semibold tracking-tight text-text">Friction</h2>
        <p className="mt-2 max-w-2xl text-text-muted">
          A pass-rate alone cannot tell good difficulty from bad — a puzzle players lose
          five times and then beat is a <em>good</em> puzzle. What separates them is what
          the player does next.
        </p>

        {friction.source === 'unavailable' ? (
          <div className="mt-6 rounded-[10px] border border-border bg-surface-raised px-4 py-3 text-[13px] leading-relaxed text-text-muted">
            The friction endpoint is unreachable and no saved snapshot covers it yet, so
            there is nothing to show here right now.
            <span className="mt-1 block text-xs opacity-70">{friction.error}</span>
          </div>
        ) : (
          <>
            <StaleNotice source={friction.source} capturedAt={friction.capturedAt} />
            <Card
              title="What players do after failing"
              subtitle="Each failed attempt, classified by the next thing that player did"
            >
              <AfterFailureChart data={friction.stats.afterFailure} />
              <p className="mt-3 text-xs text-text-faint">
                Ordered worst-to-best by shade: retrying the same topic is healthy
                friction; a session ending on a failure is the strongest warning sign.
                “Left the area” is ambiguous on its own — it may mean walking off in
                frustration or walking away to fetch evidence.
              </p>
            </Card>

            <Card
              title="Attempts before a success"
              subtitle="Per topic, across sessions — and whether it was ever solved at all"
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm tabular-nums">
                  <thead className="text-[11px] uppercase tracking-[0.6px] text-text-faint">
                    <tr className="border-b border-border">
                      <th className="py-2 pr-4 font-medium">Suspect</th>
                      <th className="py-2 pr-4 font-medium">Topic</th>
                      <th className="py-2 pr-4 text-right font-medium">Sessions</th>
                      <th className="py-2 pr-4 text-right font-medium">Solved</th>
                      <th className="py-2 pr-4 text-right font-medium">Attempts</th>
                      <th className="py-2 text-right font-medium">Avg. tries to pass</th>
                    </tr>
                  </thead>
                  <tbody>
                    {friction.stats.attemptsToPass.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-4 text-text-faint">
                          No attempts recorded yet.
                        </td>
                      </tr>
                    ) : (
                      friction.stats.attemptsToPass.map((r) => (
                        <tr
                          key={`${r.suspect}:${r.topic}`}
                          className="border-b border-border/60"
                        >
                          {/*
                            THE DRILL-DOWN. This is the payoff of keeping filter state in the
                            URL: "show me the individual attempts behind this row" is a plain
                            link, not a feature. Nothing is wired up, no state is pushed
                            anywhere -- the explorer reads its filters from the URL, so
                            constructing the URL IS constructing the view.

                            Link (not <a>) so Next does a client-side navigation: it fetches
                            just the new page's data and swaps it in, instead of reloading the
                            document and re-running everything.
                          */}
                          <td className="py-2 pr-4">
                            <Link
                              href={`/events?mod_id=${MOD_ID}&type=ConfrontationAttempted&suspect=${encodeURIComponent(r.suspect)}&topic=${encodeURIComponent(r.topic)}`}
                              className="underline decoration-dotted underline-offset-4 hover:decoration-solid"
                              title={`See every attempt on ${titleCase(r.suspect)} / ${titleCase(r.topic)}`}
                            >
                              {titleCase(r.suspect)}
                            </Link>
                          </td>
                          <td className="py-2 pr-4">{titleCase(r.topic)}</td>
                          <td className="py-2 pr-4 text-right">{r.sessions}</td>
                          <td className="py-2 pr-4 text-right">
                            {r.solved_sessions === 0 ? (
                              <span className="font-semibold text-amber">
                                0 / {r.sessions}
                              </span>
                            ) : (
                              `${r.solved_sessions} / ${r.sessions}`
                            )}
                          </td>
                          <td className="py-2 pr-4 text-right">{r.total_attempts}</td>
                          <td className="py-2 text-right">
                            {/* NULL means nothing ever solved it — deliberately not 0, and
                                not rendered as a number, which would read as "solved on
                                the zeroth try". */}
                            {r.avg_attempts_to_pass === null ? (
                              <span className="text-text-faint">
                                never solved
                              </span>
                            ) : (
                              r.avg_attempts_to_pass.toFixed(1)
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-text-faint">
                A topic solved in 0 of its sessions, with attempts on the board, is the
                signal for content that may be effectively unpassable.
              </p>
            </Card>
          </>
        )}
      </section>

      <section className="mt-14">
        {/* Sans, NOT the display face. Design docs 13 §3 scopes Spectral to page H1s and the
            wordmark; a section heading is navigation furniture inside a data view, and putting a
            serif on it starts the slide toward "a serif site". */}
        <h2 className="text-[19px] font-semibold tracking-tight text-text">Skill checks</h2>
        <p className="mt-2 max-w-2xl text-text-muted">
          A pass-rate says <em>that</em> a check failed. The margin says <em>by how much</em> —
          and that difference decides whether the fix is lowering a threshold or accepting that
          the player brought a different build.
        </p>

        {skills.source === 'unavailable' ? (
          <div className="mt-6 rounded-[10px] border border-border bg-surface-raised px-4 py-3 text-[13px] leading-relaxed text-text-muted">
            The skills endpoint is unreachable and no saved snapshot covers it yet.
            <span className="mt-1 block text-xs opacity-70">{skills.error}</span>
          </div>
        ) : (
          <>
            <StaleNotice source={skills.source} capturedAt={skills.capturedAt} />
            <section className="mb-8 mt-6 grid gap-4 sm:grid-cols-3">
              {(['near_miss', 'moderate_gap', 'build_gap'] as const).map((key) => {
                const row = skills.stats.failureDistance.find((b) => b.band === key);
                const meta = BANDS[key];
                return (
                  <div key={key} className={`rounded-[10px] border p-4 ${meta.tone}`}>
                    {/* Count first and tinted (design docs 13, Mod Detail §3). The tint is the
                        ORDINAL encoding: blue → amber → red is increasing distance from passing,
                        which is also increasing "no threshold change will fix this". */}
                    <div className="text-[22px] font-semibold tabular-nums">{row?.count ?? 0}</div>
                    <div className="mt-0.5 text-[13px] font-semibold">{meta.label}</div>
                    <div className="mt-0.5 text-xs tabular-nums opacity-80">
                      {row ? `avg ${row.avg_margin} from passing` : 'none recorded'}
                    </div>
                    <p className="mt-2 text-xs leading-snug opacity-80">{meta.implication}</p>
                  </div>
                );
              })}
            </section>

            <p className="mb-8 text-xs text-text-faint">
              Counted once per player per check, not per attempt — a cheap retryable action
              would otherwise outvote every costly one. A check that was eventually passed in a
              session is not counted as a failure there.
            </p>

            <Card
              title="How far short players fell"
              subtitle="Closest failed attempt per check — distance from the passing threshold"
            >
              <MarginChart data={skills.stats.byCheck} />
            </Card>

            <Card
              title="What the mod gates on"
              subtitle="Every skill and attribute tested, and how often players clear it"
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm tabular-nums">
                  <thead className="text-[11px] uppercase tracking-[0.6px] text-text-faint">
                    <tr className="border-b border-border">
                      <th className="py-2 pr-4 font-medium">Stat</th>
                      <th className="py-2 pr-4 font-medium">Type</th>
                      <th className="py-2 pr-4 font-medium">Trigger</th>
                      <th className="py-2 pr-4 text-right font-medium">Checks</th>
                      <th className="py-2 pr-4 text-right font-medium">Distinct</th>
                      <th className="py-2 text-right font-medium">Pass-rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skills.stats.byStat.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-4 text-text-faint">
                          No skill checks recorded yet.
                        </td>
                      </tr>
                    ) : (
                      skills.stats.byStat.map((s) => (
                        <tr
                          // ⚠️ (skill, stat_type, trigger) — `stat_type` IS PART OF THE GRAIN.
                          //
                          // Keyed on (skill, trigger) this produced SIX pairs of duplicate React
                          // keys against live data: `personality` is recorded as both an
                          // `attribute` and a `skill`, and so are agility, security, acrobatics,
                          // strength and alchemy. Measured on the payload, not reasoned about —
                          // 18 rows, 12 of them colliding.
                          //
                          // The rows are visibly different on screen (the Type column right there
                          // renders `stat_type`), which is what makes this the same defect as the
                          // gate-grain bug in `12 §6`: a key that drops a dimension the payload
                          // varies on, so React is free to reuse the wrong row's element.
                          key={`${s.skill}:${s.stat_type}:${s.trigger}`}
                          className="border-b border-border/60"
                        >
                          <td className="py-2 pr-4">{titleCase(s.skill)}</td>
                          <td className="py-2 pr-4 text-text-faint">
                            {titleCase(s.stat_type)}
                          </td>
                          <td className="py-2 pr-4">
                            {/* Passive checks are shown but marked: the player never opted
                                into them, so their failures are not friction. */}
                            <span
                              className={
                                s.trigger === 'environment'
                                  ? 'rounded border border-border px-1.5 py-0.5 text-xs text-text-muted'
                                  : 'text-xs text-text-faint'
                              }
                            >
                              {s.trigger === 'environment' ? 'passive' : 'player'}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-right">{s.checks}</td>
                          <td className="py-2 pr-4 text-right">{s.distinct_checks}</td>
                          <td className="py-2 text-right">{pct(s.pass_rate)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {skills.stats.byRoute.length > 0 && (
                <p className="mt-3 text-xs text-text-faint">
                  Archetype routes taken:{' '}
                  {skills.stats.byRoute
                    .map((r) => `${titleCase(r.route)} (${r.passes})`)
                    .join(' · ')}
                </p>
              )}
            </Card>
          </>
        )}
      </section>
    </>
  );
}

// Per-section staleness label. The top-of-page notice only covers the confrontation data;
// friction and skills fetch independently and can fall back independently, so each section
// must state its own provenance. Doc 07 §5: a visitor is never allowed to mistake a
// snapshot for a live reading — that applies per section, not per page.
function StaleNotice({
  source,
  capturedAt,
}: {
  source: 'live' | 'snapshot' | 'unavailable';
  capturedAt: string | null;
}) {
  if (source !== 'snapshot') return null;
  return (
    <div className="mt-6 rounded-lg border border-amber-border bg-amber-bg px-4 py-2.5 text-[13px] text-amber">
      <strong className="font-semibold">Saved snapshot.</strong> The live API did not serve this
      section, so these figures are from {whenCaptured(capturedAt)} rather than right now.
    </div>
  );
}

function StatTile({
  label,
  value,
  note,
  lowConfidence = false,
}: {
  label: string;
  value: string;
  note?: string;
  lowConfidence?: boolean;
}) {
  return (
    <div className="rounded-[10px] border border-border bg-surface p-4">
      <div className="text-xs text-text-faint">{label}</div>
      {/* De-emphasised, not hidden: a low-n rate is still real information, it just
          must not wear the same visual authority as a well-supported one. */}
      <div
        className={
          lowConfidence
            ? 'mt-1 text-[22px] font-normal tabular-nums text-text-muted'
            : 'mt-1 text-[22px] font-semibold tabular-nums text-text'
        }
      >
        {value}
      </div>
      {note && <div className="mt-0.5 text-xs tabular-nums text-text-faint">{note}</div>}
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-[10px] border border-border bg-surface p-5">
      <h2 className="text-[15px] font-semibold text-text">{title}</h2>
      {subtitle && <p className="mb-4 mt-0.5 text-[13px] text-text-faint">{subtitle}</p>}
      {!subtitle && <div className="mb-2" />}
      {children}
    </section>
  );
}
