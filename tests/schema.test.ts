/**
 * Schema tests: check 1 (declared schema), check 3 (explicit unresolvable
 * outcome), check 2 (close time vs current time, in code).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  llmDraftSchema,
  marketDraftSchema,
  unresolvableDraftSchema,
  validateMarketSemantics,
  validateHeadlineInput,
  MAX_CLOSE_TIME_MS,
  type MarketDraft,
} from '../src/schema.ts';

const NOW = new Date('2026-10-18T12:00:00+05:30');
const FUTURE = '2026-11-01T17:30:00+05:30';

function validMarket(overrides: Partial<MarketDraft> = {}): MarketDraft {
  return {
    outcome: 'market',
    question: 'Will the Bengaluru Metro Blue Line extension open to the public by December 1, 2026?',
    closeTime: FUTURE,
    resolutionSource: 'Bangalore Metro Rail Corporation (BMRCL)',
    yesCriteria: 'BMRCL publicly announces that the Blue Line extension is open to regular passengers on or before the close time.',
    noCriteria: 'If BMRCL has not opened the extension to regular passengers by the close time, the market resolves NO.',
    edgeCases: [
      'If inauguration happens but passenger service is suspended, the market resolves NO.',
      'If BMRCL publishes no statement by close time, the market resolves NO.',
    ],
    ...overrides,
  };
}

test('check 1: a complete market passes the declared schema', () => {
  const result = marketDraftSchema.safeParse(validMarket());
  assert.equal(result.success, true);
});

test('check 1: a market missing required fields fails schema validation', () => {
  const { resolutionSource: _omitted, ...missingSource } = validMarket();
  assert.equal(marketDraftSchema.safeParse(missingSource).success, false);

  const { edgeCases: _omitted2, ...missingEdge } = validMarket();
  assert.equal(marketDraftSchema.safeParse(missingEdge).success, false);

  assert.equal(marketDraftSchema.safeParse({ ...validMarket(), yesCriteria: '' }).success, false);
  assert.equal(marketDraftSchema.safeParse({ ...validMarket(), question: 'opens soon' }).success, false);
});

test('check 1: question must be a real question', () => {
  assert.equal(marketDraftSchema.safeParse({ ...validMarket(), question: 'The metro opens in December' }).success, false);
});

test('check 3: the unresolvable outcome is a distinct schema branch carrying a reason', () => {
  const unresolvable = { outcome: 'unresolvable', reason: 'The headline is subjective and no named authority can settle a taste judgement.' };
  assert.equal(unresolvableDraftSchema.safeParse(unresolvable).success, true);

  const union = llmDraftSchema.safeParse(unresolvable);
  assert.equal(union.success, true);
  if (union.success) assert.equal(union.data.outcome, 'unresolvable');
});

test('check 3: the discriminated union rejects an unknown outcome', () => {
  assert.equal(llmDraftSchema.safeParse({ outcome: 'maybe', reason: 'x'.repeat(30) }).success, false);
  assert.equal(llmDraftSchema.safeParse(validMarket({ outcome: 'maybe' } as never)).success, false);
});

test('check 3: an unresolvable result without a meaningful reason fails', () => {
  assert.equal(llmDraftSchema.safeParse({ outcome: 'unresolvable', reason: 'unclear' }).success, false);
  assert.equal(llmDraftSchema.safeParse({ outcome: 'unresolvable' }).success, false);
});

test('check 2: a past close time is rejected in code, not just in the prompt', () => {
  const issues = validateMarketSemantics(validMarket({ closeTime: '2026-10-01T10:00:00+05:30' }), NOW);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'closeTime');
  assert.match(issues[0].message, /future/i);
});

test('check 2: "now" exactly is rejected; a valid future close time passes', () => {
  const atNow = validateMarketSemantics(validMarket({ closeTime: NOW.toISOString() }), NOW);
  assert.equal(atNow.length, 1);
  const future = validateMarketSemantics(validMarket(), NOW);
  assert.equal(future.length, 0);
});

test('check 2: unparseable and absurdly distant close times are flagged', () => {
  const bad = validateMarketSemantics(validMarket({ closeTime: 'tomorrow-ish' }), NOW);
  assert.equal(bad[0].field, 'closeTime');

  const far = new Date(NOW.getTime() + MAX_CLOSE_TIME_MS + 1000).toISOString();
  const farIssues = validateMarketSemantics(validMarket({ closeTime: far }), NOW);
  assert.equal(farIssues[0].field, 'closeTime');
});

test('semantic checks: vague resolution sources are rejected', () => {
  for (const source of ['unknown', 'TBD', 'the internet', 'someone']) {
    const issues = validateMarketSemantics(validMarket({ resolutionSource: source }), NOW);
    assert.equal(issues.length, 1, `expected rejection for source "${source}"`);
    assert.equal(issues[0].field, 'resolutionSource');
  }
});

test('headline input validation caps length and requires content', () => {
  assert.ok(validateHeadlineInput('', undefined).length > 0);
  assert.ok(validateHeadlineInput(undefined, undefined).length > 0);
  assert.ok(validateHeadlineInput('x'.repeat(500), undefined).length > 0);
  assert.equal(validateHeadlineInput('A normal headline', 'a snippet').length, 0);
});
