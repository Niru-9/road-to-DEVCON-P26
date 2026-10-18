/**
 * Golden-set evaluation runner (check 9).
 *
 * Runs every labelled case in data/golden-set.json through the real
 * generation pipeline and reports per-case pass/fail against the expected
 * outcome, with a summary and a non-zero exit code on any mismatch.
 *
 *   npm run eval                     # uses configured provider (needs API key)
 *   npm run eval -- --mock           # deterministic offline smoke run
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.ts';
import { DraftStore } from '../src/db.ts';
import { LlmClient, defaultMockResponder } from '../src/llm.ts';
import { SYSTEM_PROMPT } from '../src/prompt.ts';
import { generateDraft } from '../src/generate.ts';
import { config } from '../src/config.ts';

interface GoldenCase {
  id: string;
  headline: string;
  snippet?: string;
  expectedOutcome: 'market' | 'unresolvable';
  why: string;
}

const goldenPath = fileURLToPath(new URL('../data/golden-set.json', import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as { cases: GoldenCase[] };

const useMock = process.argv.includes('--mock') || config.provider === 'mock';

const client = new LlmClient({
  provider: useMock ? 'mock' : config.provider,
  apiKey: config.provider === 'anthropic' ? config.anthropicApiKey : config.openaiApiKey,
  model: config.provider === 'anthropic' ? config.anthropicModel : config.openaiModel,
  baseUrl: config.openaiBaseUrl,
  timeoutMs: config.llmTimeoutMs,
  maxRetries: config.llmMaxRetries,
  ...(useMock ? { mockResponder: defaultMockResponder } : {}),
});

console.log(`Headline to Market — golden-set evaluation`);
console.log(`provider: ${useMock ? 'mock (offline)' : config.provider}, cases: ${golden.cases.length}`);
console.log('');

if (!client.configured) {
  console.error('No API key configured. Set ANTHROPIC_API_KEY in .env, or run: npm run eval -- --mock');
  process.exit(2);
}

interface Row {
  id: string;
  expected: string;
  got: string;
  pass: boolean;
  note: string;
}

const rows: Row[] = [];
for (const testCase of golden.cases) {
  const result = await generateDraft(client, {
    headline: testCase.headline,
    ...(testCase.snippet ? { snippet: testCase.snippet } : {}),
  });

  let got = 'error';
  let note = '';
  if (result.ok) {
    got = result.draft.outcome;
    if (result.draft.outcome === 'market') {
      note = `closes ${result.draft.closeTime} via ${result.draft.resolutionSource}`;
    } else {
      note = result.draft.reason.slice(0, 80);
    }
  } else {
    note = `${result.error.kind}: ${result.error.message}`;
  }

  rows.push({
    id: testCase.id,
    expected: testCase.expectedOutcome,
    got,
    pass: got === testCase.expectedOutcome,
    note,
  });

  const mark = rows[rows.length - 1].pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${testCase.id}`);
  console.log(`       headline: ${testCase.headline}`);
  console.log(`       expected: ${testCase.expectedOutcome} | got: ${got}`);
  if (note) console.log(`       ${note}`);
}

const passed = rows.filter((r) => r.pass).length;
console.log('');
console.log(`Summary: ${passed}/${rows.length} cases matched their labels.`);
if (passed !== rows.length) {
  console.log('Mismatches:');
  for (const row of rows.filter((r) => !r.pass)) {
    console.log(`  - ${row.id}: expected ${row.expected}, got ${row.got}`);
  }
}

// Also confirm the whole store round-trip works with one synthetic draft.
const store = new DraftStore(':memory:');
const app = new App(store, client);
const synthetic = await app.generate({ headline: 'Bengaluru Metro Blue Line extension opens on December 1' });
if (synthetic.ok && synthetic.draft.status !== 'pending') {
  console.error('Invariant violated: generated draft is not pending.');
  process.exit(1);
}
store.close();

process.exit(passed === rows.length ? 0 : 1);
