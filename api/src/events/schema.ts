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
  // Which mod's content this event is about ('base' = unmodded engine behaviour). OPTIONAL on
  // the wire, so this is an ADDITIVE, backward-compatible envelope change -- an older emitter
  // that omits it still validates, which is why `v` stays 1. `v` marks BREAKING changes; a new
  // optional field is not one.
  //
  // Deliberately NOT regex-validated here. A malformed id must not 400 the batch and lose real
  // telemetry -- it is normalised to 'unknown' at ingest instead, the same "collect it, make the
  // mistake visible" posture as `env` falling back to 'prod'.
  mod_id: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type EventEnvelope = z.infer<typeof eventEnvelope>;

// The shipper POSTs a batch (array) of events. Require at least one.
export const eventBatch = z.array(eventEnvelope).min(1);
