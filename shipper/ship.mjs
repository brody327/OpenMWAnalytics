// OpenMW Analytics shipper (reliable version).
//
// Tails openmw.log, extracts OMWA1 events, and POSTs them in batches to the API.
// game -> log -> shipper -> API -> Postgres.
//
// Reliability model (design docs/04_SHIPPER_DESIGN.md):
//   - AT-LEAST-ONCE via post-then-checkpoint: the read offset advances ONLY after a
//     successful POST. A failed POST (API down) leaves the offset put, so the next
//     poll re-reads and re-sends. Safe because the API upserts on (session_id, seq),
//     so duplicates are idempotent -- at-least-once + idempotent sink = effectively-once.
//   - DURABLE OFFSET: {offset, fingerprint} is persisted to a sidecar file after each
//     advance, so a shipper restart resumes exactly where it left off (not at EOF).
//   - ROBUST TRUNCATION/RELAUNCH: openmw.log is recreated each launch. We detect a new
//     file by fingerprinting its first line (OpenMW's banner carries a launch stamp),
//     not just size < offset -- which misses a relaunch that grew past the old offset.
//     A new fingerprint (or size < offset) resets the offset to 0 and ships the new
//     session from the top.
//   - FIRST RUN (no checkpoint): start at EOF so a large pre-existing log isn't replayed.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const LOG = process.argv[2] ?? 'C:\\Documents\\My Games\\OpenMW\\openmw.log';
const API = process.env.OMWA_API ?? 'http://localhost:4000/events';
// Shared bearer token for the authenticated ingest path. Kept in the environment, never
// in the repo. Unset is legal for a local API that is also unconfigured.
const TOKEN = process.env.OMWA_INGEST_TOKEN ?? '';
const STATE = fileURLToPath(new URL('./.ship-state.json', import.meta.url));
const SENTINEL = 'OMWA1 ';
const POLL_MS = 1000;

// --- durable state --------------------------------------------------------
let offset = 0;
let fingerprint = null;   // sha1 of the log's first line; identifies the file across launches

function saveState() {
  try {
    const tmp = STATE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ offset, fingerprint }));
    fs.renameSync(tmp, STATE);   // atomic: never leave a half-written state file
  } catch (e) {
    console.error('[shipper] could not persist state:', e.message);
  }
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (typeof s.offset === 'number') { offset = s.offset; fingerprint = s.fingerprint ?? null; return true; }
  } catch { /* no/invalid checkpoint */ }
  return false;
}

// Fingerprint = sha1 of the file's first line. Returns null until a first newline
// exists, so a still-being-written opening line never yields a partial fingerprint
// (which would look like a "new file" and force a spurious reship).
function fileFingerprint(fd, size) {
  const n = Math.min(512, size);
  if (n === 0) return null;
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, 0);
  const s = buf.toString('utf8');
  const nl = s.indexOf('\n');
  if (nl === -1) return null;
  return crypto.createHash('sha1').update(s.slice(0, nl)).digest('hex');
}

function extract(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(SENTINEL);
    if (i === -1) continue;
    try {
      events.push(JSON.parse(line.slice(i + SENTINEL.length)));
    } catch {
      console.warn('[shipper] bad payload:', line.slice(i + SENTINEL.length));
    }
  }
  return events;
}

// Returns true only on a 2xx, so the caller advances the offset iff delivery succeeded.
async function post(batch) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Ingest auth (design docs 05 / 09 §6). Omitted entirely when unset so a local
        // dev API that is also unconfigured behaves the same as it always did.
        ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
      },
      body: JSON.stringify(batch),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`[shipper] sent ${batch.length} ->`, body);
      return true;
    }
    // 401/503 are CONFIGURATION faults, not transient ones. Retrying forever would spin
    // silently against a wall, so name the cause loudly -- the offset still stays put, so
    // nothing is lost once the token is fixed.
    if (res.status === 401) {
      console.error(
        '[shipper] 401 UNAUTHORIZED — set OMWA_INGEST_TOKEN to match the API. Not a transient error; events are held, not lost.',
      );
    } else if (res.status === 503) {
      console.error(
        '[shipper] 503 — the API has no OMWA_INGEST_TOKEN configured, so its write path is closed.',
      );
    }
    console.error(`[shipper] API ${res.status} (will retry):`, body);
    return false;
  } catch (e) {
    console.error('[shipper] POST failed, will retry (is the API up?):', e.message);
    return false;
  }
}

async function pump() {
  let stat, fd;
  try {
    stat = fs.statSync(LOG);
    fd = fs.openSync(LOG, 'r');
  } catch {
    return; // log not present yet
  }
  try {
    const fp = fileFingerprint(fd, stat.size);

    // New/rotated file? A changed first-line fingerprint (relaunch) OR a shrink
    // (truncation) means the byte offset from the old file is meaningless -> restart
    // this file from the top and ship its whole session.
    const rotated = (fp !== null && fingerprint !== null && fp !== fingerprint) || stat.size < offset;
    if (rotated) {
      console.log('[shipper] new log detected (relaunch/truncation) -- reshipping from start');
      offset = 0;
    }
    if (fp !== null) fingerprint = fp;

    if (stat.size <= offset) return; // nothing new

    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);

    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return; // wait for a complete line
    const complete = text.slice(0, lastNl);
    const consumed = Buffer.byteLength(complete, 'utf8') + 1;

    const batch = extract(complete);
    if (batch.length === 0) {
      // No events in this chunk (startup spam) -- advance past it so we don't rescan.
      offset += consumed;
      saveState();
      return;
    }

    // post-then-checkpoint: advance + persist ONLY on success; otherwise retry next poll.
    if (await post(batch)) {
      offset += consumed;
      saveState();
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Startup: resume from a durable checkpoint if we have one; else start at EOF so a
// large pre-existing log isn't replayed on first run.
if (loadState()) {
  console.log(`[shipper] resumed from checkpoint: offset=${offset}`);
} else {
  offset = (() => { try { return fs.statSync(LOG).size; } catch { return 0; } })();
  console.log(`[shipper] no checkpoint -- starting at EOF (offset=${offset})`);
}
console.log(`[shipper] tailing ${LOG}`);
console.log(`[shipper] posting to ${API}`);
setInterval(pump, POLL_MS);
