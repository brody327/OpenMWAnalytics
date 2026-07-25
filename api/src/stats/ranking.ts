import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// GET /stats/ranking
//
// The "where are players most stuck -- look here first" view (design docs 10, Module 1).
//
// Everything else in /stats is a faithful REPORT of the data: confrontations.ts shows the
// pass rate, friction.ts shows what happens after a fail. This endpoint makes a JUDGEMENT --
// it RANKS topics by how much they deserve a mod author's attention. That judgement is an
// explicit, hand-built scoring function (a HEURISTIC), deliberately NOT a learned model:
// we have no labels ("this topic is stuck") and a population of one (10 §3.3), so there is
// nothing honest for a model to learn. Every term below is inspectable and defensible -- which
// is the whole point of leading Phase 4 with ranking instead of an LLM.
//
// THE SCORE
//
//   stuck_score = shrunk_fail_rate * log(attempts)
//
// Two terms doing two different jobs:
//
//   shrunk_fail_rate -- decides WHETHER TO TRUST the fail rate. A raw rate over a tiny sample
//     is noise wearing a confident hat: 1 attempt / 1 fail is "100% failure" and would top any
//     naive ORDER BY fail_rate. Shrinkage pulls each rate toward the GLOBAL fail rate C by an
//     amount that fades as the sample grows -- so an extreme rate has to be EARNED with volume.
//
//   log(attempts)    -- decides HOW MUCH THE TRUSTED RATE MATTERS. "Look here first" is a triage
//     question; an author fixes what hurts the most players first. log (not raw attempts) so
//     sheer popularity does not bury a savage-but-moderately-played topic: 10->100 attempts
//     should matter a lot, 10k->100k much less. Note log(1) = 0, so a single-attempt topic
//     scores EXACTLY zero -- structurally incapable of reaching the top. Both defenses fire on
//     noise at once: its rate is shrunk toward average AND its volume weight is ~zero.
//
// See stats/ranking.test.ts for the by-hand fixture that pins this behaviour.

/** One topic's raw counts -- the only thing the scorer needs from the database. */
export interface TopicCounts {
  suspect: string;
  topic: string;
  attempts: number;
  passes: number;
}

/** A scored + ranked topic. All the score's ingredients ride along so the UI can EXPLAIN the
 *  ordering (10 §2: every view ends in "...so do X"), never present a bare number. */
export interface RankedTopic {
  suspect: string;
  topic: string;
  /** = n. Carried out front because 10 §3.3 requires sample size next to every rate. */
  attempts: number;
  fails: number;
  /** fails / attempts -- shown ONLY for contrast with the shrunk value, never sorted on. */
  raw_fail_rate: number;
  /** (fails + m*C) / (attempts + m) -- the trusted rate. */
  shrunk_fail_rate: number;
  /** log(attempts) -- the exposure weight. */
  volume_weight: number;
  /** shrunk_fail_rate * volume_weight -- the sort key. */
  stuck_score: number;
}

export interface RankingResult {
  /** The measured global fail rate C -- the target every shrunk rate is pulled toward. NOT a
   *  knob: it is read from the data, so the prior is "however hard content actually is". */
  globalFailRate: number;
  /** The prior strength m -- the ONE knob. Emitted so the ranking stays self-explaining. */
  priorStrength: number;
  ranked: RankedTopic[];
}

// The prior strength m, in units of ATTEMPTS: "how many attempts of average-content evidence
// every topic is padded with before its own rate is trusted." m is the crossover point -- at
// attempts = m the topic's data and the global prior weigh equally. Small m trusts thin data
// fast; large m demands lots of evidence before an extreme rate is believed. At our real
// volumes (dozens of attempts) m = 10 keeps single-digit-attempt topics near the mean, which
// is the honest behaviour under 10 §3.3. Env-tunable like friction's LIVE_WINDOW so it can be
// retuned against real player volume without a redeploy.
const PRIOR_STRENGTH = Number(process.env.OMWA_RANK_PRIOR_M ?? 10);

const round = (n: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * Pure ranking heuristic -- no database, no I/O, unit-tested on a hand-computable fixture.
 * Splitting this out from the handler is the deliberate design choice (agreed 2026-07-24):
 * the scoring RULE is the portfolio-legible part, and a pure function is the thing worth
 * showing an interviewer and testing without a DB.
 *
 * @param rows per-topic counts (from the index-only byTopic scan)
 * @param m    prior strength; defaults to PRIOR_STRENGTH
 */
export function rankTopics(rows: TopicCounts[], m: number = PRIOR_STRENGTH): RankingResult {
  // C = global fail rate, computed from the SAME rows we are about to score. No separate query:
  // summing the rows we already fetched IS the global aggregate. Guard the empty case so C is a
  // real number (0) rather than 0/0 = NaN, which would poison every shrunk rate.
  const totalAttempts = rows.reduce((s, r) => s + r.attempts, 0);
  const totalFails = rows.reduce((s, r) => s + (r.attempts - r.passes), 0);
  const globalFailRate = totalAttempts === 0 ? 0 : totalFails / totalAttempts;

  const ranked: RankedTopic[] = rows.map((r) => {
    const fails = r.attempts - r.passes;
    const rawFailRate = r.attempts === 0 ? 0 : fails / r.attempts;
    // The shrinkage blend. Reads as: pad the real counts with m phantom attempts whose outcome
    // matches the global rate (m*C of them fail), then take the fail rate over the padded pile.
    const shrunkFailRate = (fails + m * globalFailRate) / (r.attempts + m);
    // log(attempts): the exposure weight. attempts >= 1 for any row that exists, so this is >= 0
    // and = 0 exactly at attempts = 1 (the hard floor that annihilates single-attempt noise).
    const volumeWeight = r.attempts <= 0 ? 0 : Math.log(r.attempts);
    const stuckScore = shrunkFailRate * volumeWeight;

    return {
      suspect: r.suspect,
      topic: r.topic,
      attempts: r.attempts,
      fails,
      raw_fail_rate: round(rawFailRate),
      shrunk_fail_rate: round(shrunkFailRate),
      volume_weight: round(volumeWeight),
      stuck_score: round(stuckScore),
    };
  });

  // Sort on the (rounded, but monotonic) score. Ties broken by attempts then name so the order
  // is deterministic -- a wobbling rank between identical requests reads as a bug to a user.
  ranked.sort(
    (a, b) =>
      b.stuck_score - a.stuck_score ||
      b.attempts - a.attempts ||
      a.suspect.localeCompare(b.suspect) ||
      a.topic.localeCompare(b.topic),
  );

  return { globalFailRate: round(globalFailRate), priorStrength: m, ranked };
}

export async function ranking(_req: Request, res: Response): Promise<void> {
  // Reuse the exact index-only scan confrontations.ts tuned (events_confrontation_cols_idx over
  // the stored suspect/topic/passed generated columns -- fully index-only GroupAggregate, no heap
  // visit, see 06). The scoring heuristic never touches the database; it runs over these rows.
  const byTopic = await db.execute(sql`
    select
      suspect,
      topic,
      count(*)::int                         as attempts,
      (count(*) filter (where passed))::int as passes
    from events
    where type = 'ConfrontationAttempted'
    group by suspect, topic
  `);

  res.json(rankTopics(byTopic.rows as unknown as TopicCounts[]));
}
