/**
 * The declared schema for model output and editor-edited drafts.
 *
 * Check 3: `llmDraftSchema` is a discriminated union on `outcome` — a complete
 * settleable market and an explicit unresolvable result are distinct outcomes,
 * and the unresolvable branch carries a reason.
 *
 * Check 1: every model response is validated against this schema before any
 * field is read, stored, or displayed.
 */
import { z } from 'zod';

export const MAX_HEADLINE_LENGTH = 400;
export const MAX_SNIPPET_LENGTH = 2_000;

const nonEmpty = (label: string, min = 1) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(min, `${label} must be at least ${min} characters`);

/** A complete, settleable market draft. */
export const marketDraftSchema = z.object({
  outcome: z.literal('market'),
  question: nonEmpty('question', 10).refine(
    (q) => q.endsWith('?'),
    'question must be phrased as a question ending with "?"',
  ),
  /** ISO 8601 date-time. Validated semantically against the current time in code. */
  closeTime: nonEmpty('closeTime'),
  /** A named organisation/publication that will authoritatively decide the outcome. */
  resolutionSource: nonEmpty('resolutionSource', 3),
  yesCriteria: nonEmpty('YES criteria', 10),
  noCriteria: nonEmpty('NO criteria', 10),
  edgeCases: z
    .array(nonEmpty('edge-case rule'))
    .min(1, 'at least one edge-case resolution rule is required'),
});

/** Explicit unresolvable outcome — this headline cannot fairly become a market. */
export const unresolvableDraftSchema = z.object({
  outcome: z.literal('unresolvable'),
  reason: nonEmpty('reason', 20),
});

/** The model must answer as exactly one of the two outcomes. */
export const llmDraftSchema = z.discriminatedUnion('outcome', [
  marketDraftSchema,
  unresolvableDraftSchema,
]);

export type MarketDraft = z.infer<typeof marketDraftSchema>;
export type UnresolvableDraft = z.infer<typeof unresolvableDraftSchema>;
export type LlmDraft = z.infer<typeof llmDraftSchema>;

/** Maximum acceptable close time: 5 years out. */
export const MAX_CLOSE_TIME_MS = 1000 * 60 * 60 * 24 * 365 * 5;

export interface SemanticIssue {
  field: string;
  message: string;
}

const VAGUE_SOURCE =
  /^(unknown|tbd|n\/?a|some(one|body|source)|the (internet|news|media|web)|any(source| official)|to be decided|\?+)$/i;

/**
 * Semantic validation — meaning, not just shape. Runs in code (not only in the
 * prompt) on every market draft, whether it came from the model or the editor.
 *
 * Check 2: close time is compared with the current time here; a draft whose
 * close time is not in the future is rejected.
 */
export function validateMarketSemantics(
  market: MarketDraft,
  now: Date = new Date(),
): SemanticIssue[] {
  const issues: SemanticIssue[] = [];

  const closeMs = Date.parse(market.closeTime);
  if (!Number.isFinite(closeMs)) {
    issues.push({
      field: 'closeTime',
      message: `close time must be a valid ISO 8601 date-time (got "${market.closeTime}")`,
    });
  } else {
    if (closeMs <= now.getTime()) {
      issues.push({
        field: 'closeTime',
        message:
          `close time must be in the future — got ${new Date(closeMs).toISOString()}, ` +
          `current time is ${now.toISOString()}`,
      });
    } else if (closeMs - now.getTime() > MAX_CLOSE_TIME_MS) {
      issues.push({
        field: 'closeTime',
        message: 'close time is more than 5 years away — pick a nearer, concrete deadline',
      });
    }
  }

  const source = market.resolutionSource.trim();
  if (VAGUE_SOURCE.test(source)) {
    issues.push({
      field: 'resolutionSource',
      message:
        'resolution source must name a specific organisation or publication that will decide the outcome',
    });
  }

  return issues;
}

/** Input validation for the editor-submitted headline/snippet (untrusted data). */
export function validateHeadlineInput(
  headline: string | undefined,
  snippet: string | undefined,
): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const h = (headline ?? '').trim();
  if (h.length === 0) {
    issues.push({ field: 'headline', message: 'headline is required' });
  } else if (h.length > MAX_HEADLINE_LENGTH) {
    issues.push({
      field: 'headline',
      message: `headline must be at most ${MAX_HEADLINE_LENGTH} characters`,
    });
  }
  const s = (snippet ?? '').trim();
  if (s.length > MAX_SNIPPET_LENGTH) {
    issues.push({
      field: 'snippet',
      message: `snippet must be at most ${MAX_SNIPPET_LENGTH} characters`,
    });
  }
  return issues;
}
