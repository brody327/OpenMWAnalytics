// Entrypoint for the friction rollup fold. The logic lives in stats/frictionRollup.ts; this is
// only the process wrapper -- argument, logging, exit code, pool teardown.
//
//   local:  npm run refresh-friction [lateness]
//   prod:   k8s/cronjob-friction-rollup.yaml runs `node dist/jobs/refreshFriction.js` every 5 min
//
// It lives in src/ (not scripts/) DELIBERATELY: the Dockerfile's runtime stage copies only
// dist/, so a plain .mjs under scripts/ is absent from the image and the CronJob dies with
// MODULE_NOT_FOUND on every tick. Compiling it means the image and local dev run the identical
// artifact, and the entrypoint is type-checked like everything else.
//
// `lateness` is a Postgres interval string (default '10 minutes') -- the allowed-lateness
// watermark: a session is settled once its newest event was received more than this ago.
import { refreshFrictionRollup } from '../stats/frictionRollup.js';
import { pool } from '../db/client.js';

const lateness = process.argv[2] ?? '10 minutes';
const t0 = Date.now();

try {
  const folded = await refreshFrictionRollup(lateness);
  console.log(
    `[friction-rollup] folded ${folded} settled session(s) in ${Date.now() - t0} ms (lateness=${lateness})`,
  );
} catch (err) {
  // Exit non-zero so the CronJob's Job is marked FAILED and shows up in `kubectl get jobs`,
  // rather than a silent success with an error buried in the pod log. The fold is a single
  // transaction, so a failure has already rolled back -- there is nothing to clean up, and the
  // next tick simply retries the same settled set.
  console.error('[friction-rollup] FAILED', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
