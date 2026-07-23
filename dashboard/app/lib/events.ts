// Typed client for the raw event feed (Express GET /events, GET /mods).
//
// Server-side only, like lib/stats.ts -- the API base stays out of the browser bundle and
// there is no CORS. The browser reaches this data through the /api/events Route Handler
// instead (see app/api/events/route.ts), which proxies to the same Express endpoint.
//
// Unlike /stats/*, there is NO snapshot fallback here. A stats page with stale numbers is
// still useful; an event EXPLORER showing yesterday's rows while claiming to be a live feed
// would be actively misleading, and its whole purpose is answering "did my event just fire?".
// So when upstream is down this surfaces the error and shows nothing.

const API_BASE = process.env.OMWA_API_BASE ?? 'http://localhost:4000';

export type EventRow = {
  session_id: string;
  seq: number;
  install_id: string;
  type: string;
  v: number;
  mod_id: string;
  env: string;
  /** epoch ms (event time) */
  ts: string;
  /** epoch ms (processing time) */
  received_at: string;
  data: Record<string, unknown>;
};

export type EventPage = {
  events: EventRow[];
  /** null means end of feed -- an explicit terminator, never inferred from a short page. */
  nextCursor: string | null;
  limit: number;
};

export type ModRow = {
  mod_id: string;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  events: number;
  sessions: number;
};

/** The filters that live in the URL. Every value is a string because that is what a URL holds. */
export type EventFilters = {
  mod_id?: string;
  type?: string;
  env?: string;
  session_id?: string;
  suspect?: string;
  topic?: string;
  cursor?: string;
};

/** Build the upstream query string, dropping empty values so absent filters send nothing. */
export function toQuery(filters: EventFilters, limit?: number): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (typeof v === 'string' && v.trim() !== '') q.set(k, v.trim());
  }
  if (limit) q.set('limit', String(limit));
  return q.toString();
}

export async function getEvents(
  filters: EventFilters,
  limit = 50,
): Promise<{ page: EventPage | null; error: string | null }> {
  try {
    const res = await fetch(`${API_BASE}/events?${toQuery(filters, limit)}`, {
      // Never cache: the point of this view is that it reflects the database right now.
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { page: null, error: `upstream returned ${res.status}` };
    return { page: (await res.json()) as EventPage, error: null };
  } catch (e) {
    return { page: null, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

export async function getMods(): Promise<{ mods: ModRow[]; error: string | null }> {
  try {
    const res = await fetch(`${API_BASE}/mods`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { mods: [], error: `upstream returned ${res.status}` };
    const json = (await res.json()) as { mods: ModRow[] };
    return { mods: json.mods, error: null };
  } catch (e) {
    return { mods: [], error: e instanceof Error ? e.message : 'unknown error' };
  }
}
