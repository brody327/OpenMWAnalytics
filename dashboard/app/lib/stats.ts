// Data layer for the dashboard. Runs on the server (imported by a Server
// Component), so the Express API base never reaches the browser and there is no
// CORS. The Express API owns the aggregation SQL (design docs 07); this is a thin
// typed client over its /stats/* endpoints.

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

const API_BASE = process.env.OMWA_API_BASE ?? 'http://localhost:4000';

// no-store: the dashboard always reflects current data. (Next 16 already leaves
// fetch uncached by default; we state the intent explicitly.)
export async function getConfrontationStats(): Promise<ConfrontationStats> {
  const res = await fetch(`${API_BASE}/stats/confrontations`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`stats API responded ${res.status}`);
  return res.json();
}
