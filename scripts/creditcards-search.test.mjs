// Offline checks for the discovery search tiers: node --test scripts/
// The config and the glossary stay linked: every term a query names must be
// defined in docs/credits-glossary.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MAX_QUERY_LENGTH, buildQuery, configTerms, loadSearchConfig, tiersFor, wantsBioFallback } from './creditcards-search.mjs';

const config = loadSearchConfig();
const glossary = readFileSync(new URL('../docs/credits-glossary.md', import.meta.url), 'utf8').toLowerCase();

test('every search term is in the glossary', () => {
  const missing = configTerms(config).filter((t) => !glossary.includes(t));
  assert.deepEqual(missing, []);
});

test('every query fits X recent search and keeps the since-id windows apart', () => {
  const keys = new Set();
  for (const t of [...config.tiers, ...config.experimental]) {
    const q = buildQuery(t, config);
    assert.ok(q.length <= MAX_QUERY_LENGTH, `${t.id} is ${q.length} characters`);
    assert.ok(!keys.has(t.sinceKey), `${t.id} shares a since-id`);
    keys.add(t.sinceKey);
  }
  assert.equal(config.tiers.find((t) => t.id === 'anchor').sinceKey, 'sinceId', 'the anchor tier keeps the existing window');
  assert.equal(config.tiers.find((t) => t.id === 'replies').sinceKey, 'replySinceId');
});

test('tiers without Jack exclude him, so no post is paid for twice', () => {
  for (const t of config.tiers.filter((t) => ['vocab', 'derivative'].includes(t.id))) {
    assert.match(buildQuery(t, config), /-@jackbutcher -jackbutcher -"jack butcher"/);
  }
  assert.doesNotMatch(buildQuery(config.tiers[0], config), /has:links/, 'the anchor tier no longer needs a link');
});

test('morning tiers run once a UTC day', () => {
  const now = new Date('2026-09-29T18:17:00Z');
  const ids = (lastRuns) => tiersFor(config, { lastRuns, now }).map((t) => t.id);
  assert.deepEqual(ids({}), ['anchor', 'vocab', 'derivative', 'replies']);
  assert.deepEqual(ids({ vocab: '2026-09-29T06:17:00Z', derivative: '2026-09-29T06:17:00Z' }), ['anchor', 'replies']);
});

test('the bio fallback takes the Debits launch and leaves chatter alone', () => {
  const debits =
    'testing complete\n\ndebits mint goes live at 8pm ET\n\n• 80% of mint proceeds acquires credits\n• burn 80 debits to claim an "arbitrage"\n\na permissionless derivative of credits by @jackbutcher';
  assert.ok(wantsBioFallback(debits, config));
  assert.ok(wantsBioFallback('made a little something for @jackbutcher’s credits', config));
  assert.ok(!wantsBioFallback('gm, just picked up 3 more @jackbutcher credits', config));
  assert.ok(!wantsBioFallback('I built my credit score from 580 to 790', config));
});
