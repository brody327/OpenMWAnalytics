import 'dotenv/config';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { ingest } from './events/ingest.js';
import { listEvents, listMods } from './events/list.js';
import { requireIngestToken } from './events/auth.js';
import { confrontations } from './stats/confrontations.js';
import { friction } from './stats/friction.js';
import { skills } from './stats/skills.js';
import { ranking } from './stats/ranking.js';
import { search } from './search/search.js';
import { freshness, heartbeat } from './ops/freshness.js';

const app = express();
app.use(express.json());

// Liveness check. Wired to k8s livenessProbe AND readinessProbe, so a non-200 here means
// "restart this pod and take it out of rotation".
//
// ⚠️ NOTHING ABOUT DATA MAY EVER BE ADDED HERE. This endpoint answers "is this process
// healthy", not "is the pipeline healthy" -- see /ops/freshness below, which deliberately
// does not share this route. Folding staleness in would let a dead shipper on someone's
// laptop crashloop production.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Pipeline freshness (design docs 04). 503 when a shipper has gone silent, so a dumb external
// uptime monitor can page a human. NO KUBERNETES PROBE MAY POINT AT THIS.
app.get('/ops/freshness', freshness);

// Shipper liveness ping. Authenticated like the other write path -- it writes to the database,
// and an open endpoint would let anyone forge "the pipeline is fine".
app.post('/ops/heartbeat', requireIngestToken, heartbeat);

// Ingestion. Authenticated: this is the only WRITE path, and deployment put it on the
// public internet. The read side below stays deliberately open (see events/auth.ts).
app.post('/events', requireIngestToken, ingest);

// Raw event feed (the explorer). Same path as ingest, different verb: POST writes events,
// GET reads them back. Read side, so it is open like /stats/*.
app.get('/events', listEvents);
app.get('/mods', listMods);

// Query / read side (aggregations for the dashboard).
app.get('/stats/confrontations', confrontations);
app.get('/stats/friction', friction);
app.get('/stats/skills', skills);
app.get('/stats/ranking', ranking);

// Hybrid search over the game corpus (design docs 11). NOT under /stats: /stats reports on
// TELEMETRY, this queries a second corpus -- the game's own text -- and joins to it.
app.get('/search', search);

// Central error handler (Express 5 forwards async rejections here).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api] error:', err);
  res.status(500).json({ error: 'internal' });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
