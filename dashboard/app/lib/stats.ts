// Data layer for the dashboard. Runs on the server (imported by a Server
// Component), so the Express API base never reaches the browser and there is no
// CORS. The Express API owns the aggregation SQL (design docs 07); this is a thin
// typed client over its /stats/* endpoints.
//
// The API lives on a single EC2 box that gets stopped between sessions to control
// cost, so "upstream is down" is a NORMAL state here, not an exception. Rather than
// showing a visitor an error page, we fall back to a committed last-known-good
// snapshot and label it plainly. See `npm run snapshot` for how it is refreshed —
// it is captured FROM the live API, never hand-written, so the fallback is real
// data rather than invented numbers.

import snapshotJson from './snapshot.json';

export type TopicStat = {
  suspect: string;
  topic: string;
  attempts: number;
  passes: number;
  pass_rate: number; // 0..1
};

export type ReasonStat = {
  reason: string;
  count: number;
};

export type ConfrontationStats = {
  byTopic: TopicStat[];
  byReason: ReasonStat[];
};

export type StatsResult = {
  stats: ConfrontationStats;
  /** 'live' = fetched just now; 'snapshot' = upstream unreachable, serving the fallback. */
  source: 'live' | 'snapshot';
  /** ISO timestamp the snapshot was captured, when serving one. */
  capturedAt: string | null;
  /** Why the live fetch failed, when it did. Surfaced in the UI for honesty. */
  error: string | null;
};

const snapshot = snapshotJson as {
  capturedAt: string | null;
  byTopic: TopicStat[];
  byReason: ReasonStat[];
};

const API_BASE = process.env.OMWA_API_BASE ?? 'http://localhost:4000';

// A stopped EC2 box does not refuse connections — the packets are simply dropped, so
// an unbounded fetch hangs until the platform's own timeout. Bounding it keeps the
// page fast when upstream is gone: we would rather render the snapshot in 4s than
// block a visitor for 30.
const TIMEOUT_MS = 4000;

// no-store: the dashboard always reflects current data. (Next 16 already leaves
// fetch uncached by default; we state the intent explicitly.)
export async function getConfrontationStats(): Promise<StatsResult> {
  try {
    const res = await fetch(`${API_BASE}/stats/confrontations`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`stats API responded ${res.status}`);
    const stats = (await res.json()) as ConfrontationStats;
    return { stats, source: 'live', capturedAt: null, error: null };
  } catch (e) {
    return {
      stats: { byTopic: snapshot.byTopic, byReason: snapshot.byReason },
      source: 'snapshot',
      capturedAt: snapshot.capturedAt,
      error: (e as Error).message,
    };
  }
}
