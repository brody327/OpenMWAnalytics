import 'dotenv/config';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { ingest } from './events/ingest.js';
import { listEvents, listMods } from './events/list.js';
import { requireIngestToken } from './events/auth.js';
import { ingestLimiter, generateLimiter, readLimiter } from './events/rateLimit.js';
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

// ⚠️⚠️ LOAD-BEARING FOR RATE LIMITING, AND SILENT IF WRONG.
//
// In production every request arrives via Traefik, so the TCP peer is the ingress, not the client.
// Without this, `req.ip` is the proxy's address for EVERY request — all clients share one bucket,
// and the first flooder locks out the entire internet including the shipper. The limiter would
// report itself working the whole time; the only symptom is legitimate traffic getting 429s.
//
// `1`, not `true`. `true` trusts the whole `X-Forwarded-For` chain, which is client-controlled —
// anyone could append a fake hop and get a fresh bucket per request, turning the limiter off. One
// hop is exactly the topology we have (09: Traefik -> Service -> pod).
app.set('trust proxy', 1);

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
app.post('/ops/heartbeat', ingestLimiter, requireIngestToken, heartbeat);

// Ingestion. Authenticated: this is the only WRITE path, and deployment put it on the
// public internet. The read side below stays deliberately open (see events/auth.ts).
app.post('/events', ingestLimiter, requireIngestToken, ingest);

// ── Read side ────────────────────────────────────────────────────────────────────────────────
//
// `readLimiter` is applied per-route rather than as `app.use()`, and the routes it is left OFF
// are the point:
//
//   /health   ⚠️ NEVER. The k8s liveness probe hits it every 15s. A limiter there could fail the
//             probe, k8s would restart the pod, and the "protection" would be the outage. A
//             rate-limited health check is a self-inflicted crashloop.
//   /version  same reason in spirit -- CI polls it during a deploy, and throttling that would
//             fail deploys rather than attackers.
//   /ops/freshness  an external uptime monitor polls it on a schedule; 429ing the alarm is worse
//             than the flood it would be protecting against.
//
// Everything below is a database read a scraper could actually make expensive, so it gets the
// backstop.
app.get('/events', readLimiter, listEvents);
app.get('/mods', readLimiter, listMods);

// Query / read side (aggregations for the dashboard).
app.get('/stats/confrontations', readLimiter, confrontations);
app.get('/stats/friction', readLimiter, friction);
app.get('/stats/skills', readLimiter, skills);
app.get('/stats/ranking', readLimiter, ranking);
// 10 Q3.6 -- the only /stats route that joins telemetry to the game CORPUS (11).
app.get('/stats/sufficiency', readLimiter, sufficiency);

// Hybrid search over the game corpus (design docs 11). NOT under /stats: /stats reports on
// TELEMETRY, this queries a second corpus -- the game's own text -- and joins to it.
//
// ⚠️ This one calls OPENAI on a cache miss, so an unlimited scraper here spends money as well as
// CPU -- the same denial-of-wallet shape as insight generation, at a smaller unit cost.
app.get('/search', readLimiter, search);

// Phase 4c -- generated insights (design docs 12). The only route in this API whose output was
// not computed, so it is the only one with a review gate in front of the public read.
//
// Generation is authenticated because it SPENDS MONEY (denial-of-wallet, not just abuse), and the
// review routes because they decide what the public sees. GET /insights is open like every other
// read -- and serves approved rows only, in SQL, with no query parameter that can widen it.
app.post('/insights/generate', generateLimiter, requireIngestToken, postGenerate);
app.get('/insights', readLimiter, listInsights);
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
