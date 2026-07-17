// Ingestion spike shipper.
//
// Tails openmw.log, extracts the OMWA1 sentinel lines our Lua mod emits,
// parses the JSON payload, and prints what a real shipper would POST.
// No dependencies — plain Node (run with: node shipper/tail-spike.mjs).
//
// Demonstrates the two things a real log-tailing shipper must handle:
//   - read only NEW bytes since last poll (offset tracking)
//   - detect truncation (openmw.log is overwritten on each game launch)
// It intentionally advances the offset only to the last complete line,
// so a half-flushed trailing line is re-read next tick instead of dropped.

import fs from 'node:fs';

const LOG =
  process.argv[2] ?? 'C:\\Documents\\My Games\\OpenMW\\openmw.log';
const SENTINEL = 'OMWA1 ';
const POLL_MS = 1000;

let offset = 0;

function handleLine(line) {
  const i = line.indexOf(SENTINEL);
  if (i === -1) return; // not one of ours
  const payload = line.slice(i + SENTINEL.length);
  try {
    const evt = JSON.parse(payload);
    console.log('[shipper] would POST:', JSON.stringify(evt));
  } catch {
    console.warn('[shipper] bad payload:', payload);
  }
}

function pump() {
  let stat;
  try {
    stat = fs.statSync(LOG);
  } catch {
    return; // log not there yet
  }

  if (stat.size < offset) {
    console.log('[shipper] truncation detected (game relaunched) — resetting');
    offset = 0;
  }
  if (stat.size === offset) return; // nothing new

  const len = stat.size - offset;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(LOG, 'r');
  fs.readSync(fd, buf, 0, len, offset);
  fs.closeSync(fd);

  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return; // no complete line yet; wait for more

  const complete = text.slice(0, lastNl);
  offset += Buffer.byteLength(complete, 'utf8') + 1; // +1 for the '\n'

  for (const line of complete.split(/\r?\n/)) handleLine(line);
}

console.log(`[shipper] tailing ${LOG}`);
setInterval(pump, POLL_MS);
pump();
