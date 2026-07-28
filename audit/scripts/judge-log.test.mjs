// Tests for the judge-reasoning block builder that writes onto the Notion lead
// row's page body. No token, no network: judgeLogBlocks is pure.
//   node --test scripts/judge-log.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeLogBlocks } from './leads.mjs';

const textOf = (b) => (b[b.type].rich_text || []).map((r) => r.text.content).join('');
const allText = (blocks) => blocks.map(textOf).join('\n');

const record = (over = {}) => ({
  auditId: 'aud_test',
  tag: 'jackpotter_pipe_r1',
  pickerModel: 'claude-sonnet-4-6',
  picker: { pages_used: ['a', 'b', 'c', 'd', 'e'] },
  judge_log: {
    summary: '2 findings kept, 1 dropped by the quote gate, 1 considered and rejected.',
    approach: 'I compared the two promotion pages against each other.',
    rejected: ['repeated nav labels: template, not a content error'],
  },
  findings: [
    {
      severity: 'high',
      category: 'contradiction',
      url: 'https://x.com/promotions/second-deposit',
      gate: 'pass',
      reasoning: 'Two slots named in consecutive bullets. I tested the two-batch reading and the page never splits the 100 spins.',
    },
    {
      severity: 'medium',
      category: 'formatting',
      url: 'https://x.com/vip-club',
      gate: 'pass',
      check: 'short check only',
    },
  ],
  ...over,
});

test('carries the reasoning, not just the finding label', () => {
  const t = allText(judgeLogBlocks(record()));
  assert.match(t, /I tested the two-batch reading/);
  assert.match(t, /I compared the two promotion pages/);
  assert.match(t, /HIGH contradiction on \/promotions\/second-deposit/);
});

test('falls back to the short check, then says the reasoning is missing', () => {
  const t = allText(judgeLogBlocks(record()));
  assert.match(t, /short check only/);

  const bare = record({
    findings: [{ severity: 'low', category: 'grammar', url: 'https://x.com/a', gate: 'pass' }],
  });
  assert.match(allText(judgeLogBlocks(bare)), /No reasoning returned by the judge/);
});

test('marks gate-failed findings as absent from the report', () => {
  const withFail = record({
    findings: [
      { severity: 'high', category: 'pricing', url: 'https://x.com/a', gate: 'fail', reasoning: 'r' },
    ],
  });
  assert.match(allText(judgeLogBlocks(withFail)), /dropped by the quote gate, not in the report/);
});

test('lists what the judge rejected, so a shy judge is visible', () => {
  const t = allText(judgeLogBlocks(record()));
  assert.match(t, /Considered and deliberately not flagged/);
  assert.match(t, /repeated nav labels/);
});

test('omits the rejected and approach sections when the judge returned neither', () => {
  const thin = record({ judge_log: { summary: 'nothing to report' } });
  const t = allText(judgeLogBlocks(thin));
  assert.doesNotMatch(t, /Considered and deliberately not flagged/);
  assert.doesNotMatch(t, /What the judge compared/);
  assert.match(t, /nothing to report/);
});

test('stays inside Notion block and rich_text limits', () => {
  const many = record({
    findings: Array.from({ length: 80 }, (_, i) => ({
      severity: 'low',
      category: 'grammar',
      url: `https://x.com/p${i}`,
      gate: 'pass',
      reasoning: 'x'.repeat(4000),
    })),
  });
  const blocks = judgeLogBlocks(many);
  assert.ok(blocks.length <= 100, `expected <=100 children, got ${blocks.length}`);
  for (const b of blocks) {
    for (const r of b[b.type].rich_text || []) {
      assert.ok(r.text.content.length <= 2000, 'rich_text content over the 2000-char cap');
    }
  }
});
