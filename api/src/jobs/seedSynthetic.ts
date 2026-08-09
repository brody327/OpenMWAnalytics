// Synthetic demo volume (design docs 06 §env scope, and the synthetic-data policy).
//
// WHY THIS FILE EXISTS AT ALL, RATHER THAN A SCRATCHPAD SCRIPT
//
// The local database already held 1,000,000 seeded events when this was written, and **nothing
// that produced them was ever committed** -- not in git history, not in jobs/. Reproducing the
// demo dataset meant reverse-engineering it from the rows. A generator whose output is on a public
// dashboard is infrastructure, not a scratch file.
//
// ⭐ WHAT MAKES SEEDED DATA HONEST HERE:
//   1. `env = 'synthetic'` is HARD-WIRED below, not a parameter. There is no argument anyone can
//      pass to write fabricated rows as real ones.
//   2. Findings endpoints exclude it by construction (stats/envScope.ts), so no amount of seeding
//      can turn `/gaps` or an insight into fiction.
//   3. It generates SESSIONS, not rows -- see below. Independent random events would produce a
//      friction rollup made of nonsense while looking perfectly populated.
//
// ⚠️ IT GENERATES SEQUENCES, AND IT HAS TO. `friction_rollup` classifies each failure by the NEXT
// event in the same session (`lead(...) over (partition by session_id order by seq)`):
// a retry of the same topic, a `ConfrontationExited`, or an `AreaEntered`. Random rows would fold
// into a rollup that is fully populated and entirely meaningless -- the exact "looks right vs is
// right" failure this project keeps finding, manufactured on purpose.
//
// ⚠️ THE ARTEFACT THIS DELIBERATELY DOES NOT REPRODUCE: the previous generator drew
// `skill_value = threshold - U(0, 30)`, which is why local `security` shows `gap_p90` pinned at 30
// while the threshold climbs to 100. On a public dashboard that reads as a bug in the analysis
// rather than in the data. Shortfall here scales with the threshold instead.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/** NOT a parameter. See the header. */
const ENV = 'synthetic';
const MOD_ID = 'ccff';
const TARGET_EVENTS = Number(process.env.OMWA_SEED_EVENTS ?? 180_000);
const BATCH = 1_000;

// ── deterministic PRNG ───────────────────────────────────────────────────────────────────────
// Seeded so two runs produce identical data. A generator using Math.random cannot be reasoned
// about after the fact: "why does this topic look odd" becomes unanswerable, and re-running to
// investigate changes the thing you were investigating.
let s = 0x2f6e2b1;
const rnd = () => {
  s ^= s << 13; s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;  s >>>= 0;
  return s / 0xffffffff;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

/** UUID v4 from the seeded PRNG, so install/session ids are reproducible too. */
function uuid(): string {
  const h = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += h[(Math.floor(rnd() * 16) & 0x3) | 0x8];
    else out += h[Math.floor(rnd() * 16)];
  }
  return out;
}

// ── the content being simulated ──────────────────────────────────────────────────────────────
// Suspects and topics from CCFF's real confrontation set, so the demo describes the mod the
// platform actually measures rather than invented content.
const SUSPECTS = ['titania', 'lelene', 'jeanus', 'flordius', 'emil'] as const;
const TOPICS = [
  'name_at_scene', 'motive', 'alibi', 'the_ledger', 'servant_key',
  'blood_on_cuff', 'missing_hours', 'the_letter',
] as const;
const REASONS = ['wrong_evidence', 'insufficient_evidence', 'contradicted', 'no_evidence'] as const;
const AREAS = [
  'Fastus Retreat, Main House', 'Fastus Retreat, Cellar', 'Balmora',
  'Fastus Retreat, Attic', 'Vivec, Foreign Quarter',
] as const;

/**
 * Per-(suspect, topic) difficulty and popularity, fixed up front.
 *
 * ⭐ POPULARITY IS DELIBERATELY SKEWED (a few topics get hundreds of attempts, most get a
 * handful). That spread is the entire reason the ranking view is interesting: shrinkage only
 * visibly matters when a 3-attempt topic at 100% failure sits next to a 400-attempt topic at 60%.
 * A uniform generator produces a ranking where every row has the same n and the shrinkage term
 * does nothing observable -- a demo of a feature with the feature switched off.
 */
const gates = SUSPECTS.flatMap((suspect) =>
  TOPICS.map((topic) => ({
    suspect,
    topic,
    passRate: 0.15 + rnd() * 0.75,
    // Zipf-ish: rnd()^3 puts most topics near the floor and a few far above it.
    weight: Math.max(1, Math.round(rnd() ** 3 * 60)),
  })),
);
const totalWeight = gates.reduce((a, g) => a + g.weight, 0);
const pickGate = () => {
  let r = rnd() * totalWeight;
  for (const g of gates) if ((r -= g.weight) <= 0) return g;
  return gates[gates.length - 1]!;
};

type Row = {
  session_id: string; seq: number; install_id: string; type: string;
  ts: Date; data: Record<string, unknown>;
};

/**
 * One play session: a coherent sequence the friction fold can actually read.
 *
 * The shape mirrors real play — arrive somewhere, work a few topics, retry or give up, leave.
 * Failure handling is where the rollup gets its signal, so the three next-actions are produced
 * with different probabilities rather than uniformly: players retry far more often than they
 * abandon, and abandoning is more common than walking out of the area entirely.
 */
function session(installId: string, start: Date): Row[] {
  const sessionId = uuid();
  const rows: Row[] = [];
  let seq = 0;
  let t = start.getTime();
  const step = (lo = 5, hi = 90) => { t += int(lo, hi) * 1000; return new Date(t); };

  const push = (type: string, data: Record<string, unknown>) =>
    rows.push({ session_id: sessionId, seq: seq++, install_id: installId, type, ts: new Date(t), data });

  push('AreaEntered', { area: pick(AREAS), interior: rnd() < 0.7 });

  for (let topicN = int(1, 5); topicN > 0; topicN--) {
    const g = pickGate();
    step();
    push('ConfrontationTopicEntered', { suspect: g.suspect, topic: g.topic });

    // Attempts on this topic, stopping on a pass or when the player gives up.
    for (let attempt = 0; attempt < 5; attempt++) {
      step(8, 120);
      const passed = rnd() < g.passRate;
      push('ConfrontationAttempted', {
        suspect: g.suspect,
        topic: g.topic,
        kind: pick(['fact', 'accusation', 'pressure'] as const),
        passed,
        ...(passed ? {} : { reason: pick(REASONS) }),
        evidence_ids: [pick(['servant_key_used', 'ledger_page', 'bloodied_cuff', 'witness_note'] as const)],
      });
      if (passed) break;

      // What the player does after a failure — the friction signal.
      const roll = rnd();
      if (roll < 0.62) continue;                       // retried_same: the next event is another attempt
      if (roll < 0.88) {                               // abandoned
        step(3, 40);
        push('ConfrontationExited', { suspect: g.suspect, topic: g.topic });
        break;
      }
      step(10, 200);                                   // left_area
      push('AreaEntered', { area: pick(AREAS), interior: rnd() < 0.7 });
      break;
    }
  }

  // A few skill checks per session, for /stats/skills.
  for (let i = int(0, 3); i > 0; i--) {
    step(10, 240);
    const threshold = pick([25, 30, 40, 50, 60, 75, 100] as const);
    const passed = rnd() < 0.55;
    // ⚠️ Shortfall SCALES WITH THE THRESHOLD (see header). The old generator's fixed U(0,30)
    // pinned gap_p90 at 30 for every threshold, which renders as a flat line that looks like an
    // analysis bug. A player short of a 100-point check is usually short by a lot.
    const shortfall = Math.max(1, Math.round(threshold * (0.08 + rnd() * 0.45)));
    const value = passed ? threshold + int(0, 25) : threshold - shortfall;
    push('SkillCheckResolved', {
      check_id: `ccff_${pick(['attic_vent_in', 'j_mortar', 'lelene_ring', 'flordius_trip_rug'] as const)}:${pick(['open', 'force', 'examine', 'guess'] as const)}`,
      skill: pick(['security', 'alchemy', 'strength', 'personality', 'agility', 'acrobatics'] as const),
      stat_type: rnd() < 0.5 ? 'attribute' : 'skill',
      trigger: 'inspect',
      threshold,
      skill_value: value,
      passed,
      threshold_passed: passed,
    });
  }

  return rows;
}

async function insert(rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  // ⚠️ `received_at` IS SET EXPLICITLY, not left to default now().
  //
  // The friction fold settles sessions on PROCESSING time, not event time (06: "the question is
  // about what the pipeline has received"). Leaving the default would stamp all 180k events as
  // arriving in the same instant, which is wrong twice over: a session that happened 30 days ago
  // was not received today, and every seeded session would sit inside the lateness window at once
  // — so the hybrid read would compute the whole dataset live on every dashboard load until the
  // window passed. Seeding would look like it had made the site slow.
  //
  // A small lag behind `ts` mirrors the real pipeline: the shipper tails a log and posts in
  // batches, so events arrive seconds-to-minutes after they happen.
  const values = sql.join(
    rows.map((r) => {
      const received = new Date(r.ts.getTime() + int(2, 180) * 1000).toISOString();
      return sql`(${r.session_id}::uuid, ${r.seq}, ${r.install_id}::uuid, ${r.type}, 1,
                  ${r.ts.toISOString()}::timestamptz, ${received}::timestamptz,
                  ${ENV}, ${MOD_ID}, ${JSON.stringify(r.data)}::jsonb)`;
    }),
    sql`, `,
  );
  await db.execute(sql`
    insert into events (session_id, seq, install_id, type, v, ts, received_at, env, mod_id, data)
    values ${values}
    on conflict (session_id, seq) do nothing
  `);
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');

  // ⚠️ SAY WHERE THIS IS GOING, BEFORE DOING IT. Same rule as the corpus CLI: this script writes
  // to whatever DATABASE_URL happens to be exported, and "I thought I was pointed at local" is a
  // mistake you only get to make once against a production database.
  const host = (await db.execute(sql`select inet_server_addr()::text as h, current_database() as d`))
    .rows[0] as { h: string | null; d: string };
  const target = `${host.h ?? 'local socket'} / ${host.d}`;
  console.log(`[seed] target: ${target}`);
  console.log(`[seed] env='${ENV}' (hard-wired), mod_id='${MOD_ID}', target events ~${TARGET_EVENTS}`);

  if (reset) {
    // Scoped to synthetic rows ONLY. A seeder that can delete real play data is a seeder that
    // eventually will -- the 07-26 test-fixture incident was exactly this shape.
    const del = await db.execute(sql`delete from events where env = ${ENV}`);
    console.log(`[seed] --reset: removed ${del.rowCount ?? 0} existing synthetic events`);
  }

  const t0 = Date.now();
  let written = 0;
  let buffer: Row[] = [];
  // Spread sessions over the last 60 days so time-series views have a shape.
  const now = Date.now();

  while (written + buffer.length < TARGET_EVENTS) {
    const installId = uuid();
    for (let n = int(1, 6); n > 0 && written + buffer.length < TARGET_EVENTS; n--) {
      const start = new Date(now - Math.floor(rnd() * 60 * 86_400_000));
      buffer.push(...session(installId, start));
    }
    if (buffer.length >= BATCH) {
      await insert(buffer);
      written += buffer.length;
      buffer = [];
      if (written % 20_000 < BATCH) console.log(`[seed]   ${written} events...`);
    }
  }
  await insert(buffer);
  written += buffer.length;

  const counts = await db.execute(sql`
    select type, count(*)::int n from events where env = ${ENV} group by 1 order by n desc
  `);
  console.log(`[seed] done: ${written} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const r of counts.rows as unknown as { type: string; n: number }[]) {
    console.log(`[seed]   ${r.type}: ${r.n}`);
  }
  console.log('[seed] REMINDER: findings endpoints exclude env=synthetic by default (06 §env scope).');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed] FAILED:', e);
    process.exit(1);
  });
