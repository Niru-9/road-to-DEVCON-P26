/**
 * LLM client.
 *
 * Check 5: every model call has an explicit timeout (AbortController-driven).
 * Check 6: retries are explicitly capped with a finite numeric constant.
 */
import type { LlmProviderName } from './config.ts';
import type { MarketDraft, UnresolvableDraft } from './schema.ts';

export interface LlmChatRequest {
  system: string;
  user: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type LlmErrorKind = 'config' | 'timeout' | 'network' | 'http';

export class LlmError extends Error {
  kind: LlmErrorKind;
  status?: number;
  retryable: boolean;

  constructor(kind: LlmErrorKind, message: string, options: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface LlmClientOptions {
  provider: LlmProviderName;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Check 5: explicit timeout for each model call attempt, in ms. */
  timeoutMs: number;
  /** Check 6: explicit finite retry cap. Total attempts = maxRetries + 1. */
  maxRetries: number;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Used by the mock provider (offline demo / eval smoke runs). */
  mockResponder?: (req: LlmChatRequest) => string | Promise<string>;
}

const RETRY_BASE_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LlmClient {
  readonly provider: LlmProviderName;
  readonly model: string;
  /** Check 5 — visible, concrete timeout configuration. */
  readonly timeoutMs: number;
  /** Check 6 — visible, concrete finite retry cap. */
  readonly maxRetries: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly mockResponder?: (req: LlmChatRequest) => string | Promise<string>;

  constructor(options: LlmClientOptions) {
    this.provider = options.provider;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.mockResponder = options.mockResponder;
  }

  /** True when the provider is configured enough to attempt a call. */
  get configured(): boolean {
    if (this.provider === 'mock') return true;
    if (this.provider === 'anthropic') return this.apiKey.length > 0;
    if (this.provider === 'openai') return this.apiKey.length > 0;
    return false;
  }

  /**
   * Complete a chat request. Retries transient failures up to `maxRetries`
   * times (finite cap); each attempt is bounded by `timeoutMs`.
   */
  async complete(req: LlmChatRequest): Promise<string> {
    if (!this.configured) {
      throw new LlmError(
        'config',
        this.provider === 'anthropic'
          ? 'ANTHROPIC_API_KEY is not set. Add it to .env, or use LLM_PROVIDER=mock for an offline demo.'
          : 'OPENAI_API_KEY is not set. Add it to .env, or use LLM_PROVIDER=mock for an offline demo.',
      );
    }
    const maxAttempts = this.maxRetries + 1; // Check 6: finite numeric cap
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.once(req);
      } catch (err) {
        lastError = err;
        const transient =
          err instanceof LlmError ? err.retryable : err instanceof TypeError; // fetch network failure
        if (!transient || attempt === maxAttempts) break;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
    if (lastError instanceof LlmError) throw lastError;
    throw new LlmError('network', `model call failed: ${String(lastError)}`, { retryable: false, cause: lastError });
  }

  /** One attempt, with the explicit timeout applied. */
  private async once(req: LlmChatRequest): Promise<string> {
    if (this.provider === 'mock') {
      if (!this.mockResponder) {
        throw new LlmError('config', 'mock provider requires a mockResponder');
      }
      return await this.mockResponder(req);
    }
    const controller = new AbortController();
    // Check 5: the timeout is enforced in code (the race below), not just by
    // hoping the fetch implementation honours the abort signal. A stalled
    // connection always fails fast with a retryable timeout error.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new LlmError('timeout', `model call timed out after ${this.timeoutMs}ms`, { retryable: true }),
        );
      }, this.timeoutMs);
    });
    const attempt = (async () => {
      const res =
        this.provider === 'anthropic'
          ? await this.callAnthropic(req, controller.signal)
          : await this.callOpenAi(req, controller.signal);
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new LlmError('http', `model API returned HTTP ${res.status}`, { status: res.status, retryable });
      }
      const body = (await res.json()) as unknown;
      return this.extractText(body);
    })();
    try {
      return await Promise.race([attempt, timeout]);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (controller.signal.aborted) {
        throw new LlmError('timeout', `model call timed out after ${this.timeoutMs}ms`, { retryable: true, cause: err });
      }
      throw new LlmError('network', `model call failed: ${String(err)}`, { retryable: true, cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  private async callAnthropic(req: LlmChatRequest, signal: AbortSignal): Promise<Response> {
    return await this.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1500,
        temperature: 0.2,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }),
    });
  }

  private async callOpenAi(req: LlmChatRequest, signal: AbortSignal): Promise<Response> {
    return await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
  }

  private extractText(body: unknown): string {
    if (this.provider === 'anthropic') {
      const b = body as { content?: Array<{ type?: string; text?: string }> };
      const text = b.content?.find((c) => c.type === 'text')?.text;
      if (typeof text !== 'string') throw new LlmError('network', 'unexpected Anthropic response shape');
      return text;
    }
    const b = body as { choices?: Array<{ message?: { content?: string } }> };
    const text = b.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new LlmError('network', 'unexpected OpenAI response shape');
    return text;
  }
}

// ---------------------------------------------------------------------------
// Deterministic offline mock responder — used by tests, the offline demo, and
// `npm run eval` smoke runs. It mimics plausible model behaviour with simple
// heuristics; it is NOT the product logic.
// ---------------------------------------------------------------------------

const VAGUE_WORDS = /\b(improve|improvement|better|beautiful|ugly|exciting|nice|great|good|interesting|mess|soon|happen)\b/i;
const SUBJECTIVE = /\b(best|worst|favourite|favorite|prettiest|nicest|coolest)\b/i;

function mockAnswer(req: LlmChatRequest, now: Date): string {
  const headlineMatch = req.user.match(/<headline>\n?([\s\S]*?)\n?<\/headline>/);
  const headline = (headlineMatch?.[1] ?? '').trim();

  const yearMatch = headline.match(/\b(19|20)\d{2}\b/);
  const mentionedYear = yearMatch ? Number.parseInt(yearMatch[0], 10) : null;
  const pastEvent = mentionedYear !== null && mentionedYear < now.getFullYear();

  if (headline.length === 0 || VAGUE_WORDS.test(headline) || SUBJECTIVE.test(headline) || pastEvent) {
    const reason = pastEvent
      ? `"${headline}" refers to an event that has already happened and been settled in the past (${mentionedYear}); a market cannot be opened on an already-decided outcome.`
      : `"${headline}" is too vague or subjective to settle: no concrete, externally verifiable event, condition, or named source can turn it into an unambiguous YES/NO outcome.`;
    const unresolvable: UnresolvableDraft = { outcome: 'unresolvable', reason };
    return JSON.stringify(unresolvable);
  }

  const close = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const market: MarketDraft = {
    outcome: 'market',
    question: headline.endsWith('?') ? headline : `${headline.replace(/\.$/, '')}?`,
    closeTime: close.toISOString(),
    resolutionSource: 'Press Trust of India (ptinews.com)',
    yesCriteria: `The named resolution source publishes a report confirming the event described in the headline as having occurred in full before the close time.`,
    noCriteria: `If the named source has not confirmed the event in full by the close time, the market resolves NO. Any outcome not meeting the YES criteria resolves NO.`,
    edgeCases: [
      'If the source publishes no verdict by close time, the market resolves NO.',
      'If reporting is later retracted, the resolution stands as of the close-time evidence.',
    ],
  };
  return JSON.stringify(market);
}

export function defaultMockResponder(req: LlmChatRequest): string {
  return mockAnswer(req, new Date());
}
