// Unit tests for api/_guard.js and api/_notion.js, and for the admission
// behaviour of the endpoints that use them. They live in scripts/, not api/,
// because Vercel deploys every file under api/ as an endpoint.
//
// What each block pins:
//   - the two-phase limiter: a rejected request no longer consumes quota,
//     and committed hits still cap
//   - a Notion timeout answers 504 (try again), a refusal stays 502
//   - a replayed idempotency key finds the first row instead of duplicating
//   - the shared MX check fails open on transient resolver trouble and
//     closed only on a definitive negative
//   - the unified order: method answers before the kill switch
//   - the table test: every endpoint in api/ goes through the guard

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeLimiter, hasMailExchanger } from '../api/_guard.js';
import { timeoutError } from '../api/_notion.js';
import feedback from '../api/feedback.js';
import audit from '../api/audit.js';
import axbeatLead from '../api/axbeat-lead.js';

const apiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');

process.env.NOTION_TOKEN = 'test-token';

const feedbackOriginals = { ...feedback.deps };
const auditOriginals = { ...audit.deps };
const axbeatOriginals = { ...axbeatLead.deps };
afterEach(() => {
  Object.assign(feedback.deps, feedbackOriginals);
  Object.assign(audit.deps, auditOriginals);
  Object.assign(axbeatLead.deps, axbeatOriginals);
});

// Fresh IP per test keeps the module-level limiters from coupling tests.
let ipCounter = 0;
const nextIp = () => `10.1.0.${++ipCounter}`;

function fakeReq({ method = 'POST', ip, body, headers = {} } = {}) {
  return { method, headers: { 'x-forwarded-for': ip || nextIp(), ...headers }, body };
}

// One fake that serves both reply styles: res.status().json() and
// res.statusCode = n; res.end(text).
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end(payload) { if (payload !== undefined) this.body = payload; return this; },
  };
}

// --- the two-phase limiter ---------------------------------------------------

test('limiter: check never records, commit does, caps hold', () => {
  const l = makeLimiter({ perMin: 2, perDay: 10 });
  for (let i = 0; i < 50; i++) assert.equal(l.check('k'), false); // checks are free
  l.commit('k');
  assert.equal(l.check('k'), false);
  l.commit('k');
  assert.equal(l.check('k'), true); // at the per-minute cap
  assert.equal(l.check('other'), false); // keys are independent
});

test('a 400 does not consume quota; validated requests do', async () => {
  feedback.deps.notion = async () => ({ id: 'row-1' });
  const ip = nextIp();

  // Far more junk than the per-minute cap of 20: every one answers 400 and
  // none of them burns quota.
  for (let i = 0; i < 25; i++) {
    const res = fakeRes();
    await feedback(fakeReq({ ip, body: { event: 'nope' } }), res);
    assert.equal(res.statusCode, 400);
  }

  // The quota is intact: 20 valid writes go through...
  for (let i = 0; i < 20; i++) {
    const res = fakeRes();
    await feedback(fakeReq({ ip, body: { event: 'shown' } }), res);
    assert.equal(res.statusCode, 200);
  }
  // ...and the 21st in the same minute is the one that hits the cap.
  const capped = fakeRes();
  await feedback(fakeReq({ ip, body: { event: 'shown' } }), capped);
  assert.equal(capped.statusCode, 429);
});

// --- Notion timeout vs refusal ----------------------------------------------

test('a Notion timeout answers 504, a refusal stays 502', async () => {
  feedback.deps.notion = async () => { throw timeoutError(); };
  const timedOut = fakeRes();
  await feedback(fakeReq({ body: { event: 'shown' } }), timedOut);
  assert.equal(timedOut.statusCode, 504);

  feedback.deps.notion = async () => { throw new Error('Notion 400'); };
  const refused = fakeRes();
  await feedback(fakeReq({ body: { event: 'shown' } }), refused);
  assert.equal(refused.statusCode, 502);
});

// --- lead idempotency ---------------------------------------------------------

test('a replayed idempotency key returns the first row, creating once', async () => {
  const created = [];
  let existing = null;
  audit.deps.hasMailExchanger = async () => true;
  audit.deps.findLeadByAuditId = async (_ds, auditId) => existing && existing.auditId === auditId ? existing : null;
  audit.deps.notion = async (apiPath, method, body) => {
    created.push({ apiPath, method });
    existing = { id: 'page-1', auditId: body.properties['Audit ID'].rich_text[0].text.content };
    return { id: 'page-1' };
  };

  const body = { url: 'acme-widgets.co.uk', email: 'jo@acme-widgets.co.uk', idempotency_key: 'retry-key-1234' };
  const first = fakeRes();
  await audit(fakeReq({ body }), first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.auditId, 'aud_retry-key-1234');
  assert.equal(created.length, 1);

  const second = fakeRes();
  await audit(fakeReq({ body }), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.auditId, 'aud_retry-key-1234');
  assert.equal(created.length, 1); // no duplicate row
});

test('axbeat-lead honours the same key, requiring an Origin as before', async () => {
  const created = [];
  let existing = null;
  axbeatLead.deps.hasMailExchanger = async () => true;
  axbeatLead.deps.findLeadByAuditId = async (_ds, leadId) => existing && existing.leadId === leadId ? existing : null;
  axbeatLead.deps.notion = async (_p, _m, body) => {
    created.push(1);
    existing = { id: 'page-2', leadId: body.properties['Audit ID'].rich_text[0].text.content };
    return { id: 'page-2' };
  };

  const headers = { origin: 'https://mooch.agency', host: 'mooch.agency' };
  const body = { email: 'jo@acme-widgets.co.uk', idempotency_key: 'retry-key-5678' };
  const first = fakeRes();
  await axbeatLead(fakeReq({ body, headers }), first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.leadId, 'axb_retry-key-5678');

  const second = fakeRes();
  await axbeatLead(fakeReq({ body, headers }), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.leadId, 'axb_retry-key-5678');
  assert.equal(created.length, 1);

  // And a missing Origin is still rejected outright.
  const noOrigin = fakeRes();
  await axbeatLead(fakeReq({ body }), noOrigin);
  assert.equal(noOrigin.statusCode, 403);
});

// --- MX deliverability --------------------------------------------------------

const err = (code) => Object.assign(new Error(code), { code });

test('MX check fails open on transient trouble, closed on definitive negatives', async () => {
  // Transient resolver error: open.
  assert.equal(
    await hasMailExchanger('x.test', { resolveMx: async () => { throw err('ESERVFAIL'); } }),
    true
  );
  // Slow DNS: open (tiny timeouts keep the test instant).
  assert.equal(
    await hasMailExchanger('x.test', {
      resolveMx: () => new Promise(() => {}),
      resolve: () => new Promise(() => {}),
      mxTimeoutMs: 10,
      aTimeoutMs: 10,
    }),
    true
  );
  // NXDOMAIN: closed.
  assert.equal(
    await hasMailExchanger('x.test', { resolveMx: async () => { throw err('ENOTFOUND'); } }),
    false
  );
  // No MX but an apex A record: open. No A either: closed.
  assert.equal(
    await hasMailExchanger('x.test', {
      resolveMx: async () => { throw err('ENODATA'); },
      resolve: async () => ['192.0.2.1'],
    }),
    true
  );
  assert.equal(
    await hasMailExchanger('x.test', {
      resolveMx: async () => { throw err('ENODATA'); },
      resolve: async () => { throw err('ENODATA'); },
    }),
    false
  );
});

// --- unified ordering ---------------------------------------------------------

test('the method check answers before the kill switch', async () => {
  process.env.AUDIT_KILL = '1';
  try {
    const wrongMethod = fakeRes();
    await audit(fakeReq({ method: 'GET' }), wrongMethod);
    assert.equal(wrongMethod.statusCode, 405);

    const killed = fakeRes();
    await audit(fakeReq({ body: {} }), killed);
    assert.equal(killed.statusCode, 503);
  } finally {
    delete process.env.AUDIT_KILL;
  }
});

// --- the table test -----------------------------------------------------------

test('every endpoint in api/ goes through the shared guard', () => {
  const endpoints = fs
    .readdirSync(apiDir)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  assert.ok(endpoints.length >= 8, `expected the eight endpoints, found ${endpoints.length}`);
  for (const f of endpoints) {
    const src = fs.readFileSync(path.join(apiDir, f), 'utf8');
    assert.match(src, /require\("\.\/_guard\.js"\)/, `${f} must require _guard.js`);
    assert.match(src, /\bguard\(req, res, /, `${f} must admit requests through guard()`);
  }
});
