// Insight generation providers (design docs 12, Phase 4c).
//
// Deliberately the same shape as corpus/embeddings.ts: an interface, a real provider, and a
// deterministic fake. The reasons carry over exactly.
//
//  - The MODEL IDENTITY is data, not a detail hidden inside a client. An insight is stored with
//    the model that produced it, because "the model changed" is the single likeliest explanation
//    for a batch of insights suddenly reading differently, and a stored insight whose provenance
//    is unknown cannot be re-reviewed on that basis.
//  - The fake makes the whole pipeline testable with NO NETWORK AND NO SPEND, which matters more
//    here than it did for embeddings: this path is only reached after two SQL queries and a vector
//    search, and paying a model call to test the plumbing around it would make the tests something
//    nobody runs.
//
// ⚠️ The fake produces a FIXED, VALID insight. It exercises plumbing, storage and the validator's
// happy path; it says nothing about generation QUALITY, and a test that used it to claim the model
// writes good insights would be exactly the kind of check this project keeps deleting.

import Anthropic from '@anthropic-ai/sdk';
import type { GeneratedInsight, InsightEvidence, Signposting } from './validate.js';
import { buildPrompt, INSIGHT_JSON_SCHEMA, SYSTEM_PROMPT } from './prompt.js';

/**
 * What a generation attempt produced.
 *
 * `refused` is a first-class outcome rather than a thrown error because it is not a failure of
 * ours: the model's safety classifiers declined, the request was well-formed, and the right
 * response is to record that and move on -- not to retry a doomed call or crash a batch.
 */
export type GenerationOutcome =
  | { type: 'generated'; insight: GeneratedInsight; model: string }
  | { type: 'refused'; model: string; category: string | null }
  /** The model returned something that is not a valid insight object at all. */
  | { type: 'malformed'; model: string; detail: string };

export interface InsightProvider {
  /** Stored on every insight row. Provenance, for the reason in the header. */
  readonly model: string;
  generate(evidence: InsightEvidence): Promise<GenerationOutcome>;
}

// ---------------------------------------------------------------------------------------------

/**
 * Parse and shape-check the model's JSON.
 *
 * Structured outputs (`output_config.format`) already constrain generation to the schema, so this
 * is belt-and-braces -- but the belt is worth having: it is the boundary between "the API said it
 * conformed" and "our types are true", and this project has now been bitten twice by trusting a
 * stage's own report instead of checking what crossed the boundary out of it.
 */
function parseInsight(raw: string): GeneratedInsight | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: `response was not JSON: ${raw.slice(0, 200)}` };
  }
  if (typeof json !== 'object' || json === null) return { error: 'response was not an object' };

  const o = json as Record<string, unknown>;
  const strings = ['headline', 'rationale', 'recommendation'] as const;
  for (const k of strings) {
    if (typeof o[k] !== 'string') return { error: `field '${k}' is not a string` };
  }
  const signposting = o.signposting;
  if (signposting !== 'SIGNPOSTED' && signposting !== 'NOT_SIGNPOSTED' && signposting !== 'UNCLEAR') {
    return { error: `signposting '${String(signposting)}' is not one of the three values` };
  }
  if (!Array.isArray(o.citations) || o.citations.some((c) => typeof c !== 'string')) {
    return { error: 'citations is not an array of strings' };
  }

  return {
    headline: o.headline as string,
    signposting: signposting as Signposting,
    rationale: o.rationale as string,
    recommendation: o.recommendation as string,
    citations: o.citations as string[],
  };
}

export interface ClaudeInsightOptions {
  apiKey: string;
  model?: string;
  /**
   * Thinking is ON by default on Claude Opus 5, and `max_tokens` caps thinking AND response text
   * together. An insight is a few hundred tokens of prose, so this ceiling is almost entirely
   * headroom for reasoning -- sizing it to the visible output would truncate the answer mid-
   * sentence and look like a model problem rather than a configuration one.
   */
  maxTokens?: number;
}

/**
 * The real provider: one bounded call per gate. No agent loop, no tools, no retrieval decisions
 * left to the model -- the evidence is assembled by SQL and vector search BEFORE the call, and the
 * model's entire job is the judgement that cannot be expressed as a query.
 */
export class ClaudeInsightProvider implements InsightProvider {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;

  constructor(opts: ClaudeInsightOptions) {
    if (!opts.apiKey) throw new Error('ClaudeInsightProvider: apiKey is required');
    this.model = opts.model ?? 'claude-opus-5';
    this.maxTokens = opts.maxTokens ?? 8000;
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }

  async generate(evidence: InsightEvidence): Promise<GenerationOutcome> {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(evidence) }],
      // Constrain the shape at the source rather than parsing prose. The three-value
      // `signposting` enum is the important part: without it the model reaches for a fourth,
      // softer answer, and UNCLEAR stops being the honest option and becomes the only one.
      output_config: { format: { type: 'json_schema', schema: INSIGHT_JSON_SCHEMA } },
      // If the safety classifiers decline, Anthropic re-runs the request on a recommended
      // fallback model server-side instead of handing us a refusal. 'default' routes by refusal
      // category rather than pinning a model we would then have to maintain.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });

    // ⚠️ Check stop_reason BEFORE reading content. On a refusal `content` is empty or partial, and
    // indexing [0] would throw on a perfectly successful HTTP 200.
    if (res.stop_reason === 'refusal') {
      return { type: 'refused', model: res.model, category: res.stop_details?.category ?? null };
    }

    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text.trim() === '') {
      return { type: 'malformed', model: res.model, detail: 'no text block in the response' };
    }

    const parsed = parseInsight(text);
    if ('error' in parsed) return { type: 'malformed', model: res.model, detail: parsed.error };
    return { type: 'generated', insight: parsed, model: res.model };
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Offline provider. No network, no key, no spend.
 *
 * It answers from the evidence it is given -- citing the first real remedy and reporting UNCLEAR
 * -- so its output PASSES the validator honestly rather than by being blank. A fake that returned
 * an empty insight, or one citing a made-up record, would make every downstream test assert the
 * rejection path and quietly leave the success path unexercised.
 */
export class FakeInsightProvider implements InsightProvider {
  readonly model = 'fake-deterministic';
  calls = 0;
  seen: InsightEvidence[] = [];

  constructor(private readonly override: Partial<GeneratedInsight> = {}) {}

  async generate(evidence: InsightEvidence): Promise<GenerationOutcome> {
    this.calls += 1;
    this.seen.push(evidence);
    const cite = evidence.remedies[0]?.record_id ?? evidence.passages[0]?.record_id;
    return {
      type: 'generated',
      model: this.model,
      insight: {
        headline: `Offline placeholder for ${evidence.check_id}`,
        signposting: 'UNCLEAR',
        rationale: 'Generated without a model; no judgement was made about the retrieved prose.',
        recommendation: 'Run against a real provider before drawing any conclusion.',
        citations: cite ? [cite] : [],
        ...this.override,
      },
    };
  }
}

/**
 * Pick a provider from the environment.
 *
 * ⚠️ FAILS CLOSED, unlike the search path. `GET /search` degrades to lexical-only without a key
 * because half a search still answers the user's question. There is no honest half of an insight:
 * a placeholder rendered as a finding is worse than an empty panel, so a missing key means the
 * generation endpoint reports that it is unavailable rather than quietly serving the fake.
 */
export function providerFromEnv(): InsightProvider | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new ClaudeInsightProvider({
    apiKey,
    model: process.env.OMWA_INSIGHT_MODEL ?? 'claude-opus-5',
  });
}
