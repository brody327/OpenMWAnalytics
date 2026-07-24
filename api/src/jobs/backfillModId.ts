import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';

// ONE-TIME. Attributes pre-existing rows to a mod, by event type.
//
// `mod_id` did not exist when these rows were collected, so every one of them defaulted to
// 'unknown'. It cannot be recovered from the data -- the emitting mod is simply not recorded
// anywhere in an old row -- so this is a HISTORICAL MAPPING derived from what we know about
// which mod owned which event type at the time, not an inference the system can make in general.
//
// ⚠️ That distinction matters: nothing in the running platform may ever use this table. New
// events carry their own mod_id from the emitter. If this mapping were promoted into ingest,
// adding a second mod that emits `SkillCheckResolved` would silently mislabel it as CCFF.
//
//   npm run build && node dist/jobs/backfillModId.js [--run]
//
// Dry-run by default. Only touches rows still sitting at 'unknown', so it is idempotent and
// can never overwrite an id an emitter actually declared.
const RUN = process.argv.includes('--run');

// CCFF's bespoke content. Every one of these is emitted from TheContrivedCaseOfFlordiusFastus.
const CCFF_TYPES = [
  'ConfrontationAttempted',
  'ConfrontationTopicEntered',
  'ConfrontationExited',
  'EvidenceCollected',
  'SkillCheckResolved',
  'PuzzleAttempted',
];

// Unmodded engine behaviour, emitted by our own player.lua. 'base' rather than a mod name
// because we author no content -- see db/schema.ts.
const BASE_TYPES = ['AreaEntered'];

// Retired placeholders. They describe nothing at all, so 'base' would be a lie; leaving them
// 'unknown' is the honest label and they are already excluded from every read path.
const LEAVE_ALONE = ['Heartbeat', 'SpikeStarted'];

try {
  const before = await db.execute(sql`
    select mod_id, type, count(*)::int as n
    from events group by mod_id, type order by n desc
  `);
  console.log('[backfill] current attribution:');
  for (const r of before.rows) console.log(`  ${String(r.mod_id).padEnd(10)} ${String(r.type).padEnd(26)} ${r.n}`);

  if (!RUN) {
    console.log('\n[backfill] DRY RUN -- pass --run to write');
    console.log(`  -> 'ccff'   : ${CCFF_TYPES.join(', ')}`);
    console.log(`  -> 'base'   : ${BASE_TYPES.join(', ')}`);
    console.log(`  -> untouched: ${LEAVE_ALONE.join(', ')} (and anything unlisted)`);
  } else {
    const ccff = await db.execute(sql`
      update events set mod_id = 'ccff'
      where mod_id = 'unknown' and type in ${CCFF_TYPES}
    `);
    const base = await db.execute(sql`
      update events set mod_id = 'base'
      where mod_id = 'unknown' and type in ${BASE_TYPES}
    `);
    console.log(`\n[backfill] ccff: ${ccff.rowCount} rows, base: ${base.rowCount} rows`);

    // Register whatever now exists, so /mods lists them without waiting for new traffic.
    await db.execute(sql`
      insert into mods (mod_id)
      select distinct mod_id from events
      on conflict (mod_id) do nothing
    `);
    const after = await db.execute(sql`
      select mod_id, count(*)::int as n from events group by mod_id order by n desc
    `);
    console.log('[backfill] after:');
    for (const r of after.rows) console.log(`  ${String(r.mod_id).padEnd(10)} ${r.n}`);
  }
} finally {
  await pool.end();
}
