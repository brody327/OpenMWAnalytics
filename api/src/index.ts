import 'dotenv/config';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { ingest } from './events/ingest.js';
import { requireIngestToken } from './events/auth.js';
import { confrontations } from './stats/confrontations.js';
import { friction } from './stats/friction.js';
import { skills } from './stats/skills.js';

const app = express();
app.use(express.json());

// Liveness check.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Ingestion. Authenticated: this is the only WRITE path, and deployment put it on the
// public internet. The read side below stays deliberately open (see events/auth.ts).
app.post('/events', requireIngestToken, ingest);

// Query / read side (aggregations for the dashboard).
app.get('/stats/confrontations', confrontations);
app.get('/stats/friction', friction);
app.get('/stats/skills', skills);

// Central error handler (Express 5 forwards async rejections here).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api] error:', err);
  res.status(500).json({ error: 'internal' });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
