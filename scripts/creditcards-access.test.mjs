// Tests for creditcards-access.mjs: the access field on /creditcards
// projects (what it takes to try one). Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_SLUGS, accessProblems, suggestAccess } from './creditcards-access.mjs';

test('access values run easiest first', () => {
  assert.deepEqual(ACCESS_SLUGS, ['none', 'optional', 'wallet', 'paid']);
});

test('approved projects need a valid access value', () => {
  const projects = [
    { id: 'a', name: 'A', status: 'approved', access: 'none' },
    { id: 'b', name: 'B', status: 'approved' },
    { id: 'c', name: 'C', status: 'approved', access: 'free' },
    { id: 'd', name: 'D', status: 'pending' },
    { id: 'e', name: 'E', status: 'rejected', access: 'nope' },
  ];
  const problems = accessProblems(projects);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /"B" \(b\) is approved but has no access/);
  assert.match(problems[1], /"C" \(c\) is approved but has access "free"/);
});

test('suggestAccess reads the usual blurb phrases', () => {
  assert.equal(suggestAccess({ blurb: 'Look up any Credit. Free, nothing to connect.' }), 'none');
  assert.equal(suggestAccess({ blurb: 'Rarity for every Credit. No wallet needed.' }), 'none');
  assert.equal(suggestAccess({ blurb: 'A report card per Credit. Wallet optional.' }), 'optional');
  assert.equal(suggestAccess({ blurb: 'Mint it back once. 0.00037 ETH each, wallet needed.' }), 'paid');
  assert.equal(suggestAccess({ blurb: 'A prediction market. Wallet connected, real money.' }), 'paid');
  assert.equal(suggestAccess({ blurb: '10,000 creatures. Mint on OpenSea, wallet needed.' }), 'wallet');
});

test('suggestAccess falls back to the post text and the url', () => {
  assert.equal(suggestAccess({ tweetText: 'Connect wallet to claim yours' }), 'wallet');
  assert.equal(suggestAccess({ url: 'https://opensea.io/collection/foo' }), 'wallet');
  assert.equal(suggestAccess({}), 'none');
});
