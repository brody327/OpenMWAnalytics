// The structural guard on generated insights (design docs 12, Phase 4c).
//
// ⭐ WHY THIS FILE EXISTS, AND WHY IT WAS WRITTEN BEFORE THE PROMPT
//
// Every other failure this project has hit had a tell. A fixture overwrote real corpus rows and
// the contradiction surfaced in-game; a stale pod served old code and a new route 404'd; an
// inverted boolean made every exterior area match `%region%`. In each case SOME observation was
// structurally impossible in the broken world, so a check could exist.
//
// A fabricated LLM claim has NO tell. "Most apothecaries stock them" renders in the same font, the
// same register and the same confident tone as a computed fact, and it is very likely true of the
// real game -- it is simply not something OUR DATA SAYS. Human review cannot catch that reliably,
// because a reviewer reading a plausible sentence has no signal to react to.
//
// So the guard cannot be "read it carefully". It has to be mechanical, and it has to run BEFORE a
// human ever sees the text -- a rejected insight is never rendered, never stored as approved, and
// never gets the chance to look right.
//
// ⚠️ WHAT THESE GUARDS DO **NOT** DO -- stated up front so nobody mistakes them for a proof.
// They bound the model to the VOCABULARY AND NUMBERS OF THE EVIDENCE. They cannot check that a
// sentence is a correct INFERENCE from that evidence. A model that says "this gate is trivially
// easy" about a gate the evidence shows is brutal uses only whitelisted numbers and cited records
// and passes every check here. These guards close the fabrication hole, not the reasoning hole.
// The reasoning hole is what the human review step (12 §4) is actually for -- and a reviewer CAN
// catch a bad inference, because the evidence sits next to the claim.

/** One remedy the query found for this gate -- a record that can close it, with its magnitudes. */
export interface EvidenceRemedy {
  record_id: string;
  name: string;
  /** ALCH / INGR / SPEL / ENCH. */
  type: string;
  magnitude_min: number | null;
  magnitude_max: number | null;
}

/** One retrieved passage of the game's own prose -- dialogue, a book, an item description. */
export interface EvidencePassage {
  record_id: string;
  name: string;
  text: string;
}

/**
 * EVERYTHING the model is allowed to know, exactly as the queries returned it.
 *
 * This object is both the prompt input AND the validation oracle -- the same structure decides
 * what the model may read and what it may say. Keeping those two the same object is deliberate:
 * if they were built separately they could drift, and a drifted oracle would approve claims about
 * facts the model was never given (or reject claims about facts it was).
 */
export interface InsightEvidence {
  check_id: string;
  stat: string;
  /** 'skill' or 'attribute'. Part of the gate's identity, not decoration -- see generate.ts. */
  stat_kind: string;
  threshold: number;
  gap_p90: number;
  fails: number;
  reliable: number;
  possible: number;
  verdict: string;
  remedies: EvidenceRemedy[];
  passages: EvidencePassage[];
}

/** Does the game's own text point a player at a remedy for this gate? */
export type Signposting =
  /** at least one retrieved passage genuinely directs a player toward a gap-closing remedy */
  | 'SIGNPOSTED'
  /** the passages mention the remedies but never connect them to this gate */
  | 'NOT_SIGNPOSTED'
  /** the retrieved prose is not enough to tell -- the honest answer, and it must stay available */
  | 'UNCLEAR';

/** The model's output. Note what is ABSENT: nothing about obtainability. See REACHABILITY_TERMS. */
export interface GeneratedInsight {
  headline: string;
  signposting: Signposting;
  rationale: string;
  recommendation: string;
  /** record_ids the rationale relies on. Every one is checked against the evidence. */
  citations: string[];
}

export interface Violation {
  rule: 'unknown_number' | 'uncited_record' | 'reachability_claim' | 'empty_field';
  detail: string;
}

export type ValidationResult =
  | { ok: true; insight: GeneratedInsight }
  | { ok: false; violations: Violation[] };

/**
 * Words that only ever appear in an OBTAINABILITY claim.
 *
 * ⭐ This is a blocklist, and blocklists are usually weak -- but this one has the property that
 * makes a check worth having: **none of these words can reach the model from the evidence.** The
 * payload is gate numbers, record names, magnitudes and game prose. If "apothecary" appears in the
 * output, the model supplied it, because there was nowhere to copy it from.
 *
 * ⚠️ LOAD-BEARING CONSEQUENCE, easy to undo by accident: the endpoint's PLACEMENT_NOTE contains
 * the words "merchant" and "buy". It must therefore NEVER be included in the evidence payload --
 * doing so would put the vocabulary in reach and silently defeat this rule. The note is rendered
 * in the UI beside the insight instead, which is where a caveat belongs anyway.
 *
 * A determined model could of course express obtainability without these words. That is the same
 * limitation the header states: this bounds vocabulary, not reasoning. It closes the specific
 * fabrication the 07-28 assessment identified BY NAME -- "yes, most apothecaries stock them" --
 * which is the one we have evidence a model actually produces.
 */
const REACHABILITY_TERMS = [
  'merchant', 'vendor', 'apothecary', 'apothecaries', 'trader', 'shop', 'store',
  'buy', 'bought', 'purchase', 'sell', 'sold', 'stock', 'stocks', 'stocked',
  'obtain', 'obtainable', 'acquire', 'find one', 'easy to get', 'readily available',
];

const NUMBER_RE = /\d+(?:\.\d+)?/g;

/** Every distinct number appearing anywhere in the evidence, as written. */
function numbersIn(text: string): Set<string> {
  return new Set(text.match(NUMBER_RE) ?? []);
}

/**
 * Build the set of numbers the model is permitted to write.
 *
 * Derived from the SERIALISED evidence rather than from named fields on purpose: a number inside a
 * record id (`potion_skooma_01`), an item name (`Potion of Strength 20`) or a passage of dialogue
 * is a number the model legitimately saw, and rejecting it would produce false violations on
 * correct insights. False rejections are not free -- a guard that fires on good output gets
 * switched off, and then it protects nothing.
 */
export function allowedNumbers(evidence: InsightEvidence): Set<string> {
  return numbersIn(JSON.stringify(evidence));
}

/**
 * Validate a generated insight against the evidence it was given.
 *
 * Pure and DB-free, like `rankTopics` and `classifyGate`, for the same reason: the JUDGEMENT is
 * the part worth testing, and it must be exercisable with no network and no model.
 */
export function validateInsight(
  insight: GeneratedInsight,
  evidence: InsightEvidence,
): ValidationResult {
  const violations: Violation[] = [];
  const prose = [insight.headline, insight.rationale, insight.recommendation];

  // ── Guard 0: nothing may be empty ────────────────────────────────────────────────────────────
  // An insight with a blank rationale is not a cheap insight, it is an unsupported claim: the
  // headline still asserts something and the evidence for it is gone.
  for (const [i, field] of prose.entries()) {
    if (field.trim() === '') {
      violations.push({
        rule: 'empty_field',
        detail: `${['headline', 'rationale', 'recommendation'][i]} is empty`,
      });
    }
  }

  // ── Guard 1: the number whitelist ────────────────────────────────────────────────────────────
  // A hallucinated magnitude is a number, and a number the evidence never contained cannot have
  // been read -- it was invented. This is the one guard a fabricated remedy cannot walk past
  // silently: "+15 Personality" contains 15, and if 15 is nowhere in the payload it is rejected.
  //
  // ⚠️ It is WEAKEST on small integers. 1, 2 and 3 are almost always somewhere in the evidence, so
  // a fabricated "3 potions" can pass. Documented rather than papered over -- the guard is aimed
  // at invented MAGNITUDES and COUNTS, which are the claims that change an author's decision.
  const allowed = allowedNumbers(evidence);
  for (const field of prose) {
    for (const n of field.match(NUMBER_RE) ?? []) {
      if (!allowed.has(n)) {
        violations.push({
          rule: 'unknown_number',
          detail: `'${n}' appears in the insight but nowhere in the evidence`,
        });
      }
    }
  }

  // ── Guard 2: citation membership ─────────────────────────────────────────────────────────────
  // Every cited record must be one we supplied. An invented record id fails a set-membership test
  // -- there is no way to be plausibly wrong here, which is exactly the property we want.
  //
  // ⚠️ lower() on BOTH sides, for the reason documented at every other join in this project: the
  // corpus stores mixed-case ids (`ingred_Dae_cursed_emerald_01`) and everything else reports them
  // lowercase. A case-sensitive comparison would reject a CORRECT citation -- a false violation,
  // which is the failure mode that gets a guard disabled.
  const supplied = new Set(
    [...evidence.remedies, ...evidence.passages].map((r) => r.record_id.toLowerCase()),
  );
  for (const cited of insight.citations) {
    if (!supplied.has(cited.toLowerCase())) {
      violations.push({
        rule: 'uncited_record',
        detail: `cites '${cited}', which was not in the evidence`,
      });
    }
  }

  // ── Guard 3: no reachability claims ──────────────────────────────────────────────────────────
  // The one claim that would be most convincing and least supportable. `reachable` is passed
  // through from the query and RENDERED, never generated -- so the model is not merely discouraged
  // from answering it, it is never asked. This catches it volunteering one anyway.
  const haystack = prose.join(' ').toLowerCase();
  for (const term of REACHABILITY_TERMS) {
    if (haystack.includes(term)) {
      violations.push({
        rule: 'reachability_claim',
        detail: `uses '${term}' -- obtainability is not something our data can establish`,
      });
    }
  }

  return violations.length === 0 ? { ok: true, insight } : { ok: false, violations };
}
