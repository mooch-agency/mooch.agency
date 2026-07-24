// Tests for the thin-text / bot-block fallback (Phase 4 pre-launch gate).
// No browser, no network: a scripted fetcher hands back canned pages.
//   node --test scripts/page-fallback.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THIN_CHARS, unusable, fetchWithRetry, resolveWithSwaps } from './page-fallback.mjs';

const body = (n = 600) => 'Real page copy about our plumbing services. '.repeat(Math.ceil(n / 44)).slice(0, n);
const page = (url, text) => ({ url, title: 'T', text, links: [] });
const good = (url) => page(url, body());

// Records call order so the tests can assert the retry and the swap sequence.
function scriptedFetcher(script) {
  const calls = [];
  const fetchOne = async (url) => {
    calls.push(url);
    const entry = script[url];
    const seen = calls.filter((c) => c === url).length;
    const result = Array.isArray(entry) ? entry[Math.min(seen - 1, entry.length - 1)] : entry;
    return result ?? page(url, '');
  };
  return { fetchOne, calls };
}

test('unusable: classifies the four failure shapes', () => {
  assert.equal(unusable(null), true, 'missing page');
  assert.equal(unusable({ url: 'u', text: '', error: 'Timeout' }), true, 'fetch error');
  assert.equal(unusable(page('u', 'x'.repeat(THIN_CHARS - 1))), true, 'thin text');
  assert.equal(unusable(page('u', 'Verify you are human before continuing. ' + body())), true, 'bot challenge');
  assert.equal(unusable(good('u')), false, 'real page');
});

test('unusable: a challenge phrase deep in a long page is not a false positive', () => {
  // Only the first 1500 chars are scanned, so a page that merely mentions
  // "captcha" in its body copy stays usable.
  const p = page('u', body(2000) + ' we hate captcha forms');
  assert.equal(unusable(p), false);
});

test('fetchWithRetry: retries once and takes the better second load', async () => {
  const { fetchOne, calls } = scriptedFetcher({ 'https://a/x': [page('https://a/x', ''), good('https://a/x')] });
  const p = await fetchWithRetry(fetchOne, 'https://a/x', { settleMs: 0 });
  assert.equal(unusable(p), false);
  assert.deepEqual(calls, ['https://a/x', 'https://a/x'], 'exactly one retry');
});

test('fetchWithRetry: no retry when the first load is fine', async () => {
  const { fetchOne, calls } = scriptedFetcher({ 'https://a/x': good('https://a/x') });
  await fetchWithRetry(fetchOne, 'https://a/x', { settleMs: 0 });
  assert.equal(calls.length, 1);
});

test('fetchWithRetry: keeps the first result when the retry is no better', async () => {
  const first = { url: 'https://a/x', text: '', error: 'Timeout' };
  const { fetchOne } = scriptedFetcher({ 'https://a/x': [first, page('https://a/x', '')] });
  const p = await fetchWithRetry(fetchOne, 'https://a/x', { settleMs: 0 });
  assert.equal(p.error, 'Timeout', 'original error survives for the coverage note');
});

test('resolveWithSwaps: bot-blocked pick is swapped for the next-priority page + coverage note', async () => {
  const blocked = page('https://a/pricing', 'Checking your browser before accessing.');
  const { fetchOne, calls } = scriptedFetcher({
    'https://a/about': good('https://a/about'),
    'https://a/faq': good('https://a/faq'),
  });
  const fallbackPool = ['https://a/about', 'https://a/faq'];
  const { good: pages, notes } = await resolveWithSwaps({
    initial: [good('https://a/services'), blocked],
    fallbackPool,
    fetchOne,
    settleMs: 0,
  });
  assert.deepEqual(pages.map((p) => p.url), ['https://a/services', 'https://a/about']);
  assert.deepEqual(notes, ['https://a/pricing was unreadable (bot-block or empty); audited https://a/about instead']);
  assert.deepEqual(calls, ['https://a/about'], 'takes the highest-priority substitute first');
  assert.deepEqual(fallbackPool, ['https://a/faq'], 'consumed substitute cannot be reused');
});

test('resolveWithSwaps: skips unreadable substitutes until one works', async () => {
  const { fetchOne } = scriptedFetcher({
    'https://a/about': page('https://a/about', ''),
    'https://a/faq': good('https://a/faq'),
  });
  const { good: pages, notes } = await resolveWithSwaps({
    initial: [page('https://a/pricing', '')],
    fallbackPool: ['https://a/about', 'https://a/faq'],
    fetchOne,
    settleMs: 0,
  });
  assert.deepEqual(pages.map((p) => p.url), ['https://a/faq']);
  assert.match(notes[0], /audited https:\/\/a\/faq instead/);
});

test('resolveWithSwaps: empty pool records the skip rather than dropping it silently', async () => {
  const { fetchOne } = scriptedFetcher({});
  const { good: pages, notes } = await resolveWithSwaps({
    initial: [page('https://a/pricing', '')],
    fallbackPool: [],
    fetchOne,
    settleMs: 0,
  });
  assert.deepEqual(pages, []);
  assert.deepEqual(notes, ['https://a/pricing was unreadable and no readable substitute was available']);
});

test('resolveWithSwaps: all-readable picks produce no notes and no extra fetches', async () => {
  const { fetchOne, calls } = scriptedFetcher({});
  const { good: pages, notes } = await resolveWithSwaps({
    initial: [good('https://a/1'), good('https://a/2')],
    fallbackPool: ['https://a/3'],
    fetchOne,
    settleMs: 0,
  });
  assert.equal(pages.length, 2);
  assert.deepEqual(notes, []);
  assert.deepEqual(calls, []);
});
