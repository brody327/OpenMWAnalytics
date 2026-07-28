import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// GET /stats/sufficiency
//
// 10 Q3.6 -- "does the game contain an accessible remedy for this gate at all?"
//
// This is the ONLY question in the inventory that leaves the telemetry database: it joins what
// players DID (`SkillCheckResolved`) to what the game CONTAINS (`record_effects`, see 11). Every
// other view can only say *players are failing here*; this one can say **why the failure may not
// be the player's fault** -- a gate with no remedy in the content is an authoring gap, not a
// tuning one.
//
// ⭐ PURE SQL, NO MODEL, ON PURPOSE. Per the 4c plan this measurement must exist BEFORE anything
// generative, because it *is* the "why not just a heuristic" answer. A model adds nothing here:
// the question is "what is the number", not "is this meaningful".
//
// ────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS ENDPOINT MAY NOT SAY -- the hard boundary (10 §Module 3, 11 §13)
//
// It reports MECHANICAL sufficiency: does an item exist whose magnitude covers the observed gap.
// It CANNOT report REACHABILITY -- whether a player can actually obtain that item. The corpus has
// **no placement, no value, no vendor and no leveled-list data**; `game_records` stores
// name/type/text and `record_effects` stores effects, and that is all.
//
// So `reachable` is emitted as the literal 'UNKNOWN' on every row, and is NOT omitted. Absence
// has to be VISIBLE, because this is the single place a downstream LLM would fabricate most
// convincingly ("sold by most apothecaries") -- fluent, plausible, probably even true of the real
// game, unverifiable from our data, and INDISTINGUISHABLE from a computed fact. Every other
// failure this project has hit had a tell; that one has none. A missing number is not an
// invitation to supply one.
// ────────────────────────────────────────────────────────────────────────────────────────────
//
// THREE TIERS, because collapsing them forces a lie in one direction:
//
//   reliable  (magnitude_min >= gap) -- "works every time", even on the worst roll
//   possible  (magnitude_max >= gap) -- "works on a good roll". Morrowind rolls a random
//               magnitude in [min,max] per use, so a chance IS the game's own idiom; reporting
//               only guarantees would describe a game this isn't.
//   unknown   (magnitude IS NULL)    -- INGR effects print no magnitude in the esmtool dump, so
//               these affect the stat at a magnitude we do not have. Carried, never counted and
//               never dropped: dropping deletes evidence, counting asserts a magnitude we lack.
//
// The DIFFERENCE between the first two is itself the finding, which is why neither alone will do:
// `0 reliable / 1 possible` means the gate is closable only by re-rolling a wild-magnitude spell.
// `reliable` alone would report "no remedy" (wrong) and `possible` alone "a remedy" (also wrong).
//
// WHY p90 AND NOT max: the gap is a distribution across players, and `max` is by construction an
// n = 1 estimate -- one under-levelled character who wandered into a late-game check defines it
// forever, with nothing pulling it back. Same disease `ranking.ts` treats with shrinkage; the
// cure for a distribution is a robust statistic. p90 because Q3.6's word is *accessible*, and an
// accessibility claim that holds only for the median failing player is not one. p50 rides along.
//
// WHY ONLY `Fortify`: Restore refills DAMAGED points and cannot lift a stat above its base, so it
// can only close a gap for a player whose stat is damaged -- and `stat_damage` is emitted by
// nothing (0 of 329,964 rows). Counting Restore would credit remedies to players we cannot show
// are damaged. Revisit when the 03 additive fields actually ship.
//
// ⚠️ KNOWN LIMITATIONS, all of which bias the RESULT and none of which are hidden:
//  - `base_value` is designed (03, 2026-07-27) but emitted by NOTHING. `skill_value` is the
//    MODIFIED value, so a player who already drank a potion shows a smaller gap than their build
//    has ⇒ every gap here is biased LOW by an unknown amount, and remedies look more sufficient
//    than they are.
//  - No `env` filter, matching every other /stats endpoint. Seeded rows carry env='synthetic'
//    (see the synthetic-data policy) and currently dominate, so treat magnitudes as shape.

/** One gate's telemetry side -- what the database knows about players failing it. */
export interface GateGap {
  check_id: string;
  stat: string;
  stat_kind: string;
  threshold: number;
  fails: number;
  gap_p50: number;
  gap_p90: number;
  /** count of Fortify effects on this stat with magnitude_min >= gap_p90 */
  reliable: number;
  /** count with magnitude_max >= gap_p90 (a superset of `reliable`) */
  possible: number;
  /** count whose magnitude is absent from the dump entirely (INGR) */
  unknown_magnitude: number;
}

/** What an author should DO about this gate. 10 §2: every view ends in "...so do X". */
export type Verdict =
  /** nothing in the corpus covers the gap -- the fix is authoring or retuning, not signposting */
  | 'no_remedy'
  /** a remedy exists but never reliably clears the bar -- passable only by re-rolling */
  | 'gamble_only'
  /** at least one item closes the gap on every roll -- if players still fail, they can't FIND it */
  | 'remedy_exists';

export interface GateSufficiency extends GateGap {
  verdict: Verdict;
  /** ALWAYS 'UNKNOWN'. See the boundary note above -- never inferred, never omitted. */
  reachable: 'UNKNOWN';
}

export interface SufficiencyResult {
  /** Restated on the response so a consumer cannot lose it in transit. */
  reachability_note: string;
  gates: GateSufficiency[];
}

const REACHABILITY_NOTE =
  'Mechanical sufficiency only. The corpus has no placement, value or vendor data, so whether a ' +
  'player can OBTAIN any listed remedy is UNKNOWN and must not be inferred.';

/**
 * Pure classifier -- no database, no I/O, hand-computable. Split out for the same reason
 * `rankTopics` is: the JUDGEMENT is the part worth testing and showing, and it must be
 * exercisable without a Postgres.
 */
export function classifyGate(g: GateGap): GateSufficiency {
  // Order matters: `possible` is a superset of `reliable`, so test emptiness first.
  const verdict: Verdict =
    g.possible === 0 ? 'no_remedy' : g.reliable === 0 ? 'gamble_only' : 'remedy_exists';

  return { ...g, verdict, reachable: 'UNKNOWN' };
}

export function classifyGates(rows: GateGap[]): SufficiencyResult {
  return { reachability_note: REACHABILITY_NOTE, gates: rows.map(classifyGate) };
}

export async function sufficiency(_req: Request, res: Response): Promise<void> {
  const rows = await db.execute(sql`
    with failed as (
      select
        data->>'check_id'         as check_id,
        data->>'skill'            as stat,
        data->>'stat_type'        as stat_kind,
        (data->>'threshold')::int as threshold,
        (data->>'threshold')::int - (data->>'skill_value')::int as gap
      from events
      where type = 'SkillCheckResolved'
        -- 03: a failed PASSIVE check is not friction -- the player never knew it happened, so it
        -- carries no frustration signal and must not enter a difficulty metric.
        and data->>'trigger' = 'inspect'
        and not (data->>'passed')::bool
    ),
    gates as (
      select check_id, stat, stat_kind, threshold,
             count(*)::int                                      as fails,
             percentile_disc(0.5) within group (order by gap)   as gap_p50,
             percentile_disc(0.9) within group (order by gap)   as gap_p90
      from failed
      -- gap <= 0 means they met the bar on the deciding stat and still failed (multi-stat AND, or
      -- a pass override). Real, but a DIFFERENT problem -- including it would drag the gaps down.
      where gap > 0
      group by 1, 2, 3, 4
    ),
    remedies as (
      select e.affected, e.affected_kind, e.magnitude_min, e.magnitude_max
      from record_effects e
      join game_records r on r.record_id = e.record_id
      where e.effect_name ilike 'fortify%'
        and e.affected is not null
        -- ⚠️ A permanent (duration 0) SPEL is an innate ABILITY -- Gaenor's Abilities (+500 Luck),
        -- Her Hand (+100 Marksman), Divine Abilities (+100 Strength). They are attached to NPCs and
        -- factions and no player can ever hold one, so counting them invents remedies. They bite
        -- hardest exactly where the verdict matters most: their magnitudes are 70-500, so they only
        -- ever satisfy LARGE gaps -- the gates most likely to genuinely have no answer.
        --
        -- ⭐ SCOPED TO SPEL ON PURPOSE. The same duration = 0 on an ENCH is a CONSTANT-EFFECT
        -- enchantment, which is always-on *while worn* and is a perfectly real, obtainable remedy:
        -- Moon-and-Star (+5 Personality), Sheogorath's Seal (+10), Boots of Blinding Speed, and
        -- CCFF_lelene_ring_en -- a Personality ring authored by the very mod being measured. An
        -- unscoped duration filter would delete a mod author's own remedy on their own gate.
        --
        -- This is a PROXY and not the real discriminator. esmtool emits a SPEL Type field
        -- (Spell/Ability/Power/Blight/Disease/Curse) and parseEsmDump.ts DISCARDS it -- 0 of 1,067
        -- SPEL rows carry it -- so the corpus structurally cannot say "can a player cast this".
        -- Parsing it is the real fix, and would also correctly KEEP Powers (once-a-day but genuinely
        -- player-usable), which this filter retains only by accident of their having durations.
        and not (r.type = 'SPEL' and e.duration = 0)
    )
    select
      g.check_id, g.stat, g.stat_kind, g.threshold, g.fails,
      g.gap_p50::int as gap_p50, g.gap_p90::int as gap_p90,
      count(rm.affected) filter (where rm.magnitude_min >= g.gap_p90)::int as reliable,
      count(rm.affected) filter (where rm.magnitude_max >= g.gap_p90)::int as possible,
      count(rm.affected) filter (where rm.magnitude_min is null)::int      as unknown_magnitude
    from gates g
    -- affected_kind is load-bearing, not decoration: skill and attribute ids collide across the
    -- two enums, so joining on affected alone would credit a stat with another stat's remedies.
    left join remedies rm
      on rm.affected = g.stat
     and rm.affected_kind = g.stat_kind
    group by 1, 2, 3, 4, 5, 6, 7
    order by g.fails desc
  `);

  res.json(classifyGates(rows.rows as unknown as GateGap[]));
}
