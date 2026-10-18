/**
 * Database tests: stored status, approval guardrails, edits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftStore } from '../src/db.ts';
import { LlmClient } from '../src/llm.ts';
import { App } from '../src/app.ts';

const NOW = new Date('2026-10-18T12:00:00+05:30');

test('db: generation never writes anything other than pending', async () => {
  const client = new LlmClient({
    provider: 'mock',
    apiKey: '',
    model: 'mock',
    timeoutMs: 5000,
    maxRetries: 0,
    mockResponder: () => JSON.stringify({
      outcome: 'market',
      question: 'Will X happen?',
      closeTime: '2026-11-01T17:30:00+05:30',
      resolutionSource: 'Test Authority',
      yesCriteria: 'X occurs in the specified timeframe.',
      noCriteria: 'Otherwise NO.',
      edgeCases: ['Silence => NO.'],
    }),
  });
  const store = new DraftStore(':memory:');
  const app = new App(store, client);
  const r = await app.generate({ headline: 'X happens soon?' }, NOW);
  assert.equal(r.ok, true);
  if (r.ok) {
    const rec = store.get(r.draft.id);
    assert.equal(rec?.status, 'pending');
    assert.equal(rec?.outcome, 'market');
  }
  store.close();
});

test('db: approve is the only code path that changes status to approved', () => {
  const store = new DraftStore(':memory:');
  const id = store.createPending({
    headline: 'h',
    payload: {
      outcome: 'market',
      question: 'Will it happen?',
      closeTime: '2026-11-01T17:30:00+05:30',
      resolutionSource: 'Known Source',
      yesCriteria: 'Confirmed by the specified authority.',
      noCriteria: 'Otherwise NO.',
      edgeCases: ['No news => NO.'],
    },
  }).id;
  assert.equal(store.get(id)?.status, 'pending');
  const approved = store.approve(id);
  assert.equal(approved?.status, 'approved');
  store.close();
});

test('db: discard is a separate action', () => {
  const store = new DraftStore(':memory:');
  const id = store.createPending({
    headline: 'h',
    payload: {
      outcome: 'unresolvable',
      reason: 'This is vague and cannot be settled by any named authority.',
    },
  }).id;
  assert.equal(store.get(id)?.status, 'pending');
  const discarded = store.discard(id);
  assert.equal(discarded?.status, 'discarded');
  store.close();
});
