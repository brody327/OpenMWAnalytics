import { z } from 'zod';

// Validates the ENVELOPE hard; leaves `data` as an open object (generic transport).
// One schema gives us both runtime validation AND a static TS type (z.infer).
export const eventEnvelope = z.object({
  v: z.number().int().positive(),
  type: z.string().min(1),                 // any non-empty string; governed by the registry, not here
  seq: z.number().int().nonnegative(),
  install_id: z.uuid(),
  session_id: z.uuid(),
  ts: z.number().int().positive(),         // event time as epoch milliseconds
  data: z.record(z.string(), z.unknown()).default({}),
});

export type EventEnvelope = z.infer<typeof eventEnvelope>;

// The shipper POSTs a batch (array) of events. Require at least one.
export const eventBatch = z.array(eventEnvelope).min(1);
