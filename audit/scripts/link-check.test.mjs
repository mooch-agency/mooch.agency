// Item 3 (recall-gap ticket): a dead domain is reportable.
// statusOf used to catch every fetch failure as a generic 'error', and only
// 404/410 were reportable, so an NXDOMAIN link (the apexvolumetrics hero CTA)
// landed in `unreachable` and was never shown to anyone. ENOTFOUND is
// deterministic evidence the domain does not exist; EAI_AGAIN and timeouts are
// transient and stay unreportable. One retry before concluding, because a
// single resolver blip must not become a client-facing claim.
//   node --test scripts/link-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusOfFactory, REPORTABLE } from './link-check.mjs';

// A stub fetch that fails with a given DNS error code, or returns a status.
const failWith = (code) => async () => { const e = new Error('fetch failed'); e.cause = { code }; throw e; };
const okWith = (status) => async () => ({ status });

test('ENOTFOUND twice is a dead domain, and dead domains are reportable', async () => {
  const statusOf = statusOfFactory(failWith('ENOTFOUND'));
  assert.equal(await statusOf('https://www.quiz.example.com//default'), 'dead_domain');
  assert.ok(REPORTABLE.has('dead_domain'));
});

test('ENOTFOUND retries once: a one-off resolver blip is not a dead domain', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
    return { status: 200 };
  };
  const statusOf = statusOfFactory(flaky);
  assert.equal(await statusOf('https://example.com/'), 200);
  assert.equal(calls, 2);
});

test('EAI_AGAIN and timeouts stay a generic error, never reportable', async () => {
  assert.equal(await statusOfFactory(failWith('EAI_AGAIN'))('https://example.com/'), 'error');
  const timeout = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  assert.equal(await statusOfFactory(timeout)('https://example.com/'), 'error');
  assert.ok(!REPORTABLE.has('error'));
});

test('HTTP statuses pass through, and only 404/410 of them are reportable', async () => {
  const statusOf = statusOfFactory(okWith(404));
  assert.equal(await statusOf('https://example.com/gone'), 404);
  assert.ok(REPORTABLE.has(404) && REPORTABLE.has(410));
  assert.ok(!REPORTABLE.has(403) && !REPORTABLE.has(500) && !REPORTABLE.has(200));
});

test('results are memoised per URL, including dead domains', async () => {
  let calls = 0;
  const counting = async () => { calls++; const e = new Error('x'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  const statusOf = statusOfFactory(counting);
  await statusOf('https://a.example/');
  await statusOf('https://a.example/');
  assert.equal(calls, 2, 'one probe plus its single retry, then cached');
});
