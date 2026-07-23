import type { Request, Response } from 'express';
import { db } from '../db/client.js';
import { events, mods } from '../db/schema.js';
import { eventBatch } from './schema.js';

// Ingest provenance, stamped per batch from a header (see db/schema.ts `env`).
// Anything unrecognised falls back to 'prod' rather than erroring: a mislabelled batch
// should still be COLLECTED, and defaulting to 'prod' keeps a forgotten flag visible in
// the player set instead of silently discarding real events.
const ENVS = new Set(['dev', 'prod']);
function envFrom(req: Request): string {
  const raw = req.headers['x-omwa-env'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase().trim();
  return value && ENVS.has(value) ? value : 'prod';
}

// Normalise a self-declared mod id (see db/schema.ts `mod_id`).
//
// Anything absent or malformed becomes 'unknown' rather than a 400: the id is metadata about
// the event, and losing real telemetry over a bad label is a worse outcome than storing a
// visibly-wrong one. Same posture as `env` above.
//
// The API re-validates even though the Lua SDK already does, because the emitter lives in
// another author's mod -- the trust boundary is here, not there.
const MOD_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function normalizeModId(raw: string | undefined): string {
  const value = raw?.toLowerCase().trim();
  return value && MOD_ID_RE.test(value) ? value : 'unknown';
}

// POST /events — accept a batch, validate the envelope, upsert idempotently.
export async function ingest(req: Request, res: Response): Promise<void> {
  const parsed = eventBatch.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid batch', details: parsed.error.issues });
    return;
  }

  const env = envFrom(req);

  // Map wire (snake_case, epoch-ms) -> row (drizzle fields, Date). Convert at the boundary.
  const rows = parsed.data.map((e) => ({
    sessionId: e.session_id,
    seq: e.seq,
    installId: e.install_id,
    type: e.type,
    v: e.v,
    ts: new Date(e.ts), // epoch ms -> Date -> timestamptz (UTC)
    data: e.data,
    env,
    modId: normalizeModId(e.mod_id),
  }));

  // Idempotent insert: existing (session_id, seq) rows are skipped, not errored.
  // .returning() yields only the rows actually inserted, so the difference is the
  // duplicate count — making at-least-once dedup observable.
  const insertedRows = await db
    .insert(events)
    .values(rows)
    .onConflictDoNothing({ target: [events.sessionId, events.seq] })
    .returning({ seq: events.seq });

  // Auto-register the mods in this batch (see db/schema.ts `mods`). One upsert for the whole
  // batch, not one per row: dedupe in JS first, since a batch is overwhelmingly from a handful
  // of mods. Runs AFTER the insert and is deliberately not part of it -- the registry is
  // derived convenience, and failing to refresh a `last_seen_at` must never cost us events.
  const seenMods = [...new Set(rows.map((r) => r.modId))].map((modId) => ({ modId }));
  await db
    .insert(mods)
    .values(seenMods)
    .onConflictDoUpdate({ target: mods.modId, set: { lastSeenAt: new Date() } });

  const received = rows.length;
  const inserted = insertedRows.length;
  res.json({ received, inserted, duplicates: received - inserted, env });
}
