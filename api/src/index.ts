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
import { sufficiency } from './stats/sufficiency.js';
import { search } from './search/search.js';
import { freshness, heartbeat } from './ops/freshness.js';
import {
  postGenerate,
  listInsights,
  listPending,
  reviewInsight,
} from './insights/routes.js';

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

// WHICH BUILD IS SERVING THIS REQUEST (design docs 09).
//
// This exists because /health could not answer it. Twice, a merged API change never reached
// production -- CI pushed a new :latest, but nothing restarted the pod and a running pod never
// re-pulls a mutable tag -- and /health returned 200 the whole time. Once the pod predated the
// code by 45 minutes; once /stats/sufficiency 404'd while /stats/ranking returned 200.
//
// The rule that makes this endpoint worth having: don't ask "does the check pass?", ask "would
// this check ALSO pass if the thing were broken?" /health emits res.json({ ok: true }) in both
// worlds, so it carries zero information about which code is running. A sha baked into the image
// at build time is an observation a STALE POD IS STRUCTURALLY INCAPABLE OF PRODUCING: to report
// the new sha it would have to BE the new image.
//
// CI asserts this equals the commit it just built, through the public ingress, and fails the
// deploy otherwise -- so "deployed" stops meaning "the push succeeded".
//
// Deliberately NOT wired to any k8s probe: an unrecognised sha is a deploy failure, not an
// unhealthy process, and restarting the pod would not fix it.
app.get('/version', (_req: Request, res: Response) => {
  res.json({
    sha: process.env.OMWA_GIT_SHA ?? 'unknown',
    built_at: process.env.OMWA_BUILT_AT ?? 'unknown',
  });
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
// 10 Q3.6 -- the only /stats route that joins telemetry to the game CORPUS (11).
app.get('/stats/sufficiency', sufficiency);

// Hybrid search over the game corpus (design docs 11). NOT under /stats: /stats reports on
// TELEMETRY, this queries a second corpus -- the game's own text -- and joins to it.
app.get('/search', search);

// Phase 4c -- generated insights (design docs 12). The only route in this API whose output was
// not computed, so it is the only one with a review gate in front of the public read.
//
// Generation is authenticated because it SPENDS MONEY (denial-of-wallet, not just abuse), and the
// review routes because they decide what the public sees. GET /insights is open like every other
// read -- and serves approved rows only, in SQL, with no query parameter that can widen it.
app.post('/insights/generate', requireIngestToken, postGenerate);
app.get('/insights', listInsights);
app.get('/insights/review', requireIngestToken, listPending);
app.post('/insights/:id/review', requireIngestToken, reviewInsight);

// Central error handler (Express 5 forwards async rejections here).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api] error:', err);
  res.status(500).json({ error: 'internal' });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
