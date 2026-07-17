import type { Request, Response } from 'express';
import { db } from '../db/client.js';
import { events } from '../db/schema.js';
import { eventBatch } from './schema.js';

// POST /events — accept a batch, validate the envelope, upsert idempotently.
export async function ingest(req: Request, res: Response): Promise<void> {
  const parsed = eventBatch.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid batch', details: parsed.error.issues });
    return;
  }

  // Map wire (snake_case, epoch-ms) -> row (drizzle fields, Date). Convert at the boundary.
  const rows = parsed.data.map((e) => ({
    sessionId: e.session_id,
    seq: e.seq,
    installId: e.install_id,
    type: e.type,
    v: e.v,
    ts: new Date(e.ts), // epoch ms -> Date -> timestamptz (UTC)
    data: e.data,
  }));

  // Idempotent insert: existing (session_id, seq) rows are skipped, not errored.
  // .returning() yields only the rows actually inserted, so the difference is the
  // duplicate count — making at-least-once dedup observable.
  const insertedRows = await db
    .insert(events)
    .values(rows)
    .onConflictDoNothing({ target: [events.sessionId, events.seq] })
    .returning({ seq: events.seq });

  const received = rows.length;
  const inserted = insertedRows.length;
  res.json({ received, inserted, duplicates: received - inserted });
}
