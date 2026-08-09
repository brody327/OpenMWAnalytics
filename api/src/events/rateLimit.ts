// Rate limiting (design docs 05).
//
// WHAT THIS ADDS THAT AUTH DID NOT. `requireIngestToken` stops ANONYMOUS writes. It does nothing
// about a client that HAS a valid token and floods the endpoint -- and since the token ships with
// the mod and is extractable (events/auth.ts is explicit that it is not really a secret), "a valid
// token" is not a high bar. Auth answers *who*; a limiter answers *how much*.
//
// ⚠️ IN-MEMORY, AND THAT IS A REAL LIMIT, NOT A DETAIL:
//   - counters reset on pod restart, so a rollout briefly forgives everyone;
//   - counters are per-process, so the effective limit multiplies by the replica count.
// Both are acceptable at one replica on one node (09), and neither is acceptable if this ever
// scales out -- at which point the fix is a shared store (Redis), not a bigger number here. Said
// out loud because "we have rate limiting" is exactly the sort of claim that stops being true
// quietly when the deployment changes.

import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

/** Standard `RateLimit-*` headers, no legacy `X-RateLimit-*`. */
const HEADER_POLICY = { standardHeaders: 'draft-7', legacyHeaders: false } as const;

/**
 * Ingest: generous, because the shipper legitimately batches.
 *
 * Sized against real behaviour rather than a round number: the shipper posts a batch per poll
 * interval, so a normal minute is single-digit requests. 120/min leaves two orders of magnitude of
 * headroom for a catch-up burst after an outage -- which is a REAL scenario here (a six-day
 * silent outage in 2026-07) and must not be mistaken for abuse and throttled at exactly the moment
 * the pipeline is trying to heal itself.
 */
export const ingestLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 120,
  ...HEADER_POLICY,
  message: { error: 'too many requests' },
});

/**
 * Insight generation: tight, because each request costs MONEY.
 *
 * This is a denial-of-wallet control, not a denial-of-service one, so the number is chosen against
 * spend rather than load. Generation is a deliberate, human-triggered action -- nothing legitimate
 * needs it faster than this, and the failure mode of being too generous is a bill.
 */
export const generateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 10,
  ...HEADER_POLICY,
  message: { error: 'too many generation requests' },
});

/**
 * Reads: a backstop, not a gate.
 *
 * The read side is deliberately public (auth.ts) -- being readable is the point of a portfolio
 * dashboard. This exists so a scraper cannot trivially exhaust a `db.t3.micro`'s connections, and
 * is set well above what a person clicking around a dashboard produces. A limit low enough to
 * inconvenience a real reader would be trading the product away for a threat we have not seen.
 */
export const readLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 300,
  ...HEADER_POLICY,
  message: { error: 'too many requests' },
});
