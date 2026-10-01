// Offline checks for the Credit Cards paid perk alerts: pnpm test
// Covers perk selection, the subject line, the email's HTML shape, the run's
// state rules, and the shared helpers (email syntax, signed portal links,
// the cron auth). No Stripe, Resend or Blob: every side effect in runDigest
// is injected, so none of this needs a key or the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import digest from '../api/_creditcards-digest.js';
import shared from '../api/_creditcards.js';
import handler from '../api/creditcards-digest.js';
import subscribe from '../api/creditcards-subscribe.js';
import { perkStatus } from './creditcards-perks.mjs';

const {
  selectNew, buildSubject, buildEmailHtml, buildEmailText, idempotencyKey, when, mergeState, runDigest,
} = digest;
const { normaliseEmail, signCustomer, verifyCustomer, portalUrl } = shared;
const { isAuthorized, blobStoreId, scrubSecrets, makeSender, loadPerks } = handler.__testables;
const { checkoutParams, returnIndexUrl, hasStandingOrder } = subscribe.__testables;

const NOW = new Date('2026-10-01T07:00:00Z');
const MANAGE = 'https://mooch.agency/api/creditcards-portal?c=cus_TEST123&s=abc';

// A perk as the handler hands it over: the data fields plus status and label.
const perk = (over = {}) => ({
  id: 'p1',
  project: 'Futures',
  x: 'LATE_FX',
  type: 'free-mint',
  typeLabel: 'Free mint',
  status: 'open',
  eligibility: 'Credits holders, one per Credit',
  description: 'A free 1 of 1 magic 8 ball for each Credit you hold.',
  url: 'https://laternow.app/futures',
  post: 'https://x.com/LATE_FX/status/1',
  start: '2026-09-24',
  ...over,
});

test('selection: unsent and not ended; open first, then unknown, then by start', () => {
  const perks = [
    perk({ id: 'u', project: 'Unknown', status: 'unknown', start: '2026-09-20' }),
    perk({ id: 'b', project: 'Beta', start: '2026-09-30' }),
    perk({ id: 'a', project: 'Alpha', start: '2026-09-29' }),
    perk({ id: 'sent', start: '2026-09-01' }),
    perk({ id: 'gone', status: 'ended' }),
  ];
  assert.deepEqual(selectNew(perks, ['sent']).map((p) => p.id), ['a', 'b', 'u']);
  assert.deepEqual(selectNew(perks, ['a', 'b', 'u', 'sent']), []);
  assert.deepEqual(selectNew([], undefined), []);
});

test('the handler decorates the real feed with the page\'s own status rule', async () => {
  const perks = await loadPerks(NOW);
  assert.ok(perks.length > 0);
  for (const p of perks) {
    assert.equal(p.status, perkStatus(p, '2026-10-01'), p.id);
    assert.ok(p.typeLabel, `${p.id} has a type label`);
  }
});

test('subject pluralises', () => {
  assert.equal(buildSubject([perk()]), '1 new perk for Credits holders');
  assert.equal(buildSubject([perk(), perk({ id: 'p2' })]), '2 new perks for Credits holders');
});

test('dates: an end still ahead, or a start not reached yet', () => {
  assert.equal(when(perk({ end: '2026-10-03' }), NOW), 'Until 3 Oct');
  assert.equal(when(perk({ start: '2026-10-05', status: 'unknown' }), NOW), 'From 5 Oct');
  assert.equal(when(perk(), NOW), '');
});

test('email HTML: header, items, pips, links, footer', () => {
  const items = [perk({ end: '2026-10-03' }), perk({ id: 'p2', project: 'Debits', type: 'airdrop', typeLabel: 'Airdrop' })];
  const html = buildEmailHtml(items, { now: NOW, manageUrl: MANAGE });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Credit Cards &middot; Perk alert &middot; 1 October 2026/);
  assert.match(html, /2 new <em[^>]*>perks\.<\/em>/);
  // Four CMYK pips per item.
  for (const c of ['#00aeef', '#ec008c', '#fff200', '#1a1a1a']) {
    assert.equal(html.split(`background:${c};`).length - 1, items.length, `pip ${c}`);
  }
  assert.match(html, />Free mint</);
  assert.match(html, />Airdrop</);
  assert.match(html, /For<\/span>Credits holders, one per Credit/);
  assert.match(html, /Until 3 Oct &middot; By @LATE_FX &middot; <a href="https:\/\/x\.com\/LATE_FX\/status\/1"[^>]*>The announcement &rarr;<\/a>/);
  assert.match(html, /Check the builder's own post before you connect a wallet/);
  assert.match(html, /no sponsors in the email, ever\. Reply and a human answers\./);
  assert.doesNotMatch(html, /7am|7 am/, 'no time of day promised');
  // Manage and Unsubscribe both go to this recipient's signed portal link.
  const manage = MANAGE.replace(/&/g, '&amp;');
  assert.match(html, new RegExp(`href="${manage.replace(/[.?]/g, '\\$&')}"[^>]*>Manage</a>`));
  assert.match(html, new RegExp(`href="${manage.replace(/[.?]/g, '\\$&')}"[^>]*>Unsubscribe</a>`));
  assert.match(html, /href="https:\/\/mooch\.agency\/creditcards#perks"[^>]*>See every perk &rarr;<\/a>/);
  assert.match(html, /href="https:\/\/mooch\.agency\/creditcards#perks"[^>]*>All perks<\/a>/);
  assert.doesNotMatch(html, /—/, 'no em dashes');
});

test('email HTML: singular heading, and no announcement link when there is no post', () => {
  const html = buildEmailHtml([perk({ post: undefined })], { now: NOW, manageUrl: MANAGE });
  assert.match(html, /1 new <em[^>]*>perk\.<\/em>/);
  assert.doesNotMatch(html, /The announcement/);
  assert.match(html, /By @LATE_FX/);
});

test('email HTML escapes data and refuses non-http links', () => {
  const evil = perk({
    project: '<script>alert(1)</script>',
    description: 'Tom & "Jerry" <b>',
    x: 'x"><img src=x>',
    url: 'javascript:alert(1)',
    post: 'data:text/html,hi',
  });
  const html = buildEmailHtml([evil], { now: NOW, manageUrl: MANAGE });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Tom &amp; &quot;Jerry&quot; &lt;b&gt;/);
  assert.doesNotMatch(html, /javascript:|data:text/);
});

test('email text part carries the items and both links', () => {
  const text = buildEmailText([perk()], { now: NOW, manageUrl: MANAGE });
  assert.match(text, /1 new perk for Credits holders\./);
  assert.match(text, /Futures \(Free mint\)/);
  assert.match(text, /For: Credits holders, one per Credit/);
  assert.match(text, /https:\/\/laternow\.app\/futures/);
  assert.ok(text.includes(`Manage or unsubscribe: ${MANAGE}`));
});

test('idempotency key: order-blind, per recipient, per item set', () => {
  const a = perk({ id: 'a' });
  const b = perk({ id: 'b' });
  assert.equal(idempotencyKey('x@y.com', [a, b]), idempotencyKey('x@y.com', [b, a]));
  assert.notEqual(idempotencyKey('x@y.com', [a, b]), idempotencyKey('z@y.com', [a, b]));
  assert.notEqual(idempotencyKey('x@y.com', [a]), idempotencyKey('x@y.com', [a, b]));
  assert.match(idempotencyKey('x@y.com', [a]), /^[0-9a-f]{40}$/);
});

test('state merge is a union', () => {
  const s = mergeState({ sentIds: ['b', 'a'] }, ['c', 'a'], NOW);
  assert.deepEqual(s.sentIds, ['a', 'b', 'c']);
  assert.equal(s.updatedAt, NOW.toISOString());
  assert.deepEqual(mergeState(null, ['x'], NOW).sentIds, ['x']);
});

// A fake world for runDigest: an in-memory state store and a recording sender.
// failFor: per-recipient failures (Resend 4xx). infraFor: pipe failures (5xx).
function world({ perks, state, recipients = [], failFor = [], infraFor = [] }) {
  const w = { state, sends: [], recipientCalls: 0 };
  w.deps = {
    now: NOW,
    loadPerks: async () => perks,
    loadState: async () => w.state,
    saveState: async (merge) => { w.state = merge(w.state); },
    listRecipients: async () => { w.recipientCalls++; return recipients; },
    manageUrlFor: (r) => `https://mooch.agency/api/creditcards-portal?c=${r.customerId}&s=sig`,
    send: async (msg) => {
      w.sends.push(msg);
      if (failFor.includes(msg.to)) return { ok: false, perRecipient: true, error: 'Resend responded 422' };
      if (infraFor.includes(msg.to)) return { ok: false, error: 'Resend responded 500' };
      return { ok: true, id: 'em_1' };
    },
  };
  return w;
}

test('run: first run seeds state and emails nobody', async () => {
  const w = world({ perks: [perk({ id: 'a' }), perk({ id: 'b', status: 'ended' })], state: null, recipients: [{ email: 'x@y.com', customerId: 'cus_1' }] });
  const r = await runDigest(w.deps);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(w.sends.length, 0);
  assert.equal(w.recipientCalls, 0);
  assert.deepEqual(w.state.sentIds, ['a', 'b']);
});

test('run: nothing new is silent', async () => {
  const w = world({ perks: [perk({ id: 'a' })], state: { sentIds: ['a'] }, recipients: [{ email: 'x@y.com', customerId: 'cus_1' }] });
  const r = await runDigest(w.deps);
  assert.deepEqual([r.ok, r.skipped, r.reason], [true, true, 'nothing new']);
  assert.equal(w.sends.length, 0);
  assert.equal(w.recipientCalls, 0);
});

test('run: no recipients still advances state (no backlog for subscriber one)', async () => {
  const w = world({ perks: [perk({ id: 'a' }), perk({ id: 'b' })], state: { sentIds: ['a'] }, recipients: [] });
  const r = await runDigest(w.deps);
  assert.deepEqual([r.ok, r.skipped, r.reason], [true, true, 'no recipients']);
  assert.deepEqual(w.state.sentIds, ['a', 'b']);
});

test('run: one email per recipient, then state', async () => {
  const recipients = [{ email: 'x@y.com', customerId: 'cus_1' }, { email: 'z@y.com', customerId: 'cus_2' }];
  const w = world({ perks: [perk({ id: 'a' }), perk({ id: 'b' }), perk({ id: 'c' })], state: { sentIds: ['a'] }, recipients });
  const r = await runDigest(w.deps);
  assert.deepEqual([r.ok, r.newCount, r.sent, r.failed], [true, 2, 2, 0]);
  assert.deepEqual(w.sends.map((m) => m.to), ['x@y.com', 'z@y.com']);
  assert.equal(w.sends[0].subject, '2 new perks for Credits holders');
  assert.match(w.sends[0].html, /c=cus_1/);
  assert.match(w.sends[1].html, /c=cus_2/);
  assert.equal(w.sends[0].manageUrl, 'https://mooch.agency/api/creditcards-portal?c=cus_1&s=sig');
  assert.notEqual(w.sends[0].idempotencyKey, w.sends[1].idempotencyKey);
  assert.deepEqual(w.state.sentIds, ['a', 'b', 'c']);
});

test('run: a per-recipient failure still advances state, and is counted', async () => {
  const recipients = [{ email: 'x@y.com', customerId: 'cus_1' }, { email: 'bad@y.com', customerId: 'cus_2' }];
  const w = world({ perks: [perk({ id: 'a' }), perk({ id: 'b' })], state: { sentIds: ['a'] }, recipients, failFor: ['bad@y.com'] });
  const r = await runDigest(w.deps);
  assert.deepEqual([r.ok, r.sent, r.failed, r.failedRecipients], [true, 1, 1, 1]);
  assert.deepEqual(w.state.sentIds, ['a', 'b']);
});

test('run: an infrastructure failure leaves state alone so the items go again', async () => {
  const recipients = [{ email: 'x@y.com', customerId: 'cus_1' }, { email: 'down@y.com', customerId: 'cus_2' }];
  const w = world({ perks: [perk({ id: 'a' }), perk({ id: 'b' })], state: { sentIds: ['a'] }, recipients, infraFor: ['down@y.com'] });
  const r = await runDigest(w.deps);
  assert.deepEqual([r.ok, r.sent, r.failed, r.failedRecipients], [false, 1, 1, 0]);
  assert.deepEqual(w.state.sentIds, ['a']);
});

test('run: every send failing withholds state, even when each looks per-recipient', async () => {
  const recipients = [{ email: 'x@y.com', customerId: 'cus_1' }, { email: 'z@y.com', customerId: 'cus_2' }];
  const w = world({ perks: [perk({ id: 'a' }), perk({ id: 'b' })], state: { sentIds: ['a'] }, recipients, failFor: ['x@y.com', 'z@y.com'] });
  const r = await runDigest(w.deps);
  assert.deepEqual([r.ok, r.sent, r.failedRecipients], [false, 0, 2]);
  assert.deepEqual(w.state.sentIds, ['a']);
});

test('run: a failed recipient fetch throws and leaves state alone', async () => {
  const w = world({ perks: [perk({ id: 'a' }), perk({ id: 'b' })], state: { sentIds: ['a'] } });
  w.deps.listRecipients = async () => { throw new Error('Stripe down'); };
  await assert.rejects(runDigest(w.deps), /Stripe down/);
  assert.deepEqual(w.state.sentIds, ['a']);
});

test('email syntax', () => {
  assert.equal(normaliseEmail('  Jo.Bloggs+cc@Example.CO.uk '), 'Jo.Bloggs+cc@example.co.uk');
  for (const bad of ['', 'nope', 'a@b', 'a@localhost', '@x.com', 'a@', 'a b@x.com', '.a@x.com', 'a..b@x.com', 'a@-x.com', 'a@1.2.3.4', null, undefined, `${'a'.repeat(65)}@x.com`]) {
    assert.equal(normaliseEmail(bad), null, String(bad));
  }
});

test('signed portal links verify, forgeries do not', () => {
  const secret = 'sk_test_fake';
  const sig = signCustomer('cus_ABC123', secret);
  assert.match(sig, /^[0-9a-f]{32}$/);
  assert.equal(verifyCustomer('cus_ABC123', sig, secret), true);
  assert.equal(verifyCustomer('cus_ABC124', sig, secret), false);
  assert.equal(verifyCustomer('cus_ABC123', sig, 'sk_test_other'), false);
  assert.equal(verifyCustomer('cus_ABC123', sig.slice(0, 31), secret), false);
  assert.equal(verifyCustomer('cus_ABC123', sig, undefined), false);
  const u = new URL(portalUrl('cus_ABC123', secret));
  assert.equal(u.origin + u.pathname, 'https://mooch.agency/api/creditcards-portal');
  assert.equal(verifyCustomer(u.searchParams.get('c'), u.searchParams.get('s'), secret), true);
});

test('cron auth needs the exact bearer secret', () => {
  const req = (authorization) => ({ headers: authorization ? { authorization } : {} });
  assert.equal(isAuthorized(req('Bearer s3cret'), 's3cret'), true);
  assert.equal(isAuthorized(req('Bearer s3cres'), 's3cret'), false);
  assert.equal(isAuthorized(req('Bearer s3cret!'), 's3cret'), false);
  assert.equal(isAuthorized(req('s3cret'), 's3cret'), false);
  assert.equal(isAuthorized(req(), 's3cret'), false);
  assert.equal(isAuthorized(req('Bearer '), ''), false);
  assert.equal(isAuthorized(req('Bearer undefined'), undefined), false);
});

// The sender against a stubbed fetch: a 409 (key already used, or in flight)
// counts as delivered, a 422 is a real failure with the address scrubbed.
test('sender: 409 is already sent, 4xx is per-recipient without the address, 5xx is not', async () => {
  const realFetch = globalThis.fetch;
  const msg = { to: 'x@y.com', subject: 's', html: 'h', text: 't', manageUrl: MANAGE, idempotencyKey: 'k' };
  try {
    globalThis.fetch = async () => new Response('{"name":"invalid_idempotent_request"}', { status: 409 });
    assert.deepEqual(await makeSender('re_fake')(msg), { ok: true, deduped: true });
    globalThis.fetch = async () => new Response('Invalid `to` field: x@y.com', { status: 422 });
    const r = await makeSender('re_fake')(msg);
    assert.equal(r.ok, false);
    assert.equal(r.perRecipient, true);
    assert.match(r.error, /^Resend responded 422/);
    assert.doesNotMatch(r.error, /x@y\.com/);
    globalThis.fetch = async () => new Response('oops', { status: 503 });
    const down = await makeSender('re_fake')(msg);
    assert.deepEqual([down.ok, down.perRecipient], [false, false]);
    // A 429 that survives the retry is the shared Resend quota, not this
    // address: it must withhold state like a 5xx, or everyone after it
    // silently loses the day's items.
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('quota', { status: 429 }); };
    const quota = await makeSender('re_fake')(msg);
    assert.equal(calls, 2);
    assert.deepEqual([quota.ok, quota.perRecipient], [false, false]);
    assert.match(quota.error, /^Resend responded 429/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('checkout: paid up front, no trial', () => {
  const p = checkoutParams('jo@x.com', 'price_1');
  assert.equal(p.mode, 'subscription');
  assert.deepEqual(p.line_items, [{ price: 'price_1', quantity: 1 }]);
  assert.equal(p.customer_email, 'jo@x.com');
  assert.equal(p.subscription_data, undefined);
  assert.doesNotMatch(JSON.stringify(p), /trial/);
  assert.equal(p.success_url, 'https://mooch.agency/creditcards?subscribed=1');
  assert.equal(p.cancel_url, 'https://mooch.agency/creditcards');
  assert.equal(p.allow_promotion_codes, true);
});

test('checkout returns to the preview or dev server that opened it, else production', () => {
  assert.equal(returnIndexUrl('http://localhost:3000'), 'http://localhost:3000/creditcards');
  assert.equal(returnIndexUrl('https://mooch-agency-git-x-gichigi.vercel.app'), 'https://mooch-agency-git-x-gichigi.vercel.app/creditcards');
  assert.equal(returnIndexUrl('https://mooch.agency'), 'https://mooch.agency/creditcards');
  assert.equal(returnIndexUrl('https://evil.example'), 'https://mooch.agency/creditcards');
  assert.equal(returnIndexUrl('not a url'), 'https://mooch.agency/creditcards');
});

// A fake Stripe holding customers by exact email and subscriptions by customer.
function fakeStripe(customers, subs) {
  const calls = [];
  return {
    calls,
    customers: { list: async ({ email }) => { calls.push(email); return { data: customers.filter((c) => c.email === email) }; } },
    subscriptions: {
      list: async ({ customer, price }) => ({ data: subs.filter((s) => s.customer === customer && s.price === price) }),
    },
  };
}

test('already subscribed: live sub on our price blocks a second Checkout', async () => {
  const customers = [{ id: 'cus_1', email: 'jo@x.com' }, { id: 'cus_2', email: 'old@x.com' }, { id: 'cus_3', email: 'other@x.com' }];
  const subs = [
    { customer: 'cus_1', price: 'price_1', status: 'active' },
    { customer: 'cus_2', price: 'price_1', status: 'past_due' },
    { customer: 'cus_3', price: 'price_OTHER', status: 'active' },
  ];
  assert.equal(await hasStandingOrder(fakeStripe(customers, subs), 'jo@x.com', 'price_1'), true);
  assert.equal(await hasStandingOrder(fakeStripe(customers, subs), 'old@x.com', 'price_1'), false, 'past_due is not a standing order');
  assert.equal(await hasStandingOrder(fakeStripe(customers, subs), 'other@x.com', 'price_1'), false, 'other prices do not count');
  assert.equal(await hasStandingOrder(fakeStripe(customers, subs), 'new@x.com', 'price_1'), false);
  // Stripe's email filter is case-sensitive: a mixed-case entry also tries lowercase.
  const s = fakeStripe(customers, subs);
  assert.equal(await hasStandingOrder(s, 'Jo@x.com', 'price_1'), true);
  assert.deepEqual(s.calls, ['Jo@x.com', 'jo@x.com']);
});

test('blob store id and secret scrubbing', () => {
  assert.equal(blobStoreId('vercel_blob_rw_FAKESTORE_notasecret'), 'FAKESTORE');
  assert.equal(scrubSecrets('Invalid API Key provided: sk_test_****abcd'), 'Invalid API Key provided: [key]');
  assert.equal(scrubSecrets('token vercel_blob_rw_FAKE_x leaked'), 'token [key] leaked');
});
