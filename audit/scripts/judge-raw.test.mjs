// Tests for putting the judge's verbatim reasoning on the lead row. No token, no
// network: chunkRaw and judgeRawBlocks are pure.
//   node --test scripts/judge-raw.test.mjs
//
// Why this exists: the transcript only ever lived at
// audit/scripts/runs/<tag>.judge-raw.txt on the runner, and a CI container is
// destroyed at job end, so every Actions-run audit lost it before anyone could
// read the summary that pointed at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkRaw, judgeRawBlocks } from './leads.mjs';

const textOf = (b) => (b.paragraph || b.code)?.rich_text?.map((t) => t.text.content).join('') ?? '';

test('chunkRaw: short text stays one chunk', () => {
  assert.deepEqual(chunkRaw('a short transcript'), ['a short transcript']);
  assert.deepEqual(chunkRaw(''), []);
});

test('chunkRaw: every chunk fits Notion 2000-char rich_text cap', () => {
  const long = 'The judge considered the pricing table.\n'.repeat(400);
  for (const c of chunkRaw(long)) assert.ok(c.length <= 1900, `chunk of ${c.length}`);
});

test('chunkRaw: reassembles to the original, losing nothing', () => {
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} of the reasoning`).join('\n');
  assert.equal(chunkRaw(long).join(''), long);
});

test('chunkRaw: breaks on a newline rather than mid-sentence', () => {
  const long = 'x'.repeat(1000) + '\n' + 'y'.repeat(1500);
  const [first] = chunkRaw(long);
  assert.ok(first.endsWith('\n'), 'should break at the newline');
});

test('chunkRaw: one unbroken run still gets split', () => {
  const blob = 'z'.repeat(5000); // minified JSON, no newline to break on
  const chunks = chunkRaw(blob);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 1900);
  assert.equal(chunks.join(''), blob);
});

test('judgeRawBlocks: renders the transcript as code blocks under a header', () => {
  const blocks = judgeRawBlocks('thinking about the price table\n\n=== OUTPUT ===\n{"findings":[]}', 'apex_pipe_r1');
  assert.match(textOf(blocks[0]), /apex_pipe_r1/);
  assert.match(textOf(blocks[0]), /Internal only/);
  assert.equal(blocks[1].type, 'code');
  assert.match(textOf(blocks[1]), /=== OUTPUT ===/);
});

test('judgeRawBlocks: stays under Notion 100-children cap and says what it dropped', () => {
  const huge = 'a'.repeat(1900 * 120);
  const blocks = judgeRawBlocks(huge, 'big_run');
  assert.ok(blocks.length <= 100, `${blocks.length} blocks`);
  assert.match(textOf(blocks[blocks.length - 1]), /Truncated: \d+ of \d+ parts/);
  assert.match(textOf(blocks[blocks.length - 1]), /judge-raw" artifact|judge-raw/);
});

test('judgeRawBlocks: an empty transcript says so instead of rendering nothing', () => {
  assert.match(textOf(judgeRawBlocks('   ', 't')[0]), /No raw reasoning was captured/);
});

// The label depends on which engine ran: a websearch record has one model doing
// discovery, reading and judging in a single pass, so "the judge" mislabels
// what's actually inside the toggle. A pipeline run keeps the old wording, and
// an unspecified method (an older record shape) defaults to it too.
test('judgeRawBlocks: labels the transcript "auditor" for a websearch method, "judge" otherwise', () => {
  const websearch = judgeRawBlocks('reasoning...', 'trueshot_wsn_r1', 'notion-shape');
  assert.match(textOf(websearch[0]), /auditor's thinking/);

  const pipeline = judgeRawBlocks('reasoning...', 'apex_pipe_r1', 'pipeline');
  assert.match(textOf(pipeline[0]), /judge's thinking/);

  const unspecified = judgeRawBlocks('reasoning...', 'apex_pipe_r1');
  assert.match(textOf(unspecified[0]), /judge's thinking/);
});
