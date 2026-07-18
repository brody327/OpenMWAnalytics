// Dashboard home — a Server Component. It fetches aggregates from the Express API
// (server-side; no CORS, no data-access logic here) and hands plain data to the
// client chart components. First view: "where do players get stuck in
// confrontations?" (design docs 07).

import { getConfrontationStats, type ConfrontationStats } from './lib/stats';
import { PassRateChart, FailureReasonChart } from './components/ConfrontationCharts';

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const pct = (v: number) => `${Math.round(v * 100)}%`;

export default async function Home() {
  let stats: ConfrontationStats | null = null;
  let error: string | null = null;
  try {
    stats = await getConfrontationStats();
  } catch (e) {
    error = (e as Error).message;
  }

  const byTopic = stats?.byTopic ?? [];
  const totalAttempts = byTopic.reduce((n, t) => n + t.attempts, 0);
  const totalPasses = byTopic.reduce((n, t) => n + t.passes, 0);
  const overallRate = totalAttempts ? totalPasses / totalAttempts : 0;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <header className="mb-8">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          OpenMW Analytics
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Confrontations</h1>
        <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
          Where players get stuck: pass-rate and attempt volume per suspect &amp; topic, and
          the failure reasons behind the misses.
        </p>
      </header>

      {error ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Couldn&apos;t reach the analytics API ({error}). Is it running on{' '}
          <code>:4000</code>?
        </div>
      ) : (
        <>
          <section className="mb-10 grid grid-cols-3 gap-4">
            <StatTile label="Attempts" value={totalAttempts.toLocaleString()} />
            <StatTile label="Overall pass-rate" value={pct(overallRate)} />
            <StatTile label="Topics contested" value={byTopic.length.toLocaleString()} />
          </section>

          <Card title="Pass-rate by topic" subtitle="Share of committed attempts that landed">
            <PassRateChart data={byTopic} />
          </Card>

          <Card title="Why players miss" subtitle="Failure reasons across all failed attempts">
            <FailureReasonChart data={stats?.byReason ?? []} />
          </Card>

          <Card title="Table view">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm tabular-nums">
                <thead className="text-zinc-500 dark:text-zinc-400">
                  <tr className="border-b border-black/10 dark:border-white/10">
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
                      <td colSpan={5} className="py-4 text-zinc-500 dark:text-zinc-400">
                        No confrontation data yet.
                      </td>
                    </tr>
                  ) : (
                    byTopic.map((t) => (
                      <tr key={`${t.suspect}:${t.topic}`} className="border-b border-black/5 dark:border-white/5">
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
        </>
      )}
    </main>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-900/40">
      <div className="text-sm text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 rounded-xl border border-black/10 bg-white p-5 dark:border-white/10 dark:bg-zinc-900/40">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle && <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      {!subtitle && <div className="mb-2" />}
      {children}
    </section>
  );
}
