/**
 * Generation pipeline: prompt -> model call -> JSON parse -> schema
 * validation (check 1) -> semantic validation in code (check 2) -> typed
 * result. Any failure returns a structured, editor-facing error envelope —
 * it never throws out of this function and never surfaces invalid output as a
 * draft (check 7).
 */
import type { LlmClient } from './llm.ts';
import { SYSTEM_PROMPT, buildUserMessage, type PromptInput } from './prompt.ts';
import { llmDraftSchema, validateMarketSemantics, type LlmDraft } from './schema.ts';

export type GenerationErrorKind = 'config' | 'llm' | 'invalid-output' | 'validation';

export interface GenerationError {
  kind: GenerationErrorKind;
  /** Editor-facing message. */
  message: string;
  /** Optional details, e.g. per-field validation issues. */
  details?: string[];
}

export type GenerateResult =
  | { ok: true; draft: LlmDraft }
  | { ok: false; error: GenerationError };

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : trimmed;
}

export async function generateDraft(
  client: LlmClient,
  input: PromptInput,
  now: Date = new Date(),
): Promise<GenerateResult> {
  // 1-2. System instructions and delimited user data are separate (check 4).
  const userMessage = buildUserMessage(input);

  let text: string;
  try {
    text = await client.complete({ system: SYSTEM_PROMPT, user: userMessage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        kind: 'llm',
        message: `The model call failed: ${message}. You can retry or draft the market manually.`,
      },
    };
  }

  // 3. Parse the full response as JSON. This is NOT trusted yet.
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFences(text));
  } catch {
    return {
      ok: false,
      error: {
        kind: 'invalid-output',
        message:
          'The model did not return valid JSON, so no draft could be created. ' +
          'You can retry or draft the market manually.',
        details: [`Response began with: ${text.slice(0, 120)}`],
      },
    };
  }

  // 4. Check 1: validate against the declared schema before any field is used.
  const parsed = llmDraftSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        message:
          'The model response failed schema validation and was discarded. ' +
          'You can retry or draft the market manually.',
        details: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      },
    };
  }

  // 5. Check 2: semantic validation in code — close time vs current time, etc.
  if (parsed.data.outcome === 'market') {
    const issues = validateMarketSemantics(parsed.data, now);
    if (issues.length > 0) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          message:
            'The draft failed semantic checks (meaning, not just shape) and was discarded. ' +
            'You can retry or draft the market manually.',
          details: issues.map((i) => `${i.field}: ${i.message}`),
        },
      };
    }
  }

  return { ok: true, draft: parsed.data };
}
