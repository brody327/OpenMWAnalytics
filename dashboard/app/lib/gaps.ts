// Typed client for the content-gap view: Express `GET /stats/sufficiency` + `GET /insights`.
//
// Server-side only, like lib/stats.ts and lib/search.ts -- the API base stays out of the browser
// bundle and there is no CORS.
//
// NO SNAPSHOT FALLBACK, and the reason is stronger here than it was for search. A stale gap
// analysis is not slightly-old data: it is a claim about what the game CONTAINS, made against a
// corpus that may since have been re-ingested. "No remedy exists for this gate" is exactly the
// kind of finding a mod author would act on by writing content, and being wrong about it costs
// them a weekend. When upstream is down we say so and show nothing.

const API_BASE = process.env.OMWA_API_BASE ?? 'http://localhost:4000';

export type Verdict = 'no_remedy' | 'gamble_only' | 'remedy_exists';
export type Reachability = 'PLACED' | 'NOT_PLACED' | 'UNKNOWN';

export type Gate = {
  check_id: string;
  stat: string;
  stat_kind: string;
  threshold: number;
  fails: number;
  gap_p50: number;
  gap_p90: number;
  reliable: number;
  possible: number;
  unknown_magnitude: number;
  placed_remedies: number;
  placed_areas: number;
  surveyable_possible: number;
  verdict: Verdict;
  /** ⚠️ Never omitted, never defaulted. `UNKNOWN` is a value that must RENDER. */
  reachable: Reachability;
};

export type SufficiencyResult = {
  reachability_note: string;
  surveyed: boolean;
  /** Gates that EXIST. `gates.length < total_gates` means the page is truncated. */
  total_gates: number;
  gates: Gate[];
};

/**
 * ⭐ A gate's identity is all four of these, NOT `check_id`.
 *
 * Measured 2026-08-09: `ccff_j_mortar:force` is sixteen gates — security@25, security@60,
 * shortblade@25, luck@25, personality@25 … — and their verdicts disagree (`no_remedy` next to
 * `remedy_exists`). Keying anything on `check_id` alone silently attaches a finding about one stat
 * to a row about another, which renders as a confident, actionable, wrong recommendation.
 */
export function gateKey(g: {
  check_id: string;
  stat: string;
  stat_kind: string;
  threshold: number;
}): string {
  return `${g.check_id}|${g.stat}|${g.stat_kind}|${g.threshold}`;
}

export type Insight = {
  id: string;
  check_id: string;
  stat: string;
  stat_kind: string;
  threshold: number;
  headline: string;
  signposting: 'SIGNPOSTED' | 'NOT_SIGNPOSTED' | 'UNCLEAR';
  rationale: string;
  recommendation: string;
  citations: string[];
  /** The model that actually produced it -- a server-side fallback records the model that ran. */
  model: string;
  created_at: string;
};

export type InsightsResult = {
  note: string;
  insights: Insight[];
};

export async function getSufficiency(
  limit = 25,
): Promise<{ result: SufficiencyResult | null; error: string | null }> {
  try {
    const res = await fetch(`${API_BASE}/stats/sufficiency?limit=${limit}`, {
      cache: 'no-store',
      // The gate query percentiles over the whole event log and joins to the corpus, so it is
      // slower than the rollup-backed reads -- but it does not leave the database, unlike search.
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { result: null, error: `upstream returned ${res.status}` };
    return { result: (await res.json()) as SufficiencyResult, error: null };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

/**
 * Approved insights.
 *
 * The endpoint serves `status = 'approved'` only, enforced in SQL -- there is no parameter this
 * client could pass to widen it, which is the point. An empty list means nothing has been
 * reviewed and approved yet, and the UI must say that rather than implying nothing was generated.
 */
export async function getInsights(): Promise<{
  result: InsightsResult | null;
  error: string | null;
}> {
  try {
    const res = await fetch(`${API_BASE}/insights`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { result: null, error: `upstream returned ${res.status}` };
    return { result: (await res.json()) as InsightsResult, error: null };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : 'unknown error' };
  }
}
