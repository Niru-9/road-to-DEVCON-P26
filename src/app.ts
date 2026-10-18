/**
 * Application layer — the route handlers, kept free of HTTP plumbing so the
 * approval/generation/edit behaviour is directly testable.
 *
 * Every method returns a `{ ok, ... }` envelope; failures are states, not
 * exceptions (check 7: no uncaught validation failure ever becomes a 500).
 */
import type { LlmClient } from './llm.ts';
import { generateDraft, type GenerationError } from './generate.ts';
import type { DraftRecord, DraftStore, MarketPatch } from './db.ts';
import { marketDraftSchema, validateHeadlineInput, validateMarketSemantics } from './schema.ts';

export type Envelope<T> = { ok: true } & T | { ok: false; error: GenerationError };

export type GenerateEnvelope = Envelope<{ draft: DraftRecord }>;
export type EditEnvelope = Envelope<{ draft: DraftRecord }>;
export type ActionEnvelope = Envelope<{ draft: DraftRecord }>;
export type ListEnvelope = Envelope<{ drafts: DraftRecord[] }>;

export interface GenerateInput {
  headline?: string;
  snippet?: string;
}

export class App {
  private readonly store: DraftStore;
  private readonly llm: LlmClient;
  constructor(store: DraftStore, llm: LlmClient) {
    this.store = store;
    this.llm = llm;
  }

  /**
   * Generate a draft from a headline. On success an UNPUBLISHED 'pending'
   * draft is stored (check 8). On any failure a structured error envelope is
   * returned for the editor UI to render (check 7).
   */
  async generate(input: GenerateInput, now: Date = new Date()): Promise<GenerateEnvelope> {
    const inputIssues = validateHeadlineInput(input.headline, input.snippet);
    if (inputIssues.length > 0) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          message: 'The headline could not be accepted.',
          details: inputIssues.map((i) => `${i.field}: ${i.message}`),
        },
      };
    }

    const result = await generateDraft(this.llm, {
      headline: (input.headline ?? '').trim(),
      ...(input.snippet?.trim() ? { snippet: input.snippet.trim() } : {}),
    }, now);

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    // Only a validated draft is stored, and only as 'pending'.
    const draft = this.store.createPending({
      headline: (input.headline ?? '').trim(),
      ...(input.snippet?.trim() ? { snippet: input.snippet.trim() } : {}),
      payload: result.draft,
    });
    return { ok: true, draft };
  }

  list(): ListEnvelope {
    return { ok: true, drafts: this.store.list() };
  }

  /**
   * Manual-drafting path (check 7 fallback): the editor writes the market
   * themselves. It passes the same schema + semantic validation and is stored
   * as 'pending' — still not live until explicitly approved.
   */
  createManual(input: { headline?: string; patch: MarketPatch }, now: Date = new Date()): EditEnvelope {
    const inputIssues = validateHeadlineInput(input.headline, undefined);
    if (inputIssues.length > 0) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          message: 'The manual draft could not be accepted.',
          details: inputIssues.map((i) => `${i.field}: ${i.message}`),
        },
      };
    }
    const candidate = {
      outcome: 'market' as const,
      question: input.patch.question ?? '',
      closeTime: input.patch.closeTime ?? '',
      resolutionSource: input.patch.resolutionSource ?? '',
      yesCriteria: input.patch.yesCriteria ?? '',
      noCriteria: input.patch.noCriteria ?? '',
      edgeCases: input.patch.edgeCases ?? [],
    };
    const schemaCheck = marketDraftSchema.safeParse(candidate);
    if (!schemaCheck.success) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          message: 'The manual draft is incomplete and was not saved.',
          details: schemaCheck.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        },
      };
    }
    const issues = validateMarketSemantics(schemaCheck.data, now);
    if (issues.length > 0) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          message: 'The manual draft failed validation and was not saved.',
          details: issues.map((i) => `${i.field}: ${i.message}`),
        },
      };
    }
    const draft = this.store.createPending({
      headline: (input.headline ?? '').trim(),
      payload: schemaCheck.data,
    });
    return { ok: true, draft };
  }

  /** Edit a pending market draft. Close time re-validated against current time. */
  edit(id: string, patch: MarketPatch, now: Date = new Date()): EditEnvelope {
    const existing = this.store.get(id);
    if (!existing) {
      return { ok: false, error: { kind: 'validation', message: 'Draft not found.' } };
    }
    if (existing.outcome !== 'market') {
      return {
        ok: false,
        error: { kind: 'validation', message: 'Unresolvable drafts cannot be edited into markets here — discard it and generate again.' },
      };
    }
    if (existing.status !== 'pending') {
      return {
        ok: false,
        error: { kind: 'validation', message: `Only pending drafts can be edited (this draft is ${existing.status}).` },
      };
    }

    const current = existing.payload as Extract<DraftRecord['payload'], { outcome: 'market' }>;
    const merged = { ...current, ...patch };
    const issues = validateMarketSemantics(merged, now);
    if (issues.length > 0) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          message: 'The edited draft failed validation and was not saved.',
          details: issues.map((i) => `${i.field}: ${i.message}`),
        },
      };
    }

    const updated = this.store.update(id, patch);
    if (!updated) {
      return { ok: false, error: { kind: 'validation', message: 'Draft could not be updated.' } };
    }
    return { ok: true, draft: updated };
  }

  /**
   * Explicit editor approval — the only code path that sets a draft live
   * (check 8). Triggered solely by the editor's approval action.
   */
  approve(id: string): ActionEnvelope {
    const existing = this.store.get(id);
    if (!existing) {
      return { ok: false, error: { kind: 'validation', message: 'Draft not found.' } };
    }
    if (existing.outcome !== 'market') {
      return {
        ok: false,
        error: { kind: 'validation', message: 'An unresolvable outcome cannot be approved as a live market.' },
      };
    }
    if (existing.status === 'approved') {
      return { ok: false, error: { kind: 'validation', message: 'This draft is already live.' } };
    }
    if (existing.status === 'discarded') {
      return { ok: false, error: { kind: 'validation', message: 'A discarded draft cannot be approved.' } };
    }
    const approved = this.store.approve(id);
    if (!approved) {
      return { ok: false, error: { kind: 'validation', message: 'Approval failed.' } };
    }
    return { ok: true, draft: approved };
  }

  /** Explicit discard action — separate from approval. */
  discard(id: string): ActionEnvelope {
    const discarded = this.store.discard(id);
    if (!discarded) {
      return { ok: false, error: { kind: 'validation', message: 'Draft not found.' } };
    }
    return { ok: true, draft: discarded };
  }
}
