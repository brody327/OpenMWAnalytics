import { getEvents, type EventFilters } from '../../lib/events';

// Route Handler: the browser's door to the event feed.
//
// WHY A PROXY AT ALL. The first page of the feed is rendered by the Server Component, but
// "Load more" happens in the browser after a click -- and the browser cannot call Express
// directly for two reasons:
//
//   1. `OMWA_API_BASE` is a SERVER env var (no NEXT_PUBLIC_ prefix) precisely so the API
//      origin never ships in the client bundle. Exposing it would be a deliberate reversal
//      of a decision lib/stats.ts made on purpose.
//   2. Express sets no CORS headers, because until now nothing in a browser ever called it.
//      Adding CORS would widen the API's public surface to satisfy one button.
//
// A Route Handler runs on the Next server, so it can read the server env and talk to Express
// over the private path, while the browser only ever sees a same-origin URL. This is the
// "backend for frontend" pattern -- the thinnest possible one: it adds no logic, it exists
// only to move the call to the right side of the network boundary.
//
// It stays a thin pass-through DELIBERATELY. The moment it starts reshaping data, the feed has
// two implementations that must agree -- the server-rendered first page and this one -- and
// they will drift.

// The same allow-list the Express endpoint accepts. Enumerated rather than forwarded wholesale
// so this cannot become an open relay for arbitrary query parameters.
const ALLOWED = ['mod_id', 'type', 'env', 'session_id', 'suspect', 'topic', 'cursor'] as const;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const filters: EventFilters = {};
  for (const key of ALLOWED) {
    const value = url.searchParams.get(key);
    if (value) filters[key] = value;
  }

  const rawLimit = Number(url.searchParams.get('limit') ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;

  const { page, error } = await getEvents(filters, limit);
  if (!page) {
    // 502, not 500: the failure is upstream, and saying so lets the client distinguish "the
    // API is down" from "this route is broken".
    return Response.json({ error: error ?? 'upstream unavailable' }, { status: 502 });
  }
  return Response.json(page);
}
