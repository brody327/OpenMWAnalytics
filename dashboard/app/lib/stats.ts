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

/** One bucket of "what the player did next" after a failed attempt (design docs 07 §4). */
export type AfterFailureStat = {
  suspect: string;
  topic: string;
  /** retried_same | switched_topic | left_area | session_end | other */
  next_action: string;
  count: number;
  /** null when the fail was the last event in its session (nothing to measure to). */
  avg_gap_seconds: number | null;
};

export type AttemptsToPassStat = {
  suspect: string;
  topic: string;
  sessions: number;
  solved_sessions: number;
  total_attempts: number;
  /** null when NO session ever solved it — deliberately not 0. */
  avg_attempts_to_pass: number | null;
  max_attempts_in_a_session: number;
};

export type FrictionStats = {
  afterFailure: AfterFailureStat[];
  attemptsToPass: AttemptsToPassStat[];
};

export type FrictionResult = {
  stats: FrictionStats;
  source: 'live' | 'snapshot' | 'unavailable';
  capturedAt: string | null;
  error: string | null;
};

/** One skill/attribute check, aggregated. Fail-margin fields are null when it never failed. */
export type CheckStat = {
  check_id: string;
  skill: string;
  stat_type: string;
  attempts: number;
  passes: number;
  pass_rate: number;
  /** Passes the player experienced that the numbers did NOT earn (weird_success_chance). */
  fluke_passes: number;
  avg_fail_margin: number | null;
  closest_fail_margin: number | null;
  worst_fail_margin: number | null;
};

/** Unsolved (session, check) pairs bucketed by how far short the player got. */
export type FailureBand = {
  band: 'near_miss' | 'moderate_gap' | 'build_gap' | string;
  count: number;
  avg_margin: number;
};

export type StatCoverage = {
  skill: string;
  stat_type: string;
  /** 'inspect' (player-initiated) | 'environment' (passive) */
  trigger: string;
  checks: number;
  distinct_checks: number;
  pass_rate: number;
};

export type SkillStats = {
  byCheck: CheckStat[];
  failureDistance: FailureBand[];
  byStat: StatCoverage[];
  byRoute: { route: string; passes: number }[];
};

export type SkillResult = {
  stats: SkillStats;
  source: 'live' | 'snapshot' | 'unavailable';
  capturedAt: string | null;
  error: string | null;
};

/** One scored + ranked topic (design docs 07 / api stats/ranking.ts). Every ingredient of the
 *  score rides along so the UI can EXPLAIN the ordering rather than show a bare number. */
export type RankedTopic = {
  suspect: string;
  topic: string;
  /** = n. The sample size, carried out front for the §3.3 honesty rule. */
  attempts: number;
  fails: number;
  /** fails / attempts — shown only for contrast with the shrunk value. */
  raw_fail_rate: number;
  /** the shrinkage-tamed rate the ranking actually trusts. */
  shrunk_fail_rate: number;
  /** log(attempts) — the exposure weight. */
  volume_weight: number;
  /** shrunk_fail_rate × volume_weight — the sort key. */
  stuck_score: number;
};

export type RankingStats = {
  /** measured global fail rate C, the target shrinkage pulls thin rates toward. */
  globalFailRate: number;
  /** the prior strength m (the one knob), echoed so the ranking stays self-explaining. */
  priorStrength: number;
  ranked: RankedTopic[];
};

export type RankingResult = {
  stats: RankingStats;
  source: 'live' | 'snapshot' | 'unavailable';
  capturedAt: string | null;
  error: string | null;
};

const snapshot = snapshotJson as {
  capturedAt: string | null;
  byTopic: TopicStat[];
  byReason: ReasonStat[];
  friction?: FrictionStats;
  skills?: SkillStats;
  ranking?: RankingStats;
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

// The sequence view (design docs 07 §4 / 10 Q1.3-1.4-1.6). Same degradation contract
// as above, with one difference: `friction` was added to the snapshot later, so an
// older committed snapshot legitimately has no friction key. That case reports
// 'unavailable' rather than pretending empty arrays are a real reading — an empty
// chart and a missing fallback must not look identical.
export async function getFrictionStats(): Promise<FrictionResult> {
  try {
    const res = await fetch(`${API_BASE}/stats/friction`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`friction API responded ${res.status}`);
    const stats = (await res.json()) as FrictionStats;
    return { stats, source: 'live', capturedAt: null, error: null };
  } catch (e) {
    const fallback = snapshot.friction;
    return {
      stats: fallback ?? { afterFailure: [], attemptsToPass: [] },
      source: fallback ? 'snapshot' : 'unavailable',
      capturedAt: fallback ? snapshot.capturedAt : null,
      error: (e as Error).message,
    };
  }
}

// Skill-check margins (design docs 03 / 07 §5b / 10 Q1.2, Q3.1, Q3.3). Same degradation
// contract as getFrictionStats: a snapshot predating this endpoint reports 'unavailable'
// rather than passing empty arrays off as a real reading.
export async function getSkillStats(): Promise<SkillResult> {
  try {
    const res = await fetch(`${API_BASE}/stats/skills`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`skills API responded ${res.status}`);
    const stats = (await res.json()) as SkillStats;
    return { stats, source: 'live', capturedAt: null, error: null };
  } catch (e) {
    const fallback = snapshot.skills;
    return {
      stats: fallback ?? { byCheck: [], failureDistance: [], byStat: [], byRoute: [] },
      source: fallback ? 'snapshot' : 'unavailable',
      capturedAt: fallback ? snapshot.capturedAt : null,
      error: (e as Error).message,
    };
  }
}

// The "where are players most stuck — look here first" ranking (design docs 07 / 10 Q1.1).
// Same degradation contract as getSkillStats: a snapshot predating this endpoint reports
// 'unavailable' rather than passing an empty ranking off as a real reading. The empty-fallback
// keeps priorStrength: 0 so a snapshot-less render never implies a knob value it did not use.
export async function getRankingStats(): Promise<RankingResult> {
  try {
    const res = await fetch(`${API_BASE}/stats/ranking`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ranking API responded ${res.status}`);
    const stats = (await res.json()) as RankingStats;
    return { stats, source: 'live', capturedAt: null, error: null };
  } catch (e) {
    const fallback = snapshot.ranking;
    return {
      stats: fallback ?? { globalFailRate: 0, priorStrength: 0, ranked: [] },
      source: fallback ? 'snapshot' : 'unavailable',
      capturedAt: fallback ? snapshot.capturedAt : null,
      error: (e as Error).message,
    };
  }
}
