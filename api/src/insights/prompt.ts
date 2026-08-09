// The bounded prompt for Phase 4c (design docs 12).
//
// "Bounded" is load-bearing and means three specific things, not just "short":
//
//  1. **A fixed evidence payload.** The model receives exactly what two SQL queries and one vector
//     search produced. It cannot fetch, search, or ask for more -- there are no tools on this
//     call. Whatever it says has to come from the JSON below or it came from nowhere.
//  2. **A constrained output shape.** Structured outputs pin the fields and the three-value
//     `signposting` enum. The enum matters more than it looks: given a free-text verdict the model
//     writes a fourth, hedged answer, and UNCLEAR stops being the honest choice and becomes the
//     only one on offer.
//  3. **One call, no loop.** No agent, no retries-with-more-context, no self-critique pass. The
//     guardrail is that the model gets one bounded shot at a judgement, and a mechanical validator
//     decides whether it is publishable.
//
// ⚠️ THE PROMPT IS NOT THE GUARDRAIL. Everything below is an instruction, and instructions are
// followed most of the time -- which is a different property from enforced. The enforcement lives
// in validate.ts and runs on the output regardless of what this file asked for. If the two ever
// disagree, the validator wins and the insight is rejected. Writing the rules here as well is
// worth it because a model that understands the boundary produces publishable output far more
// often, and a rejected insight costs a call.

import type { InsightEvidence } from './validate.js';

export const SYSTEM_PROMPT = `You help a Morrowind mod author understand why players fail a specific skill check.

You will be given, as JSON:
  - the gate: which stat, the threshold, the observed p90 shortfall, and how many recorded failures
  - the remedies: items or effects the database has verified can close that shortfall
  - the passages: the game's own text (dialogue, books, descriptions) retrieved for this gate

YOUR ONE QUESTION: does the game's own text point a player toward a remedy for THIS gate?

That question is yours because it is a judgement about prose. Whether a remedy exists, how large
the shortfall is, and how many players failed are already computed -- do not re-derive them, and do
not treat them as uncertain.

RULES, in the order they matter:

1. Use ONLY the supplied evidence. Every number you write must already appear in the JSON. Every
   record you cite must be one of the supplied record_ids, copied exactly.

2. NEVER say anything about whether a player can obtain, buy, find, or reach a remedy. The data
   cannot establish it. It is not a gap for you to fill with what is generally true of the game --
   a plausible sentence here is indistinguishable from a computed one, which is what makes it
   harmful. Reachability is reported separately from a world survey.

3. UNCLEAR is a real answer and often the correct one. The passages are retrieved by similarity,
   so they may be about something else entirely. If they do not let you tell whether the text
   signposts a remedy, say UNCLEAR. Do not upgrade a weak inference to a verdict.

4. Be brief and concrete. The headline is one sentence. The rationale is two or three, and quotes
   or names the specific passage it rests on. The recommendation is one actionable sentence for
   someone who edits the mod. No preamble, no restating the numbers back, no hedging language
   about your own confidence -- the verdict field already carries that.`;

/**
 * The output contract, enforced by the API rather than requested in prose.
 *
 * `additionalProperties: false` plus a full `required` list is what makes structured outputs a
 * guarantee instead of a suggestion. Note what is absent: there is no reachability field, no
 * confidence score, and no free-text "notes". A field that does not exist cannot be filled in with
 * something we cannot support -- the cheapest guard available, and the only one that costs nothing
 * at runtime.
 */
export const INSIGHT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: 'One sentence stating the finding.',
    },
    signposting: {
      type: 'string',
      enum: ['SIGNPOSTED', 'NOT_SIGNPOSTED', 'UNCLEAR'],
      description:
        'SIGNPOSTED: a passage genuinely directs a player toward a gap-closing remedy. ' +
        'NOT_SIGNPOSTED: the text never connects a remedy to this gate. ' +
        'UNCLEAR: the retrieved prose is not sufficient to tell.',
    },
    rationale: {
      type: 'string',
      description: 'Two or three sentences naming the specific passages the verdict rests on.',
    },
    recommendation: {
      type: 'string',
      description: 'One actionable sentence for the mod author.',
    },
    citations: {
      type: 'array',
      items: { type: 'string' },
      description: 'record_ids from the evidence that the rationale relies on, copied exactly.',
    },
  },
  required: ['headline', 'signposting', 'rationale', 'recommendation', 'citations'],
  additionalProperties: false,
} as const;

/**
 * Serialise the evidence for the model.
 *
 * ⚠️ THE PAYLOAD IS THE VALIDATOR'S ORACLE. `allowedNumbers()` derives the number whitelist from
 * this same object, so anything added here widens what the model is allowed to assert. Two
 * consequences worth stating before someone "helpfully" enriches this function:
 *
 *   - Do NOT add the endpoint's PLACEMENT_NOTE or any other caveat prose. It contains the words
 *     "merchant" and "buy", which would put the reachability vocabulary inside the evidence and
 *     silently defeat that guard. Caveats belong beside the insight in the UI, not inside the
 *     model's context.
 *   - Do NOT pad with extra statistics "for context". Every additional number is one more value
 *     the whitelist will wave through.
 */
export function buildPrompt(evidence: InsightEvidence): string {
  return `Here is everything known about this gate.

${JSON.stringify(evidence, null, 2)}

Answer the one question: does the game's own text point a player toward a remedy for this gate?`;
}
