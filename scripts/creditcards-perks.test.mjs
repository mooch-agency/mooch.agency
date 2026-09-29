// Offline tests for the Perks view: the status rule, the data check, and the
// bake (pill order and count, cards, a status that flips with the day).
// No network. Run: node --test scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { perkProblems, perkStatus, sortPerks } from './creditcards-perks.mjs';
import { run } from './creditcards-update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const perk = (over = {}) => ({
  id: 'test-perk',
  project: 'Test Project',
  x: 'builder',
  type: 'free-mint',
  eligibility: 'Credits holders',
  description: 'A free mint for holders.',
  url: 'https://example.com',
  post: 'https://x.com/builder/status/123',
  ...over,
});

test('perkStatus: end dates, ended reasons and unknowns', () => {
  assert.equal(perkStatus(perk({ end: '2026-10-01' }), '2026-09-29'), 'open');
  assert.equal(perkStatus(perk({ end: '2026-10-01' }), '2026-10-01'), 'open', 'open through its last day');
  assert.equal(perkStatus(perk({ end: '2026-10-01' }), '2026-10-02'), 'ended');
  assert.equal(perkStatus(perk({ start: '2026-10-05', end: '2026-10-09' }), '2026-09-29'), 'unknown', 'not started yet');
  assert.equal(perkStatus(perk({ ended: 'Sold out' }), '2026-09-29'), 'ended');
  assert.equal(perkStatus(perk({ start: '2026-09-23' }), '2026-09-29'), 'unknown');
  assert.equal(perkStatus(perk({ seenOpen: '2026-09-29' }), '2026-09-29'), 'open', 'seen live today');
  assert.equal(perkStatus(perk({ seenOpen: '2026-09-29' }), '2026-10-06'), 'open', 'still vouched for on day 7');
  assert.equal(perkStatus(perk({ seenOpen: '2026-09-29' }), '2026-10-07'), 'unknown', 'a stale check stops vouching');
});

test('sortPerks: open, then unknown, then ended, newest first', () => {
  const list = [
    perk({ id: 'a', ended: 'Sold out', start: '2026-09-28' }),
    perk({ id: 'b', start: '2026-09-20' }),
    perk({ id: 'c', end: '2026-10-01', start: '2026-09-21' }),
    perk({ id: 'd', start: '2026-09-25' }),
  ];
  assert.deepEqual(sortPerks(list, '2026-09-29').map((p) => p.id), ['c', 'd', 'b', 'a']);
});

test('perkProblems: required fields, types, dates, dashes, no stored status', () => {
  assert.deepEqual(perkProblems(undefined), []);
  assert.deepEqual(perkProblems([perk()]), []);
  const missing = perkProblems([{ id: 'x' }]);
  for (const f of ['project', 'x', 'type', 'eligibility', 'description', 'url', 'post']) {
    assert.ok(missing.some((m) => m.includes(`has no ${f}`)), f);
  }
  assert.ok(perkProblems([perk({ type: 'raffle' })])[0].includes('type "raffle"'));
  assert.ok(perkProblems([perk({ end: '1 Oct' })])[0].includes('YYYY-MM-DD'));
  assert.ok(perkProblems([perk({ start: '2026-10-02', end: '2026-10-01' })])[0].includes('ends before'));
  assert.ok(perkProblems([perk({ description: 'Free — for holders' })])[0].includes('dash'));
  assert.ok(perkProblems([perk({ status: 'open' })])[0].includes('bake time'));
  assert.ok(perkProblems([perk({ post: 'https://twitter.com/builder/status/1' })])[0].includes('post'));
  assert.ok(perkProblems([perk(), perk()]).some((m) => m.includes('twice')));
  assert.ok(perkProblems([perk({ seenOpen: '2026-09-29', ended: 'Sold out' })])[0].includes('seenOpen'));
});

function sandbox(perks) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-perks-'));
  mkdirSync(path.join(dir, 'data'));
  copyFileSync(path.join(ROOT, 'creditcards.html'), path.join(dir, 'creditcards.html'));
  const data = JSON.parse(readFileSync(path.join(ROOT, 'data/creditcards.json'), 'utf8'));
  data.perks = perks;
  writeFileSync(path.join(dir, 'data/creditcards.json'), JSON.stringify(data, null, 2) + '\n');
  return dir;
}

test('bake: Perks pill straight after All, one card per perk, status by day', async () => {
  const perks = [perk({ id: 'one', end: '2026-10-01', start: '2026-09-26' }), perk({ id: 'two', ended: 'Sold out' })];
  const dir = sandbox(perks);
  const log = console.log;
  console.log = () => {};
  try {
    await run({ root: dir, bakeOnly: true, dry: false, today: '2026-09-29' });
    let html = readFileSync(path.join(dir, 'creditcards.html'), 'utf8');
    const order = [...html.matchAll(/data-filter="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order.slice(0, 3), ['all', 'perks', 'rarity']);
    assert.match(html, /data-filter="perks"[^>]*aria-controls="perk-list">Perks <span class="cc-filter-n">2<\/span>/);
    assert.match(html, /data-perk="one" data-status="open"/);
    assert.match(html, /data-perk="two" data-status="ended"/);
    assert.match(html, /Know a perk\? DM @jesusdoteth/);
    await run({ root: dir, bakeOnly: true, dry: false, today: '2026-10-02' });
    html = readFileSync(path.join(dir, 'creditcards.html'), 'utf8');
    assert.match(html, /data-perk="one" data-status="ended"/);
    assert.match(html, /Ended 1 Oct 2026/);
  } finally {
    console.log = log;
  }
});

test('bake: no perks, no pill and no view; a bad perk fails the bake', async () => {
  const log = console.log;
  console.log = () => {};
  try {
    const dir = sandbox([]);
    await run({ root: dir, bakeOnly: true, dry: false, today: '2026-09-29' });
    const html = readFileSync(path.join(dir, 'creditcards.html'), 'utf8');
    assert.doesNotMatch(html, /data-filter="perks"/);
    assert.doesNotMatch(html, /id="perk-list"/);
    await assert.rejects(run({ root: sandbox([perk({ type: 'raffle' })]), bakeOnly: true, dry: true }), /type "raffle"/);
  } finally {
    console.log = log;
  }
});
