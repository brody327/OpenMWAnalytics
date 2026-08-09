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
//  - `base_value` is absent from all 329,964 rows -- but NOT because nothing emits it. The chain is
//    BUILT and committed in CCFF (inspect_panel.lua:871 reads .base/.modifier/.damage on the
//    PLAYER, ships them as statDetail, evidence_inspect.lua:2309 writes them onto the event). The
//    rows are empty because the seeder omits the field and every real row PREDATES the code --
//    code deploys do not migrate data. ⭐ Unlike the corpus chunks these can never be back-filled:
//    a past check's base_value is not derivable from anything stored. The fix is a PLAY SESSION.
//    Until then `skill_value` is the MODIFIED value, so a player who already drank a potion shows a
//    smaller gap than their build has ⇒ every gap here is biased LOW, and remedies look more
//    sufficient than they are.
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
  /** Of the `possible` remedies, how many appear anywhere in the surveyed world (11 §13). */
  placed_remedies: number;
  /** Distinct areas in which any gap-closing remedy appears. */
  placed_areas: number;
  /**
   * How many gap-closing remedies are of a type the survey can even SEE (ALCH/INGR).
   *
   * ⚠️ Load-bearing. SPEL and ENCH remedies can NEVER have a placement: a spell is not an object
   * lying in a container, and an ENCH record is an enchantment *definition* whose carrying item is
   * a different record. Measured: 372 SPEL and 251 ENCH fortify effects, 0 placements between them,
   * by construction. Without this, every spell-only gate reports NOT_PLACED -- "we looked and did
   * not find it" when we could not have found it. Zero here means the honest answer is UNKNOWN.
   */
  surveyable_possible: number;
}

/** What an author should DO about this gate. 10 §2: every view ends in "...so do X". */
export type Verdict =
  /** nothing in the corpus covers the gap -- the fix is authoring or retuning, not signposting */
  | 'no_remedy'
  /** a remedy exists but never reliably clears the bar -- passable only by re-rolling */
  | 'gamble_only'
  /** at least one item closes the gap on every roll -- if players still fail, they can't FIND it */
  | 'remedy_exists';

/**
 * Whether any remedy that closes this gate is actually FINDABLE in the surveyed world (11 §13).
 *
 * ⚠️ READ `NOT_PLACED` CAREFULLY -- it does NOT mean "unobtainable". The survey covers loose items
 * and CONTAINERS; **merchant inventories are deliberately excluded** (leveled-list RNG that
 * restocks on a timer is not a stable surface a designer can reason about). A player may still be
 * able to BUY a remedy that appears nowhere in the world. Collapsing that into "unreachable" would
 * be the exact overclaim this endpoint was built to avoid.
 *
 * `UNKNOWN` is the honest answer when no survey has been ingested, and it is the DEFAULT: absence
 * of placement data must never read as absence of placement.
 */
export type Reachability =
  /** at least one gap-closing remedy appears in the surveyed world */
  | 'PLACED'
  /** no gap-closing remedy was found loose or in a container -- merchants NOT surveyed */
  | 'NOT_PLACED'
  /** no survey ingested; nothing can be said */
  | 'UNKNOWN';

export interface GateSufficiency extends GateGap {
  verdict: Verdict;
  reachable: Reachability;
  /** How many of the `possible` remedies have at least one placement. 0 when `UNKNOWN`. */
  placed_remedies: number;
  /** Distinct areas in which any gap-closing remedy appears. 0 when `UNKNOWN`. */
  placed_areas: number;
}

export interface SufficiencyResult {
  /** Restated on the response so a consumer cannot lose it in transit. */
  reachability_note: string;
  /** Whether a world survey has been ingested at all. False ⇒ every `reachable` is `UNKNOWN`. */
  surveyed: boolean;
  /**
   * How many gates EXIST, before `limit` was applied.
   *
   * ⚠️ Carried so truncation ANNOUNCES ITSELF. `gates.length < total_gates` is the signal that
   * there is more; without it a consumer reading 100 rows cannot distinguish "these are all the
   * gates" from "these are the worst 100 of 6,687" -- and the two support opposite conclusions
   * about how much of the mod has a content problem.
   */
  total_gates: number;
  gates: GateSufficiency[];
}

const REACHABILITY_NOTE =
  'Mechanical sufficiency only. No world survey has been ingested, so whether a player can OBTAIN ' +
  'any listed remedy is UNKNOWN and must not be inferred.';

// ⚠️ The caveat is carried ON THE RESPONSE, not just in this file. NOT_PLACED is the value most
// likely to be read as "unobtainable", and it does not mean that: merchant inventories are
// deliberately outside the survey (11 §13 -- leveled-list RNG that restocks on a timer is not a
// stable surface a designer can reason about), so a remedy that appears nowhere in the world may
// still be purchasable. A consumer that drops this string is making a claim we did not.
const PLACEMENT_NOTE =
  'Placement is from a world survey of loose items and containers (11 §13). MERCHANT INVENTORIES ' +
  'ARE NOT SURVEYED, so NOT_PLACED means "not found lying in the world or inside a container" -- ' +
  'it does NOT mean unobtainable; a player may still be able to buy one.';

/**
 * Pure classifier -- no database, no I/O, hand-computable. Split out for the same reason
 * `rankTopics` is: the JUDGEMENT is the part worth testing and showing, and it must be
 * exercisable without a Postgres.
 */
export function classifyGate(g: GateGap, surveyed = false): GateSufficiency {
  // Order matters: `possible` is a superset of `reliable`, so test emptiness first.
  const verdict: Verdict =
    g.possible === 0 ? 'no_remedy' : g.reliable === 0 ? 'gamble_only' : 'remedy_exists';

  // ⚠️ FAIL TO UNKNOWN, never to NOT_PLACED. With no survey ingested every gate would otherwise
  // report zero placements -- which is indistinguishable from "surveyed and found nothing", and is
  // the more alarming of the two readings. Absence of data must not render as a finding.
  // Three ways to land on UNKNOWN, and they are all absences rather than findings:
  //   1. no survey ingested at all;
  //   2. no gap-closing remedy is of a SURVEYABLE type -- a spell-only gate cannot be answered by
  //      a survey of loose items and containers, and reporting NOT_PLACED there would claim we
  //      looked somewhere we cannot look;
  // only when we could have seen a placement does NOT_PLACED mean anything.
  const reachable: Reachability = !surveyed
    ? 'UNKNOWN'
    : g.surveyable_possible === 0
      ? 'UNKNOWN'
      : g.placed_remedies > 0
        ? 'PLACED'
        : 'NOT_PLACED';

  return {
    ...g,
    verdict,
    reachable,
    placed_remedies: surveyed ? g.placed_remedies : 0,
    placed_areas: surveyed ? g.placed_areas : 0,
  };
}

export function classifyGates(
  rows: GateGap[],
  surveyed = false,
  limit?: number,
): SufficiencyResult {
  // Rows arrive ordered by `fails` desc, so a truncated page is "the gates hurting the most
  // players" rather than an arbitrary slice -- which is the only ordering that makes a limit
  // defensible on a triage view at all.
  const gates = (limit === undefined ? rows : rows.slice(0, limit)).map((r) =>
    classifyGate(r, surveyed),
  );
  return {
    reachability_note: surveyed ? PLACEMENT_NOTE : REACHABILITY_NOTE,
    surveyed,
    total_gates: rows.length,
    gates,
  };
}

/**
 * The gate query, extracted so it has exactly ONE definition.
 *
 * Phase 4c's insight generator needs the same numbers this endpoint reports. Writing a second
 * query for "the same" gate would create two definitions of `gap_p90`, and the moment one is
 * tuned (a different percentile, a changed `trigger` filter) the insight would describe a gate the
 * dashboard does not show -- with both halves internally consistent and no error anywhere. That is
 * the derived-artefact drift of 11 §14 in miniature, and the cheap fix is to not have two.
 */
export async function queryGates(): Promise<GateGap[]> {
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
      select e.affected, e.affected_kind, e.magnitude_min, e.magnitude_max, r.type as rec_type,
             coalesce(pl.areas, 0) as placed_areas
      from record_effects e
      join game_records r on r.record_id = e.record_id
      -- ⚠️ lower(record_id) is MANDATORY. Lua reports record ids lowercase; the corpus stores them
      -- mixed-case (Potion_Local_Brew_01, ingred_Dae_cursed_emerald_01). Joining raw silently drops
      -- those items -- no error, no missing-row signal, just a quietly smaller answer. Measured:
      -- a naive join loses real rows (4 vs 3 on the smallest fixture that can show it).
      left join lateral (
        select count(*)::int as areas
        from item_placements p
        where p.item_record_id = lower(r.record_id)
      ) pl on true
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
      count(rm.affected) filter (where rm.magnitude_min is null)::int      as unknown_magnitude,
      -- Reachability, restricted to remedies that ACTUALLY CLOSE THE GAP. Counting placements of
      -- any Fortify item would say "reachable" on the strength of a +5 potion against a 25-point
      -- gap -- true about the world, and useless about the gate.
      count(rm.affected) filter (
        where rm.magnitude_max >= g.gap_p90 and rm.placed_areas > 0
      )::int as placed_remedies,
      coalesce(sum(rm.placed_areas) filter (where rm.magnitude_max >= g.gap_p90), 0)::int
        as placed_areas,
      -- Only ALCH/INGR can appear in item_placements at all (see GateGap.surveyable_possible).
      count(rm.affected) filter (
        where rm.magnitude_max >= g.gap_p90 and rm.rec_type in ('ALCH', 'INGR')
      )::int as surveyable_possible
    from gates g
    -- affected_kind is load-bearing, not decoration: skill and attribute ids collide across the
    -- two enums, so joining on affected alone would credit a stat with another stat's remedies.
    left join remedies rm
      on rm.affected = g.stat
     and rm.affected_kind = g.stat_kind
    group by 1, 2, 3, 4, 5, 6, 7
    order by g.fails desc
  `);
  return rows.rows as unknown as GateGap[];
}

/**
 * Has a world survey ever been ingested?
 *
 * Asked separately on purpose: inferring it from "did any gate report a placement" would report
 * NOT_PLACED for every gate on an empty database, which is a finding rather than an absence.
 */
export async function isSurveyed(): Promise<boolean> {
  const r = (await db.execute(sql`select count(*)::int as n from world_surveys`))
    .rows as unknown as [{ n: number }];
  return r[0].n > 0;
}

/**
 * Default page size.
 *
 * ⚠️ BEHAVIOUR CHANGE, 2026-08-09, made deliberately. This endpoint used to return every gate:
 * measured at **6,687 gates / 1.86 MB** on the local database, which is not a page render, it is a
 * download. The old behaviour is still reachable with an explicit `?limit=`, and `total_gates`
 * makes the truncation visible rather than silent -- the same rule `reachable: UNKNOWN` follows,
 * that an absence must be stated instead of inferred.
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2000;

export async function sufficiency(req: Request, res: Response): Promise<void> {
  const raw = Number(req.query.limit);
  // NaN (absent or junk) takes the default; a valid number is clamped. `limit=0` is honoured as
  // "counts only, no rows", which is a legitimate way to ask how many gates exist.
  const limit = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), 0), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const [rows, surveyed] = await Promise.all([queryGates(), isSurveyed()]);
  res.json(classifyGates(rows, surveyed, limit));
}
