// Refreshes the dashboard's last-known-good snapshot FROM the live API.
//
// The snapshot is what visitors see when the API is unreachable (the EC2 box is
// stopped between sessions). Capturing it from the real endpoint — rather than
// hand-editing the JSON — is the whole point: the fallback must be data that was
// genuinely true at a known moment, not plausible-looking numbers. The UI labels
// it with `capturedAt` so a stale view is never mistaken for a live one.
//
//   npm run snapshot                                  # against the deployed API
//   OMWA_API_BASE=http://localhost:4000 npm run snapshot   # against local dev

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API_BASE = process.env.OMWA_API_BASE ?? 'https://api.omwanalytics.com';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'lib', 'snapshot.json');

const res = await fetch(`${API_BASE}/stats/confrontations`, {
  signal: AbortSignal.timeout(15_000),
});
if (!res.ok) {
  console.error(`[snapshot] ${API_BASE} responded ${res.status} — snapshot NOT updated`);
  process.exit(1);
}

const { byTopic = [], byReason = [] } = await res.json();

// Refuse to overwrite a good snapshot with an empty one: an API that is up but has
// no data yet would otherwise silently erase the fallback we rely on.
if (byTopic.length === 0 && byReason.length === 0) {
  console.error('[snapshot] API returned no rows — snapshot NOT updated (refusing to blank it)');
  process.exit(1);
}

// The friction (sequence) endpoint is captured too, but is NOT allowed to fail the
// run: it was added later than /stats/confrontations, so a deployed API may not have
// it yet. Missing here => the key is absent => the UI reports "unavailable" rather
// than rendering empty arrays as though they were a real reading.
async function optional(path) {
  try {
    const r = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (r.ok) return await r.json();
    console.warn(`[snapshot] ${path} responded ${r.status} — omitting it`);
  } catch (e) {
    console.warn(`[snapshot] ${path} unreachable (${e.message}) — omitting it`);
  }
  return undefined;
}

const friction = await optional('/stats/friction');
const skills = await optional('/stats/skills');

const payload = {
  capturedAt: new Date().toISOString(),
  byTopic,
  byReason,
  ...(friction && { friction }),
  ...(skills && { skills }),
};
await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(
  `[snapshot] captured ${byTopic.length} topic rows / ${byReason.length} reason rows` +
    (friction
      ? ` / ${friction.afterFailure?.length ?? 0} after-failure + ${friction.attemptsToPass?.length ?? 0} attempts rows`
      : ' / no friction data') +
    (skills ? ` / ${skills.byCheck?.length ?? 0} skill-check rows` : ' / no skills data') +
    ` from ${API_BASE}`,
);
