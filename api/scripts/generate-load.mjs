// Generate realistic synthetic telemetry volume for performance work.
//
// WHY THIS EXISTS: the real dataset is ~100 rows. Every query plan over it is a sequential
// scan, and correctly so -- you cannot learn anything about indexing, query plans, or when
// a materialized view earns its place from a table that fits in one page. Postgres
// performance work needs volume before it means anything.
//
// ⚠️ WHY THE DISTRIBUTION MATTERS MORE THAN THE ROW COUNT: uniform random data makes tuning
// teach the WRONG lessons. Index selectivity depends on cardinality and skew. If every value
// appears equally often then every index looks equally good, the planner's estimates are
// trivially correct, and you never meet the cases that actually matter -- a partial index, a
// composite column ORDER, a matview that beats a live aggregate. Real event streams are
// skewed, so this models:
//
//   - sessions per install : power law   (most players play once or twice; a few, hundreds)
//   - events per session   : log-normal  (most sessions short; a long tail of marathons)
//   - event type mix       : measured from the real data (see TYPE_MIX)
//   - payload values       : Zipf        (a few checks/areas are hot, most are rare)
//   - time                 : sessions scattered over N days, events clustered within them
//
// ⚠️ SYNTHETIC DATA IS MARKED env='synthetic' AND BELONGS ONLY IN A LOCAL DATABASE.
// It is a third provenance alongside 'dev' (the author) and 'prod' (a real player) -- so it
// can never be mistaken for either, and can be removed in one statement. Do NOT point this
// at RDS.
//
//   cd api
//   node scripts/generate-load.mjs --dry-run          # show the plan, write nothing
//   node scripts/generate-load.mjs --events 1000000   # generate
//   node scripts/generate-load.mjs --wipe             # remove all synthetic rows
//
// Flags: --events N (default 1e6) --installs N (default 2000) --days N (default 180)
//        --seed N (default 42, reproducible) --batch N (default 5000)

import 'dotenv/config';
import pg from 'pg';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const TARGET = flag('events', 1_000_000);
const INSTALLS = flag('installs', 2_000);
const DAYS = flag('days', 180);
const SEED = flag('seed', 42);
const BATCH = flag('batch', 5_000);
const DRY = has('dry-run');
const WIPE = has('wipe');
const ENV = 'synthetic';

// --- deterministic RNG (mulberry32) -----------------------------------------
// Seeded so a run is REPRODUCIBLE: the same seed yields the same dataset, so a "this query
// got faster" claim compares like with like instead of against freshly-rolled dice.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);

/** Log-normal-ish positive integer, clamped. Long right tail, no negatives. */
function logNormal(median, sigma, min, max) {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(max, Math.max(min, Math.round(median * Math.exp(sigma * z))));
}

/** Zipf-ish index into a list of size n: index 0 is dramatically hotter than index n-1. */
function zipf(n, skew = 1.1) {
  const r = rand();
  return Math.min(n - 1, Math.floor(n * Math.pow(r, skew * 2)));
}

function uuid() {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += h[Math.floor(rand() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const pickZipf = (arr) => arr[zipf(arr.length)];

// --- content pools (mirror the real registry so queries actually work) -------
const SUSPECTS = ['titania', 'gathris', 'jeanus', 'errnan', 'lelene'];
const TOPICS = ['name_at_scene', 'crime_scene', 'caldera', 'quarrel', 'alibi', 'ledger', 'inheritance'];
const KINDS = ['fact', 'pattern', 'texture'];
const REASONS = ['wrong_evidence', 'wrong_claim', 'missing_requirement', 'irrelevant_evidence', 'missing_required_tag', 'insufficient_support'];
const EVIDENCE = ['titania_blood_writing', 'body_drag_trail', 'desk_corner_blood', 'bloody_handprint', 'gathris_glove_scene', 'errnan_stoneflower', 'cane_dagger_scene', 'flordius_room_rope', 'lelene_comb_flordius_room', 'jeanus_death_estimate', 'jeanus_exterior_inspection', 'forged_gathris_document', 'stolen_fortification_potions', 'pantry_vials_wrong', 'animeral_alchemy_set'];
const AREAS = ['west gash region', 'ascadian isles region', 'Fastus Retreat, Main House', 'Fastus Retreat, Main House, Top Floor', 'Fastus Retreat, Guest House', 'Balmora, Guild of Mages', 'ashlands region', 'Fastus Retreat, Grounds'];
const SKILLS = [
  ['security', 'skill'], ['alchemy', 'skill'], ['acrobatics', 'skill'], ['alteration', 'skill'],
  ['mysticism', 'skill'], ['marksman', 'skill'], ['shortblade', 'skill'],
  ['luck', 'attribute'], ['personality', 'attribute'], ['strength', 'attribute'], ['agility', 'attribute'], ['intelligence', 'attribute'],
];
const CHECK_RECORDS = ['ccff_j_mortar', 'ccff_attic_vent_in', 'ccff_flordius_room_rope', 'ccff_gathris_glove_scene', 'ccff_desk', 'ccff_jeanus_inventory_lockbox_puzzle', 'ccff_balcony_check', 'ccff_empty_levitation_bottle_balcony', 'ccff_maid_quarters', 'ccff_vault_door'];
const ACTIONS = ['examine', 'analyze', 'open', 'enter', 'smell', 'force', 'guess', 'search'];

// Measured from the real dataset (2026-07-20), excluding retired placeholders.
const TYPE_MIX = [
  ['SkillCheckResolved', 0.33],
  ['EvidenceCollected', 0.23],
  ['AreaEntered', 0.21],
  ['ConfrontationAttempted', 0.13],
  ['ConfrontationTopicEntered', 0.05],
  ['ConfrontationExited', 0.03],
  ['PuzzleAttempted', 0.02],
];
const CUM = [];
{
  let acc = 0;
  for (const [t, p] of TYPE_MIX) { acc += p; CUM.push([t, acc]); }
}
function pickType() {
  const r = rand();
  for (const [t, c] of CUM) if (r <= c) return t;
  return 'AreaEntered';
}

function payloadFor(type) {
  switch (type) {
    case 'AreaEntered': {
      const area = pickZipf(AREAS);
      return { area, interior: !area.endsWith('region') };
    }
    case 'EvidenceCollected':
      return { evidence_id: pickZipf(EVIDENCE) };
    case 'ConfrontationTopicEntered':
      return { suspect: pickZipf(SUSPECTS), topic: pickZipf(TOPICS), kind: pick(KINDS) };
    case 'ConfrontationExited':
      return { suspect: pickZipf(SUSPECTS), completed: rand() < 0.35 };
    case 'PuzzleAttempted':
      return { puzzle_id: pickZipf(CHECK_RECORDS), action_id: pick(ACTIONS), passed: rand() < 0.3 };
    case 'ConfrontationAttempted': {
      const passed = rand() < 0.25;
      const kind = rand() < 0.5 ? 'fact' : 'pattern';
      const n = kind === 'pattern' ? 1 + Math.floor(rand() * 3) : 1;
      const ids = Array.from({ length: n }, () => pickZipf(EVIDENCE));
      const d = { suspect: pickZipf(SUSPECTS), topic: pickZipf(TOPICS), kind, passed, evidence_ids: ids };
      if (!passed) d.reason = pickZipf(REASONS);
      if (kind === 'pattern') d.claim_index = 1 + Math.floor(rand() * 4);
      return d;
    }
    case 'SkillCheckResolved': {
      const [skill, statType] = pickZipf(SKILLS);
      // Thresholds cluster on round numbers; values spread around them so margins are
      // realistic -- a mix of near misses and hopeless gaps rather than uniform noise.
      const threshold = [25, 30, 35, 40, 50, 60, 100][zipf(7)];
      const value = Math.max(0, Math.round(threshold + (rand() - 0.55) * 60));
      const thresholdPassed = value >= threshold;
      const passed = thresholdPassed || rand() < 0.0005; // weird_success_chance
      const d = {
        trigger: rand() < 0.9 ? 'inspect' : 'environment',
        check_id: `${pickZipf(CHECK_RECORDS)}:${pick(ACTIONS)}`,
        skill, stat_type: statType,
        skill_value: value, threshold,
        passed, threshold_passed: thresholdPassed,
      };
      if (rand() < 0.4) d.require = rand() < 0.7 ? 'any' : 'all';
      if (thresholdPassed && rand() < 0.3) d.skill_route = skill;
      return d;
    }
    default:
      return {};
  }
}

// --- main -------------------------------------------------------------------
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const target = (await client.query('select current_database() db, inet_server_addr() host')).rows[0];
console.log(`[load] database : ${target.db} @ ${target.host ?? 'local socket'}`);

// Refuse to touch anything that is not obviously a local database. Synthetic rows in the
// production store would be indistinguishable from real play in every chart.
const url = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('[load] REFUSING: DATABASE_URL is not localhost. Synthetic data belongs in a LOCAL database only.');
  process.exit(1);
}

if (WIPE) {
  const r = await client.query(`delete from events where env = $1`, [ENV]);
  console.log(`[load] wiped ${r.rowCount} synthetic rows.`);
  await client.end();
  process.exit(0);
}

// Plan the sessions up front so the summary is honest before anything is written.
const installs = Array.from({ length: INSTALLS }, () => uuid());
const now = Date.now();
const windowMs = DAYS * 86_400_000;

const sessions = [];
let planned = 0;
while (planned < TARGET) {
  // Power law over installs: index 0 plays constantly, the tail plays once.
  const install = installs[zipf(installs.length, 1.3)];
  const n = logNormal(60, 1.1, 3, 4000);   // events in this session
  const start = now - Math.floor(rand() * windowMs);
  sessions.push({ id: uuid(), install, n: Math.min(n, TARGET - planned), start });
  planned += n;
}

console.log(`[load] plan    : ${planned.toLocaleString()} events / ${sessions.length.toLocaleString()} sessions / ${INSTALLS.toLocaleString()} installs`);
console.log(`[load] spread  : ${DAYS} days, seed ${SEED}, env='${ENV}'`);
if (DRY) {
  const sizes = sessions.map((s) => s.n).sort((a, b) => a - b);
  const q = (p) => sizes[Math.floor(sizes.length * p)];
  console.log(`[load] session sizes: p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${sizes[sizes.length - 1]}`);
  console.log('[load] DRY RUN - nothing written.');
  await client.end();
  process.exit(0);
}

// Insert via unnest(): ONE parameterised statement per batch regardless of row count,
// instead of N placeholders. Keeps the protocol payload small and the plan cached.
const SQL = `
  insert into events (session_id, seq, install_id, type, v, ts, data, env)
  select * from unnest(
    $1::uuid[], $2::int[], $3::uuid[], $4::text[], $5::smallint[], $6::timestamptz[], $7::jsonb[], $8::text[]
  )
  on conflict do nothing`;

const cols = [[], [], [], [], [], [], [], []];
let written = 0;
const t0 = Date.now();

async function flush() {
  if (!cols[0].length) return;
  await client.query(SQL, cols);
  written += cols[0].length;
  for (const c of cols) c.length = 0;
  const secs = (Date.now() - t0) / 1000;
  process.stdout.write(`\r[load] ${written.toLocaleString()} / ${planned.toLocaleString()}  (${Math.round(written / secs).toLocaleString()}/s)   `);
}

for (const s of sessions) {
  let t = s.start;
  for (let seq = 1; seq <= s.n; seq++) {
    const type = pickType();
    t += 500 + Math.floor(rand() * 25_000); // 0.5-25s between events
    cols[0].push(s.id);
    cols[1].push(seq);
    cols[2].push(s.install);
    cols[3].push(type);
    cols[4].push(1);
    cols[5].push(new Date(t).toISOString());
    cols[6].push(JSON.stringify(payloadFor(type)));
    cols[7].push(ENV);
    if (cols[0].length >= BATCH) await flush();
  }
}
await flush();

console.log(`\n[load] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const summary = await client.query(`select env, count(*) from events group by env order by 2 desc`);
console.table(summary.rows);
await client.end();
