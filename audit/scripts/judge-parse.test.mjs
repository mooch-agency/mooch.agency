// Tests for verdict extraction. No network, no LLM.
//   node --test scripts/judge-parse.test.mjs
//
// The regression, from the real failure: the judge returned the whole verdict as
// bare JSON with no code fence. The parser matched only /```json ... ```/, so a
// complete answer with real findings counted as "no verdict" and the run aborted
// three times running (apexvolumetrics.com, aud_ms75zc7ua1xxer, 30 Jul).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJudge } from './judge-parse.mjs';

const verdict = {
  approach: 'Compared the three legal pages.',
  findings: [{ url: 'https://x.com/refund-policy', quote: 'we will honor it.', severity: 'low', category: 'spelling' }],
  rejected: ['repeated nav labels: template, not a content error'],
};
const body = JSON.stringify(verdict, null, 2);

test('bare JSON with no fence at all', () => {
  const r = parseJudge(body);
  assert.equal(r.parsed, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.approach, 'Compared the three legal pages.');
  assert.deepEqual(r.rejected, verdict.rejected);
});

test('the fenced form still works', () => {
  const r = parseJudge('Here is the audit.\n\n```json\n' + body + '\n```');
  assert.equal(r.parsed, true);
  assert.equal(r.findings.length, 1);
});

test('a fence with a different tag, or none', () => {
  for (const tag of ['JSON', 'Json', '']) {
    const r = parseJudge('Result:\n\n```' + tag + '\n' + body + '\n```');
    assert.equal(r.parsed, true, `tag ${tag || '(none)'} should parse`);
  }
});

test('JSON wrapped in prose on both sides', () => {
  const r = parseJudge(`I read all five pages and found one issue.\n${body}\nThat is everything.`);
  assert.equal(r.parsed, true);
  assert.equal(r.findings.length, 1);
});

test('the last block wins, so an example block does not shadow the verdict', () => {
  const example = JSON.stringify({ approach: 'example', findings: [], rejected: [] });
  const r = parseJudge('Schema:\n```json\n' + example + '\n```\nVerdict:\n```json\n' + body + '\n```');
  assert.equal(r.parsed, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.approach, 'Compared the three legal pages.');
});

test('a malformed trailing block does not discard a good earlier one', () => {
  const r = parseJudge('```json\n' + body + '\n```\n\n```json\n{"findings": [ truncated\n```');
  assert.equal(r.parsed, true);
  assert.equal(r.findings.length, 1);
});

test('empty findings is a real verdict, not a failure', () => {
  const r = parseJudge(JSON.stringify({ approach: 'Nothing to report.', findings: [], rejected: [] }));
  assert.equal(r.parsed, true);
  assert.deepEqual(r.findings, []);
});

// The guard must still fire for these: no findings array anywhere.
test('no verdict at all stays unparsed', () => {
  for (const t of [
    '',
    null,
    undefined,
    'I was unable to audit these pages.',
    '```json\n{"notfindings": []}\n```',
    '{"approach": "prose only, no findings key"}',
    'Here is a { brace } but no JSON.',
  ]) {
    assert.equal(parseJudge(t).parsed, false, `should not parse: ${String(t).slice(0, 40)}`);
  }
});

// The system prompt shows the judge a schema object. A judge that echoes that
// schema and then emits its real verdict produces two top-level objects; one
// first-{-to-last-} slice spans both and parses as nothing.
test('a verdict after an echoed schema still parses', () => {
  const schema = '{"approach":"...","findings":[{"url","quote"}],"rejected":["..."]}';
  const r = parseJudge(`I will follow this shape: ${schema}\n\nHere it is:\n${body}`);
  assert.equal(r.parsed, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.approach, 'Compared the three legal pages.');
});

test('a brace inside a quoted value does not end the span', () => {
  const tricky = JSON.stringify({
    approach: 'The page literally prints "{unrendered_token}" in its copy.',
    findings: [{ url: 'https://x.com/a', quote: 'a {token} here', severity: 'low', category: 'formatting' }],
    rejected: [],
  });
  const r = parseJudge(`Findings below.\n${tricky}\nThat is all.`);
  assert.equal(r.parsed, true);
  assert.match(r.approach, /unrendered_token/);
});
