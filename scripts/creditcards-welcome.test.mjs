// Offline checks for the Credit Cards welcome email: pnpm test
// Covers who gets welcomed, the email itself, the run's retry rules, and the
// webhook handler's signature check with a payload signed by the real Stripe
// SDK. No Stripe API, Resend or network: everything else is injected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import Stripe from 'stripe';
import welcome from '../api/_creditcards-welcome.js';
import handler from '../api/creditcards-welcome.js';

const { SUBJECT, welcomeTarget, onOurPrice, welcomeIdempotencyKey, buildWelcomeHtml, buildWelcomeText, runWelcome } = welcome;

const PRICE = 'price_ALERTS';
const MANAGE = 'https://mooch.agency/api/creditcards-portal?c=cus_TEST123&s=abc';
const NOW = new Date('2026-10-06T07:00:00Z');

// A checkout.session.completed event shaped like Stripe's, 100% code applied.
const event = (session = {}, type = 'checkout.session.completed') => ({
  id: 'evt_1',
  type,
  data: {
    object: {
      id: 'cs_live_1',
      object: 'checkout.session',
      mode: 'subscription',
      payment_status: 'no_payment_required',
      customer: 'cus_TEST123',
      customer_email: 'typed@example.com',
      customer_details: { email: 'Buyer@Example.COM' },
      subscription: 'sub_1',
      ...session,
    },
  },
});
const sub = (over = {}) => ({ id: 'sub_1', status: 'active', items: { data: [{ price: { id: PRICE } }] }, ...over });
const perk = (over = {}) => ({
  id: 'p1', project: 'Futures', x: 'LATE_FX', typeLabel: 'Free mint', status: 'open',
  eligibility: 'Credits holders', description: 'A free 1 of 1 magic 8 ball.',
  url: 'https://laternow.app/futures', post: 'https://x.com/LATE_FX/status/1', start: '2026-09-24', ...over,
});

test('target: a completed subscription Checkout, email from what the buyer typed', () => {
  assert.deepEqual(welcomeTarget(event()), {
    email: 'Buyer@example.com', customerId: 'cus_TEST123', subscriptionId: 'sub_1', sessionId: 'cs_live_1',
  });
  // Falls back to the address the band passed when Checkout has none.
  assert.equal(welcomeTarget(event({ customer_details: null })).email, 'typed@example.com');
  assert.equal(welcomeTarget(event({}, 'invoice.paid')).skip, 'not a completed checkout');
  assert.equal(welcomeTarget(event({ mode: 'payment', subscription: null })).skip, 'not a subscription checkout');
  assert.equal(welcomeTarget(event({ payment_status: 'unpaid' })).skip, 'payment not settled');
  assert.equal(welcomeTarget(event({ customer_details: {}, customer_email: 'nope' })).skip, 'no email or customer');
  assert.equal(welcomeTarget(event({ payment_status: 'paid' })).email, 'Buyer@example.com', 'a full-price sign-up too');
});

test('price gate: only a live subscription on the perk-alert price', () => {
  assert.equal(onOurPrice(sub(), PRICE), true);
  assert.equal(onOurPrice(sub({ status: 'trialing' }), PRICE), true);
  assert.equal(onOurPrice(sub({ items: { data: [{ price: 'price_ALERTS' }] } }), PRICE), true, 'unexpanded price id');
  assert.equal(onOurPrice(sub({ items: { data: [{ price: { id: 'price_OTHER' } }] } }), PRICE), false);
  assert.equal(onOurPrice(sub({ status: 'incomplete' }), PRICE), false);
  assert.equal(onOurPrice(null, PRICE), false);
});

test('idempotency: one key per Checkout session', () => {
  assert.equal(welcomeIdempotencyKey('cs_1'), welcomeIdempotencyKey('cs_1'));
  assert.notEqual(welcomeIdempotencyKey('cs_1'), welcomeIdempotencyKey('cs_2'));
  assert.match(welcomeIdempotencyKey('cs_1'), /^[0-9a-f]{40}$/);
});

test('email: what is open now, what has passed, and the manage links', () => {
  const html = buildWelcomeHtml({ open: [perk()], endedCount: 8, manageUrl: MANAGE, now: NOW });
  assert.match(html, /You're <em style="font-style:italic;">in\.<\/em>/);
  assert.match(html, /Open right now/);
  assert.match(html, /Futures/);
  assert.match(html, /8 perks have already come and gone\./);
  assert.ok(html.includes('https://mooch.agency/api/creditcards-portal?c=cus_TEST123&amp;s=abc'), 'manage link, escaped');
  assert.match(html, /Unsubscribe/);
  assert.doesNotMatch(html, /—|–/, 'no dashes in the copy');

  const none = buildWelcomeHtml({ open: [], endedCount: 1, manageUrl: MANAGE, now: NOW });
  assert.doesNotMatch(none, /Open right now/, 'no empty list');
  assert.match(none, /1 perk has already come and gone\./);

  const evil = buildWelcomeHtml({ open: [perk({ project: '<script>x</script>', url: 'javascript:alert(1)' })], manageUrl: MANAGE, now: NOW });
  assert.doesNotMatch(evil, /<script>/);
  assert.doesNotMatch(evil, /javascript:/);

  const text = buildWelcomeText({ open: [perk()], endedCount: 8, manageUrl: MANAGE });
  assert.match(text, /You're in\./);
  assert.match(text, /Futures \(Free mint\)/);
  assert.match(text, /Manage or unsubscribe: https:\/\/mooch\.agency\/api\/creditcards-portal/);
});

// The run with fakes: what it sends, and when it asks Stripe to retry.
function fakes({ subscription = sub(), result = { ok: true, id: 're_1' } } = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      price: PRICE,
      now: NOW,
      retrieveSubscription: async (id) => { assert.equal(id, 'sub_1'); return subscription; },
      loadPerks: async () => [perk(), perk({ id: 'p2', project: 'Old', status: 'ended' })],
      manageUrlFor: (customerId) => `https://mooch.agency/api/creditcards-portal?c=${customerId}&s=abc`,
      send: async (msg) => { sent.push(msg); return result; },
    },
  };
}

test('run: one email to the buyer, keyed on the session', async () => {
  const { sent, deps } = fakes();
  const r = await runWelcome({ event: event(), ...deps });
  assert.deepEqual(r, { ok: true, sent: true, deduped: false, open: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'Buyer@example.com');
  assert.equal(sent[0].subject, SUBJECT);
  assert.equal(sent[0].idempotencyKey, welcomeIdempotencyKey('cs_live_1'));
  assert.equal(sent[0].manageUrl, 'https://mooch.agency/api/creditcards-portal?c=cus_TEST123&s=abc');
  assert.match(sent[0].html, /1 perk has already come and gone/);
  assert.doesNotMatch(sent[0].html, />Old</, 'ended perks are counted, not listed');
});

test('run: skips other events and other prices without sending', async () => {
  const a = fakes();
  assert.equal((await runWelcome({ event: event({}, 'customer.created'), ...a.deps })).skipped, 'not a completed checkout');
  const b = fakes({ subscription: sub({ items: { data: [{ price: { id: 'price_CONSULTING' } }] } }) });
  assert.equal((await runWelcome({ event: event(), ...b.deps })).skipped, 'not a live perk-alert subscription');
  assert.equal(a.sent.length + b.sent.length, 0);
});

test('run: a bad address is final, a Resend outage asks Stripe to retry', async () => {
  const bad = fakes({ result: { ok: false, perRecipient: true, error: 'Resend responded 422' } });
  assert.deepEqual(await runWelcome({ event: event(), ...bad.deps }), { ok: false, retry: false, error: 'Resend responded 422' });
  const down = fakes({ result: { ok: false, perRecipient: false, error: 'Resend responded 503' } });
  assert.equal((await runWelcome({ event: event(), ...down.deps })).retry, true);
  const dup = fakes({ result: { ok: true, deduped: true } });
  assert.equal((await runWelcome({ event: event(), ...dup.deps })).deduped, true);
});

// The handler, end to end up to the Stripe API: a payload signed exactly as
// Stripe signs it. An event type the run ignores keeps it off the network.
function call({ method = 'POST', body = '', signature } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.headers = signature === undefined ? {} : { 'stripe-signature': signature };
  const res = { statusCode: 0, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.body = b; return res; };
  return handler(req, res).then(() => res);
}

test('handler: verifies the Stripe signature before anything else', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', STRIPE_PRICE_ID: PRICE });
    const payload = JSON.stringify(event({}, 'invoice.paid'));
    const stripe = new Stripe('sk_test_fake');
    const good = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
    const forged = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_someone_else' });

    const ok = await call({ body: payload, signature: good });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.skipped, 'not a completed checkout');

    assert.equal((await call({ body: payload, signature: forged })).statusCode, 400);
    assert.equal((await call({ body: payload })).statusCode, 400, 'no signature');
    assert.equal((await call({ body: payload.replace('evt_1', 'evt_2'), signature: good })).statusCode, 400, 'tampered body');
    assert.equal((await call({ method: 'GET' })).statusCode, 405);

    delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal((await call({ body: payload, signature: good })).statusCode, 503, 'unset secret: Stripe keeps the event');
  } finally {
    process.env = saved;
  }
});
