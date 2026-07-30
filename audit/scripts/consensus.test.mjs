// Multi-pass consensus judging.
//   node --test scripts/consensus.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePasses, shipDecision, findingKey } from './consensus.mjs';

const f = (over = {}) => ({
  url: 'https://example.com/',
  quote: 'a recent prediction by Nvidia CTO',
  category: 'factual',
  severity: 'medium',
  issue: 'Jensen Huang is CEO, not CTO.',
  ...over,
});

test('identity is the quote, not the prose, because the prose is rewritten each pass', () => {
  const a = f({ issue: 'Jensen Huang is CEO, not CTO.' });
  const b = f({ issue: 'The page calls Huang CTO; he is the CEO and co-founder.' });
  assert.equal(findingKey(a), findingKey(b));
});

// The r3p case that motivates all of this: seen in 2 of 4 passes, so it ships.
// Under single-pass judging it reached the client half the time.
test('a finding corroborated by 2 passes ships', () => {
  const { findings } = mergePasses([[f()], [f()], [], []]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].passes, 2);
  assert.equal(findings[0].pass_total, 4);
  assert.equal(findings[0].confidence, 'medium');
});

test('a one-off low finding does not ship, it goes to the judge log', () => {
  const { findings, dropped } = mergePasses([[f({ severity: 'low', quote: 'two copyright symbols' })], [], []]);
  assert.equal(findings.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].confidence, 'low');
});

// Deliberately asymmetric: recall matters most where the stakes are highest, so
// a lone high or critical still reaches the client. Dropping a wow-grade finding
// to protect against a marginal FP is the wrong trade for this product.
test('a one-off HIGH finding still ships', () => {
  const { findings } = mergePasses([[f({ severity: 'high' })], [], []]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, 'low');
});

test('a one-off CRITICAL finding still ships', () => {
  const { findings } = mergePasses([[f({ severity: 'critical' })], [], []]);
  assert.equal(findings.length, 1);
});

test('unanimous findings are marked high confidence', () => {
  const { findings } = mergePasses([[f()], [f()], [f()]]);
  assert.equal(findings[0].confidence, 'high');
  assert.equal(findings[0].passes, 3);
});

// Severity disagreed across passes on the Huang finding (medium twice, high
// once) and on lisbon's "every other classes" (medium/low). Mode wins; ties go
// to the more severe reading so a real high is not averaged away.
test('consensus severity takes the mode', () => {
  const { findings } = mergePasses([[f({ severity: 'medium' })], [f({ severity: 'medium' })], [f({ severity: 'high' })]]);
  assert.equal(findings[0].severity, 'medium');
});

test('a tied severity resolves to the more severe reading', () => {
  const { findings } = mergePasses([[f({ severity: 'high' })], [f({ severity: 'medium' })]]);
  assert.equal(findings[0].severity, 'high');
});

// A reviewer checking a finding wants the fullest evidence any pass produced.
test('the merged finding keeps the best-evidenced variant', () => {
  const thin = f();
  const rich = f({ quote2: 'he is the CEO', url2: 'https://example.com/about', reasoning: 'long reasoning here' });
  const { findings } = mergePasses([[thin], [rich]]);
  assert.equal(findings[0].quote2, 'he is the CEO');
  assert.equal(findings[0].url2, 'https://example.com/about');
});

// Single-pass runs must behave exactly as they do today: this is opt-in, and it
// must not quietly change the default path.
test('a single pass ships everything, unchanged', () => {
  const { findings, dropped } = mergePasses([[f({ severity: 'low' }), f({ severity: 'medium', quote: 'other' })]]);
  assert.equal(findings.length, 2);
  assert.equal(dropped.length, 0);
  assert.equal(findings[0].confidence, 'unmeasured');
});

test('shipDecision is the whole policy, in one place', () => {
  assert.equal(shipDecision({ passes: 1, total: 1, severity: 'low' }), true);
  assert.equal(shipDecision({ passes: 2, total: 3, severity: 'low' }), true);
  assert.equal(shipDecision({ passes: 1, total: 3, severity: 'low' }), false);
  assert.equal(shipDecision({ passes: 1, total: 3, severity: 'medium' }), false);
  assert.equal(shipDecision({ passes: 1, total: 3, severity: 'high' }), true);
  assert.equal(shipDecision({ passes: 1, total: 3, severity: 'critical' }), true);
});

test('findings come back worst-first, then best-corroborated', () => {
  const { findings } = mergePasses([
    [f({ severity: 'low', quote: 'q1' }), f({ severity: 'high', quote: 'q2' })],
    [f({ severity: 'low', quote: 'q1' }), f({ severity: 'high', quote: 'q2' })],
  ]);
  assert.equal(findings[0].severity, 'high');
});
