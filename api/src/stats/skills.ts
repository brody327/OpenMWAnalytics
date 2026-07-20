import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// GET /stats/skills
//
// The read side for SkillCheckResolved (design docs 03 / 10 Q1.2, Q3.1, Q3.3).
//
// WHY THIS EXISTS: a pass-rate over skill checks is nearly useless on its own. Five real
// checks from a 2026-07-20 play session, all failed -- a pass-rate view reports "0%, too
// hard" and stops:
//
//     strength    44 / 50   -> margin  -6    <- six points short. Tuning candidate.
//     marksman    10 / 40   -> margin -30    <- not a marksman. No tuning fixes this.
//     personality 29 / 50   -> margin -21
//     shortblade  15 / 35   -> margin -20
//
// Identical failure rates, completely different work. That is the whole argument for
// storing skill_value and threshold RAW and deriving margin here: margin answers "by how
// much", and the bucketing below turns that into an actual decision.
//
// TWO RULES ENCODED HERE, both easy to get wrong:
//
//  1. `trigger = 'inspect'` on every friction metric. A PASSIVE (environment) check was
//     never opted into -- the player didn't know it happened -- so its failure carries no
//     frustration signal. Mixing passive rows into a difficulty metric corrupts it with
//     checks nobody chose to take (03, SkillCheckResolved).
//
//  2. Difficulty reads `threshold_passed`, NOT `passed`. `weird_success_chance` can flip a
//     genuine failure into a pass that is deliberately indistinguishable in-game. Counting
//     a fluke as a real pass would inflate the pass-rate of exactly the hardest checks --
//     the ones whose data most needs to be honest. `passed` is what the player
//     experienced; `threshold_passed` is what the numbers actually did.
export async function skills(_req: Request, res: Response): Promise<void> {
  // Q1.2 -- per check: how often it is cleared, and how badly it is missed.
  // Margin is derived, never stored. Fail margins only (a pass margin is a different
  // question -- "how much headroom", not "how short").
  const byCheck = await db.execute(sql`
    with checks as (
      select
        data->>'check_id'                   as check_id,
        data->>'skill'                      as skill,
        data->>'stat_type'                  as stat_type,
        (data->>'skill_value')::int         as skill_value,
        (data->>'threshold')::int           as threshold,
        (data->>'skill_value')::int - (data->>'threshold')::int as margin,
        (data->>'threshold_passed')::boolean as threshold_passed,
        (data->>'passed')::boolean           as passed
      from events
      where type = 'SkillCheckResolved'
        and data->>'trigger' = 'inspect'
    )
    select
      check_id,
      skill,
      stat_type,
      count(*)::int                                                      as attempts,
      (count(*) filter (where threshold_passed))::int                    as passes,
      round(avg(threshold_passed::int), 3)::float                        as pass_rate,
      -- flukes: the player saw a pass the numbers did not earn.
      (count(*) filter (where passed and not threshold_passed))::int      as fluke_passes,
      round(avg(margin) filter (where not threshold_passed), 1)::float   as avg_fail_margin,
      max(margin) filter (where not threshold_passed)::int               as closest_fail_margin,
      min(margin) filter (where not threshold_passed)::int               as worst_fail_margin
    from checks
    group by check_id, skill, stat_type
    order by attempts desc, check_id
  `);

  // Q1.2 (actionable form) -- classify each UNSOLVED (session, check) pair by how far short
  // the player got.
  // This is the output that tells the author what KIND of work a failure implies, which
  // a pass-rate cannot. Thresholds are judgement calls, documented rather than tuned:
  //   >= -10  a near miss -- the bar may simply be a few points too high
  //   -11..-15 a real gap, but a plausible build could close it
  //   <= -16  the player is not built for this route at all; tuning is the wrong lever
  //
  // near_miss was widened from -5 to -10 by author judgement (2026-07-20): a check missed
  // by six points reads as "so close", and should suggest lowering the bar rather than
  // "wrong build". These are content-design opinions, not statistics -- change them freely,
  // but change them HERE so every consumer agrees on what a near miss is.
  //
  // GRAIN: one row per (session_id, check_id), NOT per attempt. Found the hard way
  // 2026-07-20 -- a single retryable "trust to luck" action was spammed 20 times in one
  // session and became 20 of 30 rows, so the distribution described that one action's
  // repeatability rather than player experience. A cheap repeatable check must not
  // outvote a costly one. One player, one check, one vote.
  //
  // Two consequences of that grain, both deliberate:
  //   - a (session, check) where ANY attempt eventually cleared the bar is NOT a failure
  //     and is excluded entirely -- bool_or below;
  //   - the representative margin is max(margin), i.e. the CLOSEST the player got. "How
  //     far short did they fall" is best answered by their best attempt, not their first
  //     or their worst (a skill can rise between attempts within a session).
  const failureDistance = await db.execute(sql`
    with attempts as (
      select
        session_id,
        data->>'check_id'                                       as check_id,
        data->>'skill'                                          as skill,
        (data->>'skill_value')::int - (data->>'threshold')::int  as margin,
        (data->>'threshold_passed')::boolean                     as threshold_passed
      from events
      where type = 'SkillCheckResolved'
        and data->>'trigger' = 'inspect'
    ),
    fails as (
      select
        session_id,
        check_id,
        max(margin) as margin
      from attempts
      group by session_id, check_id
      having not bool_or(threshold_passed)
    ),
    banded as (
      select
        case
          when margin >= -10 then 'near_miss'
          when margin >= -15 then 'moderate_gap'
          else 'build_gap'
        end        as band,
        margin
      from fails
    )
    -- band must be a real column of a subquery here, not an output alias: Postgres accepts
    -- an output alias in GROUP BY and in a bare ORDER BY, but NOT inside an ORDER BY
    -- *expression* like the CASE below.
    -- (NB: never put backticks around an identifier in these SQL comments -- they close
    -- the surrounding JS template literal. This has now bitten twice.)
    select
      band,
      count(*)::int                as count,
      round(avg(margin), 1)::float as avg_margin
    from banded
    group by band
    order by
      case band when 'near_miss' then 1 when 'moderate_gap' then 2 else 3 end
  `);

  // Q3.3 / Q3.1 -- what the mod actually gates on, and which routes players take.
  // Passive checks are INCLUDED here deliberately: "which stats does this mod test"
  // is a design-coverage question, not a friction question, so an unopted check still
  // counts. `trigger` is returned so a consumer can split them.
  const byStat = await db.execute(sql`
    select
      data->>'skill'       as skill,
      data->>'stat_type'   as stat_type,
      data->>'trigger'     as trigger,
      count(*)::int        as checks,
      count(distinct data->>'check_id')::int as distinct_checks,
      round(avg((data->>'threshold_passed')::boolean::int), 3)::float as pass_rate
    from events
    where type = 'SkillCheckResolved'
    group by skill, stat_type, trigger
    order by checks desc, skill
  `);

  // Q3.1 -- archetype routes actually exercised (only set on some checks).
  const byRoute = await db.execute(sql`
    select
      data->>'skill_route' as route,
      count(*)::int        as passes
    from events
    where type = 'SkillCheckResolved'
      and data ? 'skill_route'
      and (data->>'threshold_passed')::boolean
    group by route
    order by passes desc
  `);

  res.json({
    byCheck: byCheck.rows,
    failureDistance: failureDistance.rows,
    byStat: byStat.rows,
    byRoute: byRoute.rows,
  });
}
