// Phase 4c HTTP surface (design docs 05, 12).
//
// FOUR ROUTES, AND THE BOUNDARY BETWEEN THEM IS THE PRODUCT DECISION:
//
//   POST /insights/generate   authenticated   costs money and writes a row
//   GET  /insights            PUBLIC          approved insights only
//   GET  /insights/review     authenticated   the pending queue
//   POST /insights/:id/review authenticated   approve or reject
//
// "Human review" (résumé bullet 5) is only a real claim if unreviewed output cannot reach a
// reader. That is why the public route filters on `status = 'approved'` in SQL rather than taking
// a `status` query parameter with a safe default: a default is a suggestion, and
// `?status=pending` would make the review step decorative for anyone who reads the URL bar.

import type { Request, Response } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { insights } from '../db/schema.js';
import { generateInsight } from './generate.js';
import { providerFromEnv } from './provider.js';

/** Columns the public may see. `evidence` is deliberately absent -- see below. */
const publicColumns = {
  id: insights.id,
  check_id: insights.checkId,
  stat: insights.stat,
  threshold: insights.threshold,
  headline: insights.headline,
  signposting: insights.signposting,
  rationale: insights.rationale,
  recommendation: insights.recommendation,
  citations: insights.citations,
  model: insights.model,
  created_at: insights.createdAt,
};

/**
 * ⭐ THE CAVEAT RIDES ON THE RESPONSE, like `/stats/sufficiency`'s reachability note.
 *
 * A consumer that renders the insight and drops this string is making a claim we did not: that a
 * machine wrote it, and that it is a judgement about retrieved text rather than a measurement.
 * Putting it in the payload rather than only in the UI means a second consumer -- a script, a
 * different frontend, an interviewer poking the API -- cannot lose it by accident.
 */
const GENERATED_NOTE =
  'Model-generated from a fixed evidence payload and reviewed by a human before approval. ' +
  'Every number and cited record was checked against that evidence. Whether a player can OBTAIN ' +
  'any remedy is NOT addressed here -- see /stats/sufficiency `reachable`.';

const generateBody = z.object({
  check_id: z.string().min(1),
});

const reviewBody = z.object({
  status: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
});

/**
 * POST /insights/generate
 *
 * ⚠️ AUTHENTICATED BECAUSE IT SPENDS MONEY. Every other write path here is guarded because it
 * mutates data; this one is guarded because an open endpoint that calls a paid model is a
 * denial-of-wallet, not just a denial-of-service. It reuses the ingest token rather than adding a
 * second secret -- one credential to rotate, and it already fails closed.
 */
export async function postGenerate(req: Request, res: Response): Promise<void> {
  const parsed = generateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'check_id is required' });
    return;
  }

  // FAILS CLOSED, unlike search's lexical degradation. There is no honest half of an insight, so
  // an unconfigured key is reported as unavailable rather than quietly serving the offline fake --
  // a placeholder rendered as a finding is worse than an empty panel.
  const provider = providerFromEnv();
  if (!provider) {
    console.error('[insights] ANTHROPIC_API_KEY is not set; generation is unavailable.');
    res.status(503).json({ error: 'insight generation not configured' });
    return;
  }

  const result = await generateInsight(parsed.data.check_id, provider);

  // Status codes carry the distinction the caller actually needs: did WE decline to publish this
  // (422, and here are the violations), or did the request never make sense (404)?
  switch (result.status) {
    case 'stored':
      res.status(201).json({ ...result, note: GENERATED_NOTE });
      return;
    case 'rejected':
      res.status(422).json(result);
      return;
    case 'no_gate':
      res.status(404).json(result);
      return;
    default:
      res.status(422).json(result);
  }
}

/** GET /insights?check_id=… — PUBLIC. Approved only, and not negotiable via query string. */
export async function listInsights(req: Request, res: Response): Promise<void> {
  const checkId = typeof req.query.check_id === 'string' ? req.query.check_id : null;
  const rows = await db
    .select(publicColumns)
    .from(insights)
    .where(
      checkId
        ? and(eq(insights.status, 'approved'), eq(insights.checkId, checkId))
        : eq(insights.status, 'approved'),
    )
    .orderBy(desc(insights.createdAt))
    .limit(50);

  res.json({ note: GENERATED_NOTE, insights: rows });
}

/**
 * GET /insights/review — authenticated. The pending queue.
 *
 * Returns `evidence` as well, which the public route withholds. That asymmetry is the point: a
 * reviewer cannot judge "is this a correct inference?" without the exact payload the model saw,
 * and that payload is the one thing the mechanical guards cannot check for them.
 */
export async function listPending(_req: Request, res: Response): Promise<void> {
  const rows = await db
    .select({ ...publicColumns, evidence: insights.evidence, status: insights.status })
    .from(insights)
    .where(eq(insights.status, 'pending'))
    .orderBy(insights.createdAt)
    .limit(50);

  res.json({ pending: rows.length, insights: rows });
}

/** POST /insights/:id/review — authenticated. The state transition bullet 5 claims. */
export async function reviewInsight(req: Request, res: Response): Promise<void> {
  const parsed = reviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    return;
  }

  // Validate the id BEFORE it reaches Postgres. `id` is a uuid column, so a non-uuid path segment
  // raises a driver error that surfaces as a 500 -- an operator-facing "something broke" for what
  // is plainly a malformed request. Checking here turns it into the 400 it always was.
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  const [row] = await db
    .update(insights)
    .set({
      status: parsed.data.status,
      reviewNote: parsed.data.note ?? null,
      reviewedAt: new Date(),
    })
    // Only a PENDING insight may be reviewed. Without this an approved insight could be silently
    // re-approved (or flipped) by a replayed request, and `reviewed_at` would move with no record
    // of what changed -- an audit trail that quietly rewrites itself is worse than none.
    .where(and(eq(insights.id, id.data), eq(insights.status, 'pending')))
    .returning({ id: insights.id, status: insights.status });

  if (!row) {
    res.status(404).json({ error: 'no pending insight with that id' });
    return;
  }
  res.json(row);
}
