import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

// Pipeline freshness (design docs 04). The answer to the 2026-07-20 outage: the shipper died,
// telemetry was dark for six days, and nothing noticed because nothing was asking.
//
// ⚠️⚠️ THIS IS DELIBERATELY NOT `/health`, AND THAT SEPARATION IS LOad-BEARING.
// `k8s/deployment.yaml` wires `/health` to BOTH livenessProbe and readinessProbe. If a
// stale-data condition returned 503 there, Kubernetes would restart the API pod and pull it
// from the Service -- for a condition the API neither causes nor can fix. A dead shipper on a
// laptop would crashloop the production API: an outage caused entirely by its own monitoring.
//
//   Liveness  -> "should this process be restarted?"   (destructive remediation attached)
//   Freshness -> "is the data trustworthy?"            (informational; a human decides)
//
// Different questions, different endpoints, and no probe may ever point here.

/**
 * How long a shipper may stay silent before we call it an outage.
 *
 * Deliberately generous. The heartbeat interval is minutes, so this tolerates many consecutive
 * misses -- a laptop that slept, a flaky hotel network, a reboot. The failure we are catching
 * lasted SIX DAYS; catching it in two hours is a ~70x improvement, and buying a tighter bound
 * would only buy false alarms. An alert that cries wolf gets muted, and a muted alert is worse
 * than no alert because you believe you are covered.
 */
const STALE_AFTER_MINUTES = 120;

export interface FreshnessReport {
  ok: boolean;
  stale_after_minutes: number;
  /** Installs that have EVER sent a heartbeat, newest first. */
  shippers: Array<{
    install_id: string;
    last_seen_at: string;
    minutes_since: number;
    stale: boolean;
  }>;
  /** Newest event, for context only -- see the warning below. */
  newest_event_at: string | null;
}

export async function getFreshness(): Promise<FreshnessReport> {
  const [shippers, events] = await Promise.all([
    db.execute(sql`
      SELECT install_id,
             last_seen_at,
             EXTRACT(EPOCH FROM (now() - last_seen_at)) / 60 AS minutes_since
      FROM shipper_state
      ORDER BY last_seen_at DESC
    `),
    db.execute(sql`SELECT max(received_at) AS newest FROM events`),
  ]);

  const rows = (shippers.rows as Array<{
    install_id: string; last_seen_at: string; minutes_since: string;
  }>).map((r) => {
    const mins = Math.round(Number(r.minutes_since));
    return {
      install_id: r.install_id,
      last_seen_at: new Date(r.last_seen_at).toISOString(),
      minutes_since: mins,
      stale: mins > STALE_AFTER_MINUTES,
    };
  });

  const newest = (events.rows as Array<{ newest: string | null }>)[0]?.newest ?? null;

  return {
    // No shippers registered yet is NOT ok: it means either nothing has ever checked in, or the
    // table was wiped. Both deserve a human looking, and defaulting to green on an empty table
    // is how a monitor silently monitors nothing.
    ok: rows.length > 0 && rows.every((r) => !r.stale),
    stale_after_minutes: STALE_AFTER_MINUTES,
    shippers: rows,
    // ⚠️ REPORTED, NEVER ALERTED ON. max(received_at) only advances when somebody PLAYS, so in
    // any quiet period it grows without bound and a perfectly healthy pipeline looks broken --
    // exactly the bug `frictionFoldState` exists to avoid one layer down. "Is the shipper alive"
    // and "is anyone playing" are different questions; only the first is an outage.
    newest_event_at: newest ? new Date(newest).toISOString() : null,
  };
}

/**
 * GET /ops/freshness — 200 when every known shipper is current, **503 when any is stale**.
 *
 * The non-200 is the entire point: it lets a dumb external uptime monitor (which understands
 * status codes and nothing else) page a human. A checker nobody polls would have missed the
 * six-day outage exactly as completely as no checker at all -- the endpoint is not the
 * monitoring, the thing that reads it is.
 */
export async function freshness(_req: Request, res: Response): Promise<void> {
  try {
    const report = await getFreshness();
    res.status(report.ok ? 200 : 503).json(report);
  } catch (err) {
    // A failure to ASSESS freshness is itself not-ok. Returning 200 here would make a broken
    // database read as a healthy pipeline, which is the failure mode this file exists to remove.
    console.error('[ops] freshness check failed', err);
    res.status(503).json({ ok: false, error: 'freshness check failed' });
  }
}

/**
 * POST /ops/heartbeat — the shipper saying "I am alive", with or without events to send.
 *
 * UPSERT on install_id: one row per install, forever. Bounded by how many people run the mod,
 * never by how long they run it (`schema.ts` shipperState).
 */
export async function heartbeat(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as {
    install_id?: unknown; last_shipped_seq?: unknown; shipper_version?: unknown;
  };
  const installId = typeof body.install_id === 'string' ? body.install_id.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(installId)) {
    res.status(400).json({ error: 'install_id must be a uuid' });
    return;
  }
  const seq = Number.isInteger(body.last_shipped_seq) ? (body.last_shipped_seq as number) : null;
  const version = typeof body.shipper_version === 'string'
    ? body.shipper_version.slice(0, 64)
    : null;

  await db.execute(sql`
    INSERT INTO shipper_state (install_id, last_seen_at, last_shipped_seq, shipper_version)
    VALUES (${installId}, now(), ${seq}, ${version})
    ON CONFLICT (install_id) DO UPDATE
      SET last_seen_at     = now(),
          -- COALESCE so a heartbeat that omits the seq cannot ERASE a known one.
          last_shipped_seq = COALESCE(EXCLUDED.last_shipped_seq, shipper_state.last_shipped_seq),
          shipper_version  = COALESCE(EXCLUDED.shipper_version,  shipper_state.shipper_version)
  `);

  res.json({ ok: true });
}
