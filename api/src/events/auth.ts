import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

// Ingest authentication for POST /events (design docs 05 / 09 §6).
//
// WHY ONLY THE WRITE PATH: /stats/* and /health stay deliberately public — they are
// aggregate, anonymous, and being readable is the entire point of a portfolio dashboard.
// Deployment moved POST /events from "unreachable on localhost" to "world-writable on the
// internet", so the write path — and only the write path — needs a gate.
//
// WHAT THIS DOES AND DOES NOT BUY: the shipper runs on machines we do not control. If the
// mod is ever distributed, the token ships with it and is extractable — the same reason an
// API key baked into a mobile app is not really a secret. So this is NOT a strong guarantee
// against a determined attacker; it is a barrier against opportunistic and accidental
// writes, which is the realistic threat while exactly one shipper exists. If the mod is
// distributed, the right model becomes per-install keys (revocable, rate-limitable) plus
// server-side data-quality defence — never trust of the client.

const HEADER = 'authorization';
const SCHEME = 'Bearer ';

/**
 * Constant-time string compare.
 *
 * A plain `===` short-circuits on the first differing byte, leaking prefix and length
 * information through response timing. Over TLS with network jitter that signal is largely
 * theoretical here, but the mitigation is free.
 *
 * timingSafeEqual THROWS if the buffers differ in length — which would itself leak length —
 * so lengths are compared first and a mismatch takes the same path as a bad value.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Require a valid bearer token on the ingest endpoint.
 *
 * FAILS CLOSED. If OMWA_INGEST_TOKEN is unset the endpoint rejects everything with 503 and
 * logs loudly, rather than silently waving traffic through. A missing config must break
 * noisily — "auth quietly stopped existing after someone changed an env var" is the classic
 * way a control disappears without anyone noticing.
 */
export function requireIngestToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.OMWA_INGEST_TOKEN;

  if (!expected) {
    console.error(
      '[api] REFUSING INGEST: OMWA_INGEST_TOKEN is not set. The write path is closed until it is.',
    );
    res.status(503).json({ error: 'ingest not configured' });
    return;
  }

  const header = req.headers[HEADER];
  const value = Array.isArray(header) ? header[0] : header;

  if (!value || !value.startsWith(SCHEME) || !safeEqual(value.slice(SCHEME.length), expected)) {
    // 401 (not 403): the credential is missing or wrong, rather than a valid identity
    // being denied access to a resource.
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
}
