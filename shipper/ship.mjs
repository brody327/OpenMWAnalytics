// OpenMW Analytics shipper (loop-closing version).
//
// Tails openmw.log, extracts OMWA1 events, and POSTs them in batches to the API.
// This connects game -> log -> shipper -> API -> Postgres.
//
// Still intentionally simple (a real design lives in design docs/04_SHIPPER_DESIGN.md):
//   - starts at end-of-file, so it ships only events emitted AFTER it starts
//     (avoids replaying old/pre-reload log lines)
//   - offset tracking + truncation detection (openmw.log is overwritten each launch)
//   - one batch POST per poll
// Not yet: durable offset across restarts, retry/backoff on failure. See 04.

import fs from 'node:fs';

const LOG = process.argv[2] ?? 'C:\\Documents\\My Games\\OpenMW\\openmw.log';
const API = process.env.OMWA_API ?? 'http://localhost:4000/events';
const SENTINEL = 'OMWA1 ';
const POLL_MS = 1000;

// Start at EOF: only ship what happens from now on.
let offset = (() => {
  try { return fs.statSync(LOG).size; } catch { return 0; }
})();

function extract(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(SENTINEL);
    if (i === -1) continue;
    const payload = line.slice(i + SENTINEL.length);
    try {
      events.push(JSON.parse(payload));
    } catch {
      console.warn('[shipper] bad payload:', payload);
    }
  }
  return events;
}

async function post(batch) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`[shipper] sent ${batch.length} →`, body);
    } else {
      console.error(`[shipper] API ${res.status}:`, body);
    }
  } catch (e) {
    console.error('[shipper] POST failed (is the API up?):', e.message);
  }
}

async function pump() {
  let stat;
  try {
    stat = fs.statSync(LOG);
  } catch {
    return;
  }
  if (stat.size < offset) {
    console.log('[shipper] truncation detected (game relaunched) — resetting');
    offset = 0;
  }
  if (stat.size === offset) return;

  const len = stat.size - offset;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(LOG, 'r');
  fs.readSync(fd, buf, 0, len, offset);
  fs.closeSync(fd);

  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return; // wait for a complete line
  const complete = text.slice(0, lastNl);
  offset += Buffer.byteLength(complete, 'utf8') + 1;

  const batch = extract(complete);
  if (batch.length) await post(batch);
}

console.log(`[shipper] tailing ${LOG}`);
console.log(`[shipper] posting to ${API}`);
setInterval(pump, POLL_MS);
