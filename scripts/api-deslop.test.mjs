// Unit tests for api/deslop.js's payment states. They live in scripts/, not
// api/, because Vercel deploys every file under api/ as an endpoint.
//
// The handler exposes its collaborators on module.exports.deps precisely so
// these tests can drive every payment exit (challenge, bad body, facilitator
// outage, invalid payment, clean decline, ambiguous settle, success) with no
// facilitator, no wallet and no model call. Production never touches deps.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/deslop.js';

const { deps } = handler;
const originals = { ...deps };
afterEach(() => { Object.assign(deps, originals); });

process.env.X402_PAY_TO = '0x1111111111111111111111111111111111111111';
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.DESLOP_KILL;

// Fresh IP per request keeps the per-IP rate limiter out of the way; fresh
// nonce per test keeps the module-level nonce map from coupling tests.
let ipCounter = 0;
let nonceCounter = 0;
const nextIp = () => `10.0.0.${++ipCounter}`;
const nextNonce = () => `0xnonce${++nonceCounter}`;

function fakeReq({ body, payment } = {}) {
  const headers = { 'x-forwarded-for': nextIp() };
  if (payment !== undefined) headers['x-payment'] = payment;
  return { method: 'POST', headers, body };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
}

// Stub every external collaborator; override per test as needed.
function stub({ nonce = nextNonce(), verify, settle, run } = {}) {
  deps.decodePayment = () => ({
    scheme: 'exact',
    network: 'base-sepolia',
    payload: { authorization: { nonce, from: '0xpayer' } },
  });
  deps.findMatchingPaymentRequirements = (accepts) => accepts[0];
  deps.useFacilitator = () => ({
    verify: verify || (async () => ({ isValid: true })),
    settle: settle || (async () => ({ success: true })),
  });
  deps.runDeslop = run || (async () => ({ cleaned: 'clean text', changelog: 'tightened' }));
  deps.settleResponseHeader = () => 'encoded-settlement';
  return nonce;
}

const GOOD_BODY = { text: 'Three plain words' };

test('no X-PAYMENT header: 402 challenge with accepts', async () => {
  const res = fakeRes();
  await handler(fakeReq({ body: GOOD_BODY }), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.x402Version, 1);
  assert.ok(Array.isArray(res.body.accepts) && res.body.accepts.length === 1);
  assert.equal(res.body.accepts[0].payTo, process.env.X402_PAY_TO);
});

test('invalid body: 400 before the facilitator is ever constructed', async () => {
  stub();
  let facilitatorCalls = 0;
  const orig = deps.useFacilitator;
  deps.useFacilitator = (...a) => { facilitatorCalls++; return orig(...a); };
  const res = fakeRes();
  await handler(fakeReq({ body: { text: '' }, payment: 'p' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(facilitatorCalls, 0);
});

test('over the word cap: 400 before the facilitator is ever constructed', async () => {
  stub();
  let facilitatorCalls = 0;
  const orig = deps.useFacilitator;
  deps.useFacilitator = (...a) => { facilitatorCalls++; return orig(...a); };
  const res = fakeRes();
  const long = Array(2001).fill('word').join(' ');
  await handler(fakeReq({ body: { text: long }, payment: 'p' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Too long/);
  assert.equal(facilitatorCalls, 0);
});

test('verify throws: 503 outage, not 402, and the nonce is released', async () => {
  const nonce = stub({ verify: async () => { throw new Error('facilitator down'); } });
  const res = fakeRes();
  await handler(fakeReq({ body: GOOD_BODY, payment: 'p' }), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /verification unavailable/i);

  // Released: the same nonce goes through cleanly on retry.
  stub({ nonce });
  const retry = fakeRes();
  await handler(fakeReq({ body: GOOD_BODY, payment: 'p' }), retry);
  assert.equal(retry.statusCode, 200);
});

test('verify says invalid: 402 with the reason', async () => {
  stub({ verify: async () => ({ isValid: false, invalidReason: 'insufficient_funds' }) });
  const res = fakeRes();
  await handler(fakeReq({ body: GOOD_BODY, payment: 'p' }), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'insufficient_funds');
});

test('clean settle decline: 402, output discarded, nonce released', async () => {
  const nonce = stub({ settle: async () => ({ success: false, errorReason: 'already_spent' }) });
  const res = fakeRes();
  await handler(fakeReq({ body: GOOD_BODY, payment: 'p' }), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.error, 'already_spent');
  assert.equal(res.body.cleaned, undefined);

  // Released: the same nonce succeeds on retry.
  stub({ nonce });
  const retry = fakeRes();
  await handler(fakeReq({ body: GOOD_BODY, payment: 'p' }), retry);
  assert.equal(retry.statusCode, 200);
});

test('thrown settle: 200 with the paid output, flagged uncertain, nonce kept', async () => {
  const nonce = stub({ settle: async () => { throw new Error('rpc timeout'); } });
  const res = fakeRes();
  await handler(fakeReq({ body: GOOD_BODY, payment: 'p' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settlement_uncertain, true);
  assert.equal(res.body.cleaned, 'clean text');
  assert.equal(res.body.changelog, 'tightened');
  assert.equal(res.headers['x-payment-response'], undefined);

  // Kept claimed: replaying the same header is refused outright.
  stub({ nonce });
  const replay = fakeRes();
  await handler(fakeReq({ body: GOOD_BODY, payment: 'p' }), replay);
  assert.equal(replay.statusCode, 402);
  assert.match(replay.body.error, /already used or in progress/);
});

test('successful settle: 200 with X-PAYMENT-RESPONSE and no uncertain flag', async () => {
  stub();
  const res = fakeRes();
  await handler(fakeReq({ body: GOOD_BODY, payment: 'p' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-payment-response'], 'encoded-settlement');
  assert.equal(res.body.cleaned, 'clean text');
  assert.equal(res.body.words_in, 3);
  assert.equal(res.body.settlement_uncertain, undefined);
});
