// Step 7 harness, v2.
//
// ⚠️ v1 WAS INVALID: query vectors were sampled FROM the indexed corpus, so every query's true
// top-10 was exactly the set of nodes HNSW linked it to at build time. Recall came out 100% at
// every ef_search -- a benchmark that cannot discriminate, which reads identically to a benchmark
// that says the index is perfect. Queries must be OUT OF DISTRIBUTION: real search intents,
// embedded fresh, that are not themselves rows in the table.
//
// Also reports BUFFERS, because at this corpus size latency is not where the two plans differ --
// residency is. A seq scan streams the whole table; an HNSW walk touches ~1k pages randomly.
import 'dotenv/config';
import pg from 'pg';


import { OpenAIEmbeddingProvider } from './embeddings.js';

const K = 10;
const EF_VALUES = [10, 20, 40, 80, 160, 320];

// Real search intents a mod author might issue -- themes, mechanics, places, objects. None of
// these strings is a row in game_chunks.
const QUERIES = [
  'bribing a guard to look the other way', 'a shrine that cures disease',
  'someone betraying the Great Houses', 'how to join the thieves guild',
  'a potion that makes you more persuasive', 'slavery and the abolitionists',
  'a haunted tomb full of undead', 'smuggling moon sugar into the city',
  'the ashlanders and their prophecies', 'a sword forged by the dwemer',
  'renting a bed for the night', 'a murder nobody witnessed',
  'corruption inside the temple', 'training to become a better armorer',
  'a witch selling illegal spells', 'the blight storms spreading sickness',
  'someone lying about an alibi', 'silt strider travel between towns',
  'a locked chest that needs a key', 'rumours about the emperor',
  'guards demanding payment for a crime', 'an artifact hidden in a cave',
  'joining the imperial legion', 'a merchant who cheats customers',
  'restoring lost magicka quickly', 'a family feud over inheritance',
  'poison brewed from local plants', 'the nerevarine prophecy',
  'a bounty placed on a criminal', 'enchanting armour with fire resistance',
  'someone gone missing in the swamp', 'the daedric princes and their shrines',
  'negotiating a better price', 'a book about the history of vvardenfell',
  'sneaking past a sleeping guard', 'a disease carried by rats',
  'an argument about land ownership', 'summoning a creature to fight for you',
  'a spy reporting to the blades', 'levitating to reach a high ledge',
  // Second batch: 40 queries gave 400 recall samples, tight enough for the trend but not for
  // 1-point differences -- ef_search=160 read lower than 80, which is sampling noise rather
  // than a real dip. Doubling the query set halves the standard error.
  'a cure for vampirism', 'stealing from a locked house at night',
  'an argument between two rival merchants', 'the dwemer disappearance mystery',
  'paying off a debt to a creditor', 'a guild that trains mages',
  'weapons that drain an opponents health', 'a festival or holiday celebration',
  'someone impersonating a noble', 'crossing a bridge guarded by a troll',
  'a shipment of contraband seized', 'learning to swim faster underwater',
  'an oath sworn to a house lord', 'a ghost that will not rest',
  'buying property in a settlement', 'a plague afflicting livestock',
  'the difference between the temple and the imperial cult', 'repairing broken equipment',
  'a duel to settle an insult', 'reading someones private correspondence',
  'a slave escaping their master', 'silver weapons against werewolves',
  'gathering ingredients from mushrooms', 'a warning about bandits on the road',
  'someone who cannot be trusted with secrets', 'the price of a good enchantment',
  'a prophecy about a chosen outlander', 'guards patrolling the city walls',
  'a hidden passage behind a bookshelf', 'trading with the ashlander tribes',
  'recovering a stolen family heirloom', 'a spell to detect hidden enemies',
  'someone drunk in a tavern causing trouble', 'the legal punishment for theft',
  'an expedition into ancient ruins', 'a rivalry between two great houses',
  'protecting a caravan from raiders', 'a letter delivered in secret',
  'someone selling forged documents', 'resisting the effects of poison',
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const provider = new OpenAIEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY! });

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

const vectors = (await provider.embed(QUERIES)).map((v) => `[${v.join(',')}]`);
console.log(`queries: ${QUERIES.length} (out-of-distribution)   k: ${K}   corpus: 36,567\n`);

/**
 * Buffers touched during EXECUTION.
 *
 * ⚠️ Take the FIRST Buffers line — the topmost plan node — and stop. A parent node's counts
 * already INCLUDE every descendant's, so summing the tree double-counts and inflates the total
 * (an earlier version reported 124,528 buffers for a seq scan over a 58 MB table: ~996 MB, which
 * is impossible and should have been the tell). The trailing "Planning: Buffers:" line is
 * likewise excluded — it is not execution work.
 */
const buffersOf = (plan: string[]) => {
  for (const line of plan) {
    if (/^\s*Planning:/.test(line)) break;
    const m = /shared hit=(\d+)(?: read=(\d+))?/.exec(line);
    if (m) return +m[1] + +(m[2] ?? 0);
  }
  return 0;
};

// --- ground truth ----------------------------------------------------------------------------
const truth: string[][] = [];
const exactMs: number[] = [], exactBuf: number[] = [];
for (const v of vectors) {
  const c = await pool.connect();
  try {
    // ⚠️ BEGIN is load-bearing: SET LOCAL outside a transaction block is a WARNING and a no-op,
    // so without this the "exact" query silently uses the HNSW index and the benchmark compares
    // one configuration against itself, reporting 100% recall.
    await c.query('BEGIN');
    await c.query('SET LOCAL enable_indexscan = off');
    await c.query('SET LOCAL enable_bitmapscan = off');
    const t0 = performance.now();
    const { rows } = await c.query(
      `SELECT chunk_id FROM game_chunks ORDER BY embedding <=> $1::vector LIMIT $2`, [v, K]);
    exactMs.push(performance.now() - t0);
    truth.push(rows.map((r) => r.chunk_id));
    const ex = await c.query(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT chunk_id FROM game_chunks ORDER BY embedding <=> $1::vector LIMIT $2`,
      [v, K]);
    // ASSERT THE PLAN. Measuring without checking what ran is how the previous version reported
    // 100% recall for a ground truth that was itself approximate.
    const plan = ex.rows.map((r) => r['QUERY PLAN']).join('\n');
    if (!/Seq Scan/.test(plan)) throw new Error('ground truth is NOT exact, plan used an index:\n' + plan.slice(0, 240));
    exactBuf.push(buffersOf(ex.rows.map((r) => r['QUERY PLAN'])));
    await c.query('COMMIT');
  } finally { c.release(); }
}
console.log(`EXACT KNN (seq scan = ground truth)   p50 ${pct(exactMs, 0.5).toFixed(2)} ms   ` +
  `p95 ${pct(exactMs, 0.95).toFixed(2)} ms   buffers ~${Math.round(pct(exactBuf, 0.5))}\n`);

console.log('  ef_search   recall@10   p50 ms   p95 ms   buffers');
console.log('  ---------   ---------   ------   ------   -------');
for (const ef of EF_VALUES) {
  let hits = 0;
  const ms: number[] = [], buf: number[] = [];
  for (let i = 0; i < vectors.length; i++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL hnsw.ef_search = ${ef}`);
      const t0 = performance.now();
      const { rows } = await c.query(
        `SELECT chunk_id FROM game_chunks ORDER BY embedding <=> $1::vector LIMIT $2`,
        [vectors[i], K]);
      ms.push(performance.now() - t0);
      const want = new Set(truth[i]);
      for (const r of rows) if (want.has(r.chunk_id)) hits++;
      const ex = await c.query(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT chunk_id FROM game_chunks ORDER BY embedding <=> $1::vector LIMIT $2`,
        [vectors[i], K]);
      const plan = ex.rows.map((r) => r['QUERY PLAN']).join('\n');
      if (!/hnsw/.test(plan)) throw new Error('expected the HNSW index, got:\n' + plan.slice(0, 240));
      buf.push(buffersOf(ex.rows.map((r) => r['QUERY PLAN'])));
      await c.query('COMMIT');
    } finally { c.release(); }
  }
  console.log(
    `  ${String(ef).padStart(9)}   ${((hits / (vectors.length * K)) * 100).toFixed(1).padStart(8)}%   ` +
    `${pct(ms, 0.5).toFixed(2).padStart(6)}   ${pct(ms, 0.95).toFixed(2).padStart(6)}   ` +
    `${String(Math.round(pct(buf, 0.5))).padStart(7)}`);
}

await pool.end();
