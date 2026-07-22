// Thin runner for the friction rollup fold. The logic lives in the app
// (src/stats/frictionRollup.ts) so a scheduler can call it in-process; this script is for
// manual/cron invocation. Requires a build first (imports from dist).
//
//   npm run build && node scripts/refresh-friction.mjs [lateness]
//
// `lateness` is a Postgres interval string (default '10 minutes') -- the allowed-lateness
// watermark: a session is settled once its newest event was received more than this ago.
import { refreshFrictionRollup } from '../dist/stats/frictionRollup.js';
import { pool } from '../dist/db/client.js';

const lateness = process.argv[2] ?? '10 minutes';
const t0 = Date.now();
try {
  const folded = await refreshFrictionRollup(lateness);
  console.log(`[friction-rollup] folded ${folded} settled session(s) in ${Date.now() - t0} ms (lateness=${lateness})`);
} finally {
  await pool.end();
}
