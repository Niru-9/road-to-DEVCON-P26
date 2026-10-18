/**
 * Runtime configuration. Every credential comes from the environment only —
 * never from tracked files. See `.env.example` for placeholders.
 */
import { existsSync } from 'node:fs';

// Load .env if present (no-op otherwise). Node 20.12+ supports loadEnvFile.
try {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
} catch {
  // A malformed .env should not crash startup; env vars still apply.
}

export type LlmProviderName = 'anthropic' | 'openai' | 'mock';

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

const providerRaw = strEnv('LLM_PROVIDER', 'anthropic');
if (!['anthropic', 'openai', 'mock'].includes(providerRaw)) {
  throw new Error(
    `Unknown LLM_PROVIDER "${providerRaw}". Use "anthropic", "openai", or "mock".`,
  );
}

export const config = {
  provider: providerRaw as LlmProviderName,

  // Anthropic
  anthropicApiKey: strEnv('ANTHROPIC_API_KEY', ''),
  anthropicModel: strEnv('ANTHROPIC_MODEL', 'claude-sonnet-4-5'),

  // OpenAI-compatible
  openaiApiKey: strEnv('OPENAI_API_KEY', ''),
  openaiBaseUrl: strEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
  openaiModel: strEnv('OPENAI_MODEL', 'gpt-4o-mini'),

  /** Explicit timeout on every model call, in milliseconds. */
  llmTimeoutMs: intEnv('LLM_TIMEOUT_MS', 30_000, 1_000, 300_000),
  /** Explicit finite cap on model-call retries (attempts = retries + 1). */
  llmMaxRetries: intEnv('LLM_MAX_RETRIES', 2, 0, 5),

  port: intEnv('PORT', 8787, 1, 65_535),
  dbPath: strEnv('DB_PATH', 'data/app.db'),
};
