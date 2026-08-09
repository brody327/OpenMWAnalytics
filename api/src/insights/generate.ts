// Phase 4c orchestration: evidence -> model -> validator -> storage (design docs 12).
//
// The shape of this file is the argument for the whole phase. Read the pipeline and notice how
// little the model does:
//
//   queryGates()      SQL          which gate, how big the shortfall, how many failures
//   queryRemedies()   SQL          which records can actually close it, and by how much
//   searchCorpus()    hybrid       what the game's own text says near this subject
//   provider.generate() MODEL      ONE judgement: does that text point a player at a remedy?
//   validateInsight()  pure        may it be published at all
//   insert            SQL          stored as `pending` -- a human decides if it ships
//
// Four of the six steps are queries. That is not an accident of implementation, it is the answer
// to "why not just a heuristic": everything a query can answer IS answered by a query, and the
// model is left with the one question that is a judgement about prose rather than a number.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { insights } from '../db/schema.js';
import { queryGates, type GateGap } from '../stats/sufficiency.js';
import { searchCorpus } from '../search/search.js';
import type { InsightProvider } from './provider.js';
import {
  validateInsight,
  type EvidencePassage,
  type EvidenceRemedy,
  type InsightEvidence,
  type Violation,
} from './validate.js';

/**
 * Bump this whenever the prompt text, the JSON schema, or the SHAPE of the evidence changes.
 *
 * Stored on every row so derived-artefact drift is a query (`where prompt_version < N`) instead of
 * an archaeology exercise. Prod served corpus chunks built by a deleted `chunk.ts` for a day
 * because nothing recorded which version produced them (11 §14); this is that lesson costing one
 * integer.
 */
export const PROMPT_VERSION = 1;

/** How many retrieved passages the model sees. */
const PASSAGE_LIMIT = 8;
/** How many named remedies the model sees, largest magnitude first. */
const REMEDY_LIMIT = 6;

/**
 * How many hits to retrieve before filtering down to PASSAGE_LIMIT narrative ones.
 *
 * Over-fetch is required, not defensive: the unfiltered top-10 for a Fortify query is dominated by
 * SPEL and ENCH records, so filtering a 10-hit page to narrative types routinely leaves zero.
 */
const CANDIDATE_PASSAGES = 40;

/**
 * ⭐ ONLY PROSE A PLAYER CAN ACTUALLY READ.
 *
 * Found by running the pipeline, not by a test. The first real evidence payload for
 * `ccff_j_mortar:force` came back with eight "passages" that were all Fortify Security effect
 * definitions -- including the remedy's own record. The prompt would then have asked whether the
 * item's own description signposts the item, which is a question with no useful answer, and the
 * model would have dutifully produced one.
 *
 * ⚠️ Nothing about that was broken. `searchCorpus` returned genuinely relevant hits, the payload
 * validated, every test stayed green, and the JSON looked exactly like working evidence. The
 * failure was in what "passage" MEANT -- the same shape as `type='SPEL'` standing in for "a spell
 * a player can cast": a query that computes what it was told over rows that do not mean what it
 * assumed.
 *
 * INFO is dialogue (32,088 records) and BOOK is in-world text (881). Those are the two surfaces a
 * mod author can actually edit to signpost something, which makes them the only ones on which the
 * question "does the text point a player here?" is answerable at all.
 */
const NARRATIVE_TYPES = new Set(['INFO', 'BOOK']);

/**
 * What identifies ONE gate.
 *
 * ⭐ All four fields, because `check_id` is not a key. Measured 2026-08-09: `ccff_j_mortar:force`
 * resolves to sixteen gates spanning security@25 through security@100, alchemy, shortblade, luck
 * and personality -- with verdicts ranging from `no_remedy` to `remedy_exists`. A caller that
 * names only the check has not named a gate, and the honest response is to require the rest
 * rather than to pick one.
 *
 * `stat_kind` earns its place because skill and attribute names collide across the two enums, the
 * same reason `/stats/sufficiency` joins on it.
 */
export interface GateKey {
  check_id: string;
  stat: string;
  stat_kind: string;
  threshold: number;
}

/**
 * Find the ONE gate a key names.
 *
 * Pure and exported so the grain rule is testable without a populated event log -- the bug it
 * fixes (matching on `check_id` and taking the first hit) was invisible in every DB-free test and
 * would have stayed invisible, because the wrong answer is a real gate with real numbers.
 */
export function matchGate(gates: GateGap[], key: GateKey): GateGap | undefined {
  return gates.find(
    (g) =>
      g.check_id === key.check_id &&
      g.stat === key.stat &&
      g.stat_kind === key.stat_kind &&
      g.threshold === key.threshold,
  );
}

export type GenerationResult =
  | { status: 'stored'; id: string; signposting: string }
  | { status: 'rejected'; violations: Violation[] }
  | { status: 'refused'; category: string | null }
  | { status: 'malformed'; detail: string }
  | ({ status: 'no_gate' } & GateKey)
  | { status: 'no_evidence'; detail: string };

/**
 * The NAMED remedies for a gate.
 *
 * `/stats/sufficiency` reports counts, which is right for a table of many gates and useless here:
 * you cannot ask whether the text signposts "1 reliable remedy". The filters are copied from that
 * endpoint deliberately -- `fortify%`, the SPEL-scoped `duration <> 0` exclusion -- because a
 * remedy the dashboard has already excluded must not reappear as evidence. `Gaenor's Abilities`
 * (+500 Luck on a scripted NPC) reaching a prompt would be the shipped-to-prod bug of 07-28
 * getting a second, more articulate life.
 */
export async function queryRemedies(
  stat: string,
  statKind: string,
  gap: number,
): Promise<EvidenceRemedy[]> {
  const rows = await db.execute(sql`
    select r.record_id, coalesce(r.name, r.record_id) as name, r.type,
           e.magnitude_min, e.magnitude_max
    from record_effects e
    join game_records r on r.record_id = e.record_id
    where e.effect_name ilike 'fortify%'
      and e.affected = ${stat}
      and e.affected_kind = ${statKind}
      and e.magnitude_max >= ${gap}
      and not (r.type = 'SPEL' and e.duration = 0)
    order by e.magnitude_max desc, r.record_id
    limit ${REMEDY_LIMIT}
  `);
  return rows.rows as unknown as EvidenceRemedy[];
}

/**
 * Retrieve the game's own prose about this gate.
 *
 * ⭐ THE SECOND REAL USE OF THE HNSW INDEX, and the one that justifies having built it. The query
 * is the remedy names plus the stat, because the question is whether the text CONNECTS them: a
 * purely lexical search for `personality` finds every record containing the word, while the
 * semantic half finds dialogue that talks around it ("she never takes that ring off") without ever
 * naming the stat -- which is precisely what signposting looks like in a game that does not write
 * UI copy.
 */
async function retrievePassages(
  stat: string,
  remedies: EvidenceRemedy[],
): Promise<EvidencePassage[]> {
  const remedyIds = new Set(remedies.map((r) => r.record_id.toLowerCase()));
  const keep = (h: { type: string; record_id: string }) =>
    NARRATIVE_TYPES.has(h.type) && !remedyIds.has(h.record_id.toLowerCase());

  // ⭐ TWO PASSES, AND THE SECOND CANNOT BE DROPPED WITHOUT CHANGING THE QUESTION.
  //
  // Pass 1 asks what the game says about this STAT — the advice, training and lore a stuck player
  // would plausibly run into. Pass 2 asks whether any dialogue names the REMEDY itself.
  //
  // Only pass 2 can produce a SIGNPOSTED verdict, because signposting means the text points at a
  // specific thing. Only pass 1 can produce a fair NOT_SIGNPOSTED, because without the surrounding
  // context "no passage names the ring" is indistinguishable from "we searched for the wrong
  // thing". Running either alone biases the verdict in a direction that looks like a finding.
  const [situational, byName] = await Promise.all([
    searchCorpus(situationQuery(stat), CANDIDATE_PASSAGES),
    remedies.length > 0
      ? searchCorpus(remedies.map((r) => r.name).join(' '), CANDIDATE_PASSAGES)
      : Promise.resolve({ results: [] as Awaited<ReturnType<typeof searchCorpus>>['results'] }),
  ]);

  // Interleave rather than concatenate: taking pass 1 first and truncating at 8 would drop pass 2
  // entirely on any stat with plentiful dialogue, silently restoring the single-pass bias above.
  const merged: EvidencePassage[] = [];
  const seen = new Set<string>();
  const a = byName.results.filter(keep);
  const b = situational.results.filter(keep);
  for (let i = 0; merged.length < PASSAGE_LIMIT && (i < a.length || i < b.length); i++) {
    for (const h of [a[i], b[i]]) {
      if (!h || seen.has(h.record_id) || merged.length >= PASSAGE_LIMIT) continue;
      seen.add(h.record_id);
      merged.push({ record_id: h.record_id, name: h.name ?? h.record_id, text: h.snippet });
    }
  }
  return merged;
}

/**
 * The situational query.
 *
 * Phrased as a player's problem rather than as keywords, because the semantic half is what earns
 * its keep here: dialogue about picking locks does not contain the word "security", and a lexical
 * query for the stat name returns the stat's own definition record. This is the `"guards demanding
 * bribes"` vs `"the watch wanted coin"` case from 11 §9 — 5x similarity with zero shared words —
 * pointed at a real question instead of a smoke test.
 */
function situationQuery(stat: string): string {
  return `how can I improve my ${stat}, or get help passing a difficult ${stat} check`;
}

/**
 * Assemble everything the model is allowed to know.
 *
 * ⚠️ Whatever this returns becomes BOTH the prompt and the validator's oracle (see prompt.ts).
 * Adding a field here widens what the model may assert, so additions are a guardrail change, not
 * a formatting change.
 */
export async function buildEvidence(
  key: GateKey,
): Promise<InsightEvidence | { error: GenerationResult }> {
  // ⚠️ ALL FOUR FIELDS. An earlier version matched on `check_id` alone and took the first hit,
  // which was wrong in the quietest possible way: `ccff_j_mortar:force` is SIXTEEN gates, so it
  // silently answered about whichever stat had the most failures and discarded the other fifteen.
  // The insight was internally consistent, cited real records, passed every guard -- and was about
  // a different gate than the one asked for.
  const gate = matchGate(await queryGates(), key);
  if (!gate) return { error: { status: 'no_gate', ...key } };

  const remedies = await queryRemedies(gate.stat, gate.stat_kind, gate.gap_p90);
  const passages = await retrievePassages(gate.stat, remedies);

  // Refuse rather than generate on an empty corpus. With no passages the only honest verdict is
  // UNCLEAR, and paying a model call to be told "there was nothing to read" produces a row that
  // looks like a finding about the mod when it is a fact about our retrieval. The endpoint says so
  // instead -- absence reported as absence, the same rule `reachable: UNKNOWN` follows.
  if (passages.length === 0) {
    return {
      error: {
        status: 'no_evidence',
        detail: 'no corpus passages retrieved for this gate -- nothing to judge',
      },
    };
  }

  return {
    check_id: gate.check_id,
    stat: gate.stat,
    stat_kind: gate.stat_kind,
    threshold: gate.threshold,
    gap_p90: gate.gap_p90,
    fails: gate.fails,
    reliable: gate.reliable,
    possible: gate.possible,
    verdict: gate.possible === 0 ? 'no_remedy' : gate.reliable === 0 ? 'gamble_only' : 'remedy_exists',
    remedies,
    passages,
  };
}

/**
 * Generate one insight for one gate.
 *
 * ⭐ A REJECTED INSIGHT IS NEVER STORED. Not stored-as-rejected, not stored-for-audit -- the row
 * does not exist. The reasoning: an insight in the table is a thing a reviewer can approve, and a
 * fabricated claim sitting one UI click away from `approved` is the failure mode this phase was
 * designed around. The violations go back to the caller and into the logs, where they inform the
 * prompt rather than the product.
 */
export async function generateInsight(
  key: GateKey,
  provider: InsightProvider,
): Promise<GenerationResult> {
  const built = await buildEvidence(key);
  if ('error' in built) return built.error;
  return generateFromEvidence(built, provider);
}

/**
 * The half that takes evidence and decides whether a row exists: model -> validate -> store.
 *
 * Split from evidence ASSEMBLY so it can be tested against a hand-written evidence object. The
 * assembly half needs a populated corpus and a vector index; this half needs neither, and it is
 * the half that holds the rule worth pinning -- that a rejected insight leaves no row behind. A
 * test that had to ingest 36,000 chunks before it could assert that is a test nobody runs.
 */
export async function generateFromEvidence(
  evidence: InsightEvidence,
  provider: InsightProvider,
): Promise<GenerationResult> {
  const outcome = await provider.generate(evidence);
  if (outcome.type === 'refused') return { status: 'refused', category: outcome.category };
  if (outcome.type === 'malformed') return { status: 'malformed', detail: outcome.detail };

  const checked = validateInsight(outcome.insight, evidence);
  if (!checked.ok) {
    console.warn(
      `[insights] REJECTED insight for ${evidence.check_id}:`,
      checked.violations.map((v) => `${v.rule}: ${v.detail}`).join('; '),
    );
    return { status: 'rejected', violations: checked.violations };
  }

  const i = checked.insight;
  const [row] = await db
    .insert(insights)
    .values({
      checkId: evidence.check_id,
      stat: evidence.stat,
      statKind: evidence.stat_kind,
      threshold: evidence.threshold,
      headline: i.headline,
      signposting: i.signposting,
      rationale: i.rationale,
      recommendation: i.recommendation,
      citations: i.citations,
      model: outcome.model,
      promptVersion: PROMPT_VERSION,
      evidence,
      // Explicit rather than relying on the column default: `pending` is the product decision that
      // makes bullet 5's "human review" true, and a default is easy to change without noticing.
      status: 'pending',
    })
    .returning({ id: insights.id });

  return { status: 'stored', id: row.id, signposting: i.signposting };
}
