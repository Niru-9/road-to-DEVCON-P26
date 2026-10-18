/**
 * Generation pipeline and app behaviour tests: checks 1 (schema validation
 * before use), 2 (close time comparison in code), 5 (timeout), 6 (capped
 * retries), 7 (validation failure → defined user-visible fallback envelope),
 * 8 (publishing requires explicit approval).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient, defaultMockResponder } from '../src/llm.ts';
import { generateDraft } from '../src/generate.ts';
import { DraftStore } from '../src/db.ts';
import { App } from '../src/app.ts';

const NOW = new Date('2026-10-18T12:00:00+05:30');
const FUTURE = '2026-11-01T17:30:00+05:30';

// Past close time case (check 2).
function pastCloseResponder(): string {
  return JSON.stringify({
    outcome: 'market',
    question: 'Will anything happen?',
    closeTime: '2026-09-15T10:00:00+05:30', // in the past
    resolutionSource: 'Test Source',
    yesCriteria: 'The event is confirmed by the test source.',
    noCriteria: 'If not confirmed, the market resolves NO.',
    edgeCases: ['If the source is silent, resolve NO.'],
  });
}

function validMarketResponder(): string {
  return JSON.stringify({
    outcome: 'market',
    question: 'Will the Bengaluru Metro Blue Line open to the public by December 1, 2026?',
    closeTime: FUTURE,
    resolutionSource: 'Bangalore Metro Rail Corporation (BMRCL)',
    yesCriteria: 'BMRCL announces passenger service on or before close time.',
    noCriteria: 'If not, the market resolves NO.',
    edgeCases: ['If announced but never opens, resolve NO.'],
  });
}

function unresolvableResponder(): string {
  return JSON.stringify({
    outcome: 'unresolvable',
    reason: 'The headline is vague and lacks a named, authoritative resolution source that can settle an unambiguous outcome.',
  });
}

test('check 1 + 2 + 7: past close time model output is schema-valid shape but rejected in code -> validation failure envelope, not used as a draft', async () => {
  const client = new LlmClient({
    provider: 'mock',
    apiKey: '',
    model: 'mock',
    timeoutMs: 5_000,
    maxRetries: 0,
    mockResponder: pastCloseResponder,
  });
  const result = await generateDraft(client, { headline: 'Will something happen?' }, NOW);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, 'validation');
    // Check 7: a defined, editor-facing error (no uncaught exception).
    assert.ok(result.error.message.includes('semantic checks'));
    assert.ok(result.error.details?.some((d) => d.includes('close time')));
  }
});

test('check 7: malformed JSON returns invalid-output envelope with useful message', async () => {
  const client = new LlmClient({
    provider: 'mock',
    apiKey: '',
    model: 'mock',
    timeoutMs: 5_000,
    maxRetries: 0,
    mockResponder: () => '{ outcome: "oops", broken',
  });
  const result = await generateDraft(client, { headline: 'Test' }, NOW);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, 'invalid-output');
    assert.ok(result.error.message.includes('valid JSON'));
  }
});

test('check 1 + 7: model output that violates declared schema is rejected before use', async () => {
  const client = new LlmClient({
    provider: 'mock',
    apiKey: '',
    model: 'mock',
    timeoutMs: 5_000,
    maxRetries: 0,
    mockResponder: () => JSON.stringify({ outcome: 'market', question: 'short' }), // missing required fields
  });
  const result = await generateDraft(client, { headline: 'Test' }, NOW);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, 'validation');
    assert.ok(result.error.details?.length);
  }
});

test('check 5: a hanging fetch is aborted within the explicit timeout', async () => {
  const neverResolves = () => new Promise<Response>(() => {});
  const client = new LlmClient({
    provider: 'anthropic',
    apiKey: 'test',
    model: 'test',
    timeoutMs: 100, // check 5: explicit, concrete
    maxRetries: 0,
    fetchImpl: neverResolves,
  });
  const started = Date.now();
  const result = await generateDraft(client, { headline: 'Test' }, NOW);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, 'llm');
    assert.match(result.error.message, /timed out|timeout/i, result.error.message);
  }
  assert.ok(elapsed < 2000, 'aborted within a short window');
});

test('check 6: transient failures are retried at most maxRetries + 1 times (cap respected)', async () => {
  let calls = 0;
  const client = new LlmClient({
    provider: 'anthropic',
    apiKey: 'test',
    model: 'test',
    timeoutMs: 5000,
    maxRetries: 2, // finite cap; total attempts should be 3
    fetchImpl: async () => {
      calls++;
      // 429 is retryable
      return new Response('rate limited', { status: 429 });
    },
  });
  const result = await generateDraft(client, { headline: 'Test' }, NOW);
  assert.equal(result.ok, false);
  assert.equal(calls, 3, 'expected exactly 3 attempts (retries=2, cap respected)');
});

test('check 6 + network: a non-retryable 400 stops after 1 attempt', async () => {
  let calls = 0;
  const client = new LlmClient({
    provider: 'anthropic',
    apiKey: 'test',
    model: 'test',
    timeoutMs: 5000,
    maxRetries: 5,
    fetchImpl: async () => {
      calls++;
      return new Response('bad request', { status: 400 });
    },
  });
  await generateDraft(client, { headline: 'Test' }, NOW);
  assert.equal(calls, 1, 'non-retryable error must not use the retry budget');
});

test('check 8: generation stores only as pending; approve is the only path to live', async () => {
  const client = new LlmClient({
    provider: 'mock',
    apiKey: '',
    model: 'mock',
    timeoutMs: 5000,
    maxRetries: 0,
    mockResponder: validMarketResponder,
  });
  const store = new DraftStore(':memory:');
  const app = new App(store, client);
  const now = new Date('2026-10-18T12:00:00+05:30');

  const gen = await app.generate({ headline: 'Bengaluru Metro Blue Line opens on December 1' }, now);
  assert.equal(gen.ok, true, `generation should succeed: ${JSON.stringify(gen)}`);
  if (!gen.ok) throw new Error('should have succeeded');
  assert.equal(gen.draft.status, 'pending', 'draft must be unpublished at generation time');
  assert.equal(gen.draft.outcome, 'market');

  // Approval — explicit editor action (check 8).
  const approve = app.approve(gen.draft.id);
  assert.equal(approve.ok, true);
  if (approve.ok) {
    assert.equal(approve.draft.status, 'approved');
    assert.equal(approve.draft.outcome, 'market');
  }

  // Discard is separate.
  const client2 = new LlmClient({
    provider: 'mock',
    apiKey: '',
    model: 'mock',
    timeoutMs: 5000,
    maxRetries: 0,
    mockResponder: unresolvableResponder,
  });
  const store2 = new DraftStore(':memory:');
  const app2 = new App(store2, client2);
  const unres = await app2.generate({ headline: 'Something exciting happened' }, now);
  assert.equal(unres.ok, true);
  if (unres.ok) {
    assert.equal(unres.draft.status, 'pending');
    assert.equal(unres.draft.outcome, 'unresolvable');
    const discard = app2.discard(unres.draft.id);
    assert.equal(discard.ok, true);
    if (discard.ok) assert.equal(discard.draft.status, 'discarded');
  }

  store.close();
  store2.close();
});

test('check 7 + 8: approve is rejected for unresolvable and for already-discarded drafts; edit requires pending market', async () => {
  const client = new LlmClient({
    provider: 'mock',
    apiKey: '',
    model: 'mock',
    timeoutMs: 5000,
    maxRetries: 0,
    mockResponder: unresolvableResponder,
  });
  const store = new DraftStore(':memory:');
  const app = new App(store, client);
  const now = new Date('2026-10-18T12:00:00+05:30');

  const r = await app.generate({ headline: 'vague' }, now);
  assert.equal(r.ok, true);
  if (r.ok) {
    const badApprove = app.approve(r.draft.id);
    assert.equal(badApprove.ok, false, 'cannot approve unresolvable');
    const discard = app.discard(r.draft.id);
    assert.equal(discard.ok, true);
    assert.equal(discard.ok && discard.draft.status, 'discarded');
    if (discard.ok) {
      const badApprove2 = app.approve(discard.draft.id);
      assert.equal(badApprove2.ok, false, 'cannot approve discarded');
    }
  }

  const client2 = new LlmClient({
    provider: 'mock',
    apiKey: '',
    model: 'mock',
    timeoutMs: 5000,
    maxRetries: 0,
    mockResponder: validMarketResponder,
  });
  const store2 = new DraftStore(':memory:');
  const app2 = new App(store2, client2);
  const r2 = await app2.generate({ headline: 'metro' }, now);
  assert.equal(r2.ok, true);
  if (r2.ok) {
    const approved = app2.approve(r2.draft.id);
    assert.equal(approved.ok, true);
    const edit = app2.edit(r2.draft.id, { question: 'edited?' }, now);
    assert.equal(edit.ok, false, 'only pending drafts can be edited');
  }

  store.close();
  store2.close();
});
