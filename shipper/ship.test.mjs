import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// SHIPPER RELIABILITY — the most specific claim in the project, previously verified only by
// having run it.
//
// `04_SHIPPER_DESIGN.md` states the guarantee: at-least-once delivery via post-then-checkpoint,
// a durable offset, and relaunch detection by first-line fingerprint. Every one of those is a
// statement about what happens when something goes WRONG — the API is down, the process restarts,
// the game recreates the log — which is precisely the state you cannot confirm by watching it work
// on a good day.
//
// ⭐ `post()` is NOT stubbed. `globalThis.fetch` is, so the real post-then-checkpoint path runs
// including the 2xx check that decides whether the offset moves. Faking `post` would test the fake.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omwa-ship-'));
const LOG = path.join(dir, 'openmw.log');
const STATE = path.join(dir, 'state.json');

process.env.OMWA_LOG = LOG;
process.env.OMWA_STATE_FILE = STATE;
process.env.OMWA_API = 'http://127.0.0.1:1/events'; // never reached; fetch is stubbed

let ship;
const realFetch = globalThis.fetch;

/** Record every POST and control the response. */
let posted = [];
let respond = { ok: true, status: 200 };
const stubFetch = async (_url, init) => {
  posted.push(JSON.parse(init.body));
  return {
    ok: respond.ok,
    status: respond.status,
    json: async () => ({ inserted: 1 }),
  };
};

const line = (seq, extra = {}) =>
  `Global[script]:\tOMWA1 ${JSON.stringify({
    install_id: '00000000-0000-4000-8000-0000000000aa',
    session_id: '00000000-0000-4000-8000-0000000000bb',
    seq,
    type: 'ConfrontationAttempted',
    v: 1,
    ts: 1700000000000,
    data: { suspect: 's', topic: 't', passed: false },
    ...extra,
  })}\n`;

const BANNER = 'OpenMW version 0.51.0 launch 2026-08-09T10:00:00\n';

before(async () => {
  globalThis.fetch = stubFetch;
  ship = await import('./ship.mjs');
});

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  posted = [];
  respond = { ok: true, status: 200 };
  ship._state.offset = 0;
  ship._state.fingerprint = null;
  fs.rmSync(STATE, { force: true });
});

// ── extract ───────────────────────────────────────────────────────────────────────────────────

test('extract pulls OMWA1 events out of noisy log lines', () => {
  const events = ship.extract(
    ['[INFO] loading cell', line(1).trim(), 'LuaText warning: blah', line(2).trim()].join('\n'),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2],
  );
});

test('extract ignores lines without the sentinel', () => {
  assert.equal(ship.extract('nothing here\nor here').length, 0);
});

test('⭐ a malformed payload is SKIPPED, not fatal — one bad line cannot stall the pipeline', () => {
  // The log is shared with the engine. A truncated or mangled line must not stop the shipper
  // forever, because the offset would never advance past it and every later event would be stuck
  // behind it.
  const events = ship.extract(`OMWA1 {not json\n${line(7).trim()}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 7);
});

// ── fingerprint ───────────────────────────────────────────────────────────────────────────────

test('fingerprint is null until the first line is complete', () => {
  // A still-being-written opening line must not yield a partial fingerprint — that would look
  // like a brand new file and force a spurious reship of the whole log.
  fs.writeFileSync(LOG, 'OpenMW version 0.51.0 (no newline yet)');
  const fd = fs.openSync(LOG, 'r');
  try {
    assert.equal(ship.fileFingerprint(fd, fs.statSync(LOG).size), null);
  } finally {
    fs.closeSync(fd);
  }
});

test('fingerprint changes when the first line changes, and is stable when it does not', () => {
  fs.writeFileSync(LOG, BANNER + 'more\n');
  let fd = fs.openSync(LOG, 'r');
  const a = ship.fileFingerprint(fd, fs.statSync(LOG).size);
  fs.closeSync(fd);

  fs.appendFileSync(LOG, 'even more\n');
  fd = fs.openSync(LOG, 'r');
  const b = ship.fileFingerprint(fd, fs.statSync(LOG).size);
  fs.closeSync(fd);
  assert.equal(a, b, 'appending must not change the fingerprint');

  fs.writeFileSync(LOG, 'OpenMW version 0.51.0 launch 2026-08-09T11:30:00\n');
  fd = fs.openSync(LOG, 'r');
  const c = ship.fileFingerprint(fd, fs.statSync(LOG).size);
  fs.closeSync(fd);
  assert.notEqual(a, c, 'a new launch banner must change the fingerprint');
});

// ── at-least-once: post-then-checkpoint ───────────────────────────────────────────────────────

test('⭐⭐ a FAILED post leaves the offset put — nothing is lost', async () => {
  // THE headline claim. If the offset advanced on failure, every API blip would silently drop a
  // batch: no error surfaces at the shipper, the events simply never exist. The only observable
  // would be a gap in data nobody knows to look for.
  fs.writeFileSync(LOG, BANNER + line(1) + line(2));
  respond = { ok: false, status: 500 };

  await ship.pump();

  assert.equal(posted.length, 1, 'it should have attempted delivery');
  assert.equal(ship._state.offset, 0, 'a failed POST must NOT advance the offset');
  assert.equal(fs.existsSync(STATE), false, 'and must not checkpoint');
});

test('⭐⭐ the next poll RE-SENDS what the failed one held', async () => {
  // The other half of at-least-once. "Offset stayed put" is only valuable if the retry actually
  // resends — otherwise the events sit unread until the file rotates.
  fs.writeFileSync(LOG, BANNER + line(1) + line(2));
  respond = { ok: false, status: 500 };
  await ship.pump();

  respond = { ok: true, status: 200 };
  await ship.pump();

  assert.equal(posted.length, 2, 'a second attempt should have been made');
  assert.deepEqual(
    posted[1].map((e) => e.seq),
    [1, 2],
    'the retry must contain the same events',
  );
  assert.ok(ship._state.offset > 0, 'now that it succeeded, the offset advances');
});

test('a SUCCESSFUL post advances the offset and persists a checkpoint', async () => {
  fs.writeFileSync(LOG, BANNER + line(1));
  await ship.pump();

  assert.equal(posted.length, 1);
  assert.equal(ship._state.offset, fs.statSync(LOG).size);
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  assert.equal(saved.offset, ship._state.offset);
  assert.ok(saved.fingerprint, 'the checkpoint must carry the fingerprint too');
});

test('already-shipped events are not sent twice on a later poll', async () => {
  fs.writeFileSync(LOG, BANNER + line(1));
  await ship.pump();
  await ship.pump();
  assert.equal(posted.length, 1, 'nothing new in the file means nothing to post');
});

// ── partial lines ─────────────────────────────────────────────────────────────────────────────

test('⭐ a half-written trailing line is NOT consumed', async () => {
  // Tailing a file the game is actively writing WILL catch a line mid-flush. Consuming it would
  // parse half a JSON object and, worse, advance the offset past the rest — losing the event
  // permanently with only a "bad payload" warning to show for it.
  fs.writeFileSync(LOG, BANNER + line(1) + 'Global[script]:\tOMWA1 {"seq":2,"inc');
  await ship.pump();

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].map((e) => e.seq), [1]);

  // ⭐ And the held-back line is DELIVERED once the game finishes writing it. Holding it is only
  // correct if it eventually ships — otherwise "not consumed" would just be a slower way to lose
  // it. (The first draft of this test asserted the completed line was malformed; it is not —
  // {"seq":2,"incomplete":true} is valid JSON — so the shipper was right and the assertion wrong.)
  fs.appendFileSync(LOG, 'omplete":true}\n');
  await ship.pump();

  assert.equal(posted.length, 2, 'the completed line must now be shipped');
  assert.deepEqual(posted[1].map((e) => e.seq), [2], 'and it is the event that was held back');
});

// ── relaunch / truncation ─────────────────────────────────────────────────────────────────────

test('⭐⭐ a relaunch (new first line) reships from the top, even if the file GREW', async () => {
  // Why fingerprinting rather than `size < offset`: OpenMW recreates the log each launch, and a
  // new session can pass the old offset before the first poll. Size alone would see a bigger file,
  // assume it was the same one, and skip everything written before the old offset — silently
  // losing the start of every session.
  fs.writeFileSync(LOG, BANNER + line(1));
  await ship.pump();
  const afterFirst = ship._state.offset;
  assert.ok(afterFirst > 0);

  // Relaunch: new banner, and deliberately LONGER than the previous file.
  const newBanner = 'OpenMW version 0.51.0 launch 2026-08-09T12:00:00\n';
  fs.writeFileSync(LOG, newBanner + line(10) + line(11) + line(12));
  assert.ok(fs.statSync(LOG).size > afterFirst, 'the new log must be larger for this to be a real test');

  await ship.pump();

  assert.equal(posted.length, 2);
  assert.deepEqual(
    posted[1].map((e) => e.seq),
    [10, 11, 12],
    'the whole new session must be shipped, not just the bytes past the old offset',
  );
});

test('a truncation (file shrank) also resets to the top', async () => {
  fs.writeFileSync(LOG, BANNER + line(1) + line(2) + line(3));
  await ship.pump();

  // Same banner, fewer bytes — fingerprint unchanged, so only the size check can catch this.
  fs.writeFileSync(LOG, BANNER + line(9));
  await ship.pump();

  assert.deepEqual(posted[1].map((e) => e.seq), [9]);
});

// ── durable offset across a restart ───────────────────────────────────────────────────────────

test('⭐ loadState resumes from the checkpoint rather than starting at EOF', async () => {
  // The point of the sidecar file: a shipper restart must not skip everything written while it
  // was down. Starting at EOF is correct only on a FIRST run with no checkpoint.
  fs.writeFileSync(LOG, BANNER + line(1));
  await ship.pump();
  const checkpoint = ship._state.offset;

  // Simulate a restart: wipe in-memory state, reload from disk.
  ship._state.offset = 0;
  ship._state.fingerprint = null;
  assert.equal(ship.loadState(), true, 'a checkpoint should be found');
  assert.equal(ship._state.offset, checkpoint, 'and it should restore the exact offset');
});

test('loadState reports false when there is no checkpoint', () => {
  fs.rmSync(STATE, { force: true });
  assert.equal(ship.loadState(), false);
});
