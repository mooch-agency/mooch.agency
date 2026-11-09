// Tests for form-state.js, the shared lead-form lifecycle. The machine reads
// and writes data-state through get/setAttribute, so a stub element is enough:
// no DOM, no browser. Timers are injected so the cooldown is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const formState = require('../form-state.js');
const { machine, canMove, newKey, fetchJSON, MOVES, COOLDOWN_MS } = formState;

function stubEl(initial = 'idle') {
  const attrs = { 'data-state': initial };
  return {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
  };
}

// Captures timer callbacks so a test can fire or skip them at will.
function stubTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimeout: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearTimeout: (t) => { pending.delete(t); },
    pending,
    fire(t) { const p = pending.get(t); pending.delete(t); if (p) p.fn(); },
    only() { assert.equal(pending.size, 1); return [...pending.keys()][0]; },
  };
}

test('transition table: sent is terminal, cooldown only reopens', () => {
  assert.ok(canMove('idle', 'submitting'));
  assert.ok(canMove('submitting', 'sent'));
  assert.ok(canMove('submitting', 'error'));
  assert.ok(canMove('submitting', 'cooldown'));
  assert.ok(canMove('error', 'submitting'));
  assert.ok(canMove('cooldown', 'idle'));
  assert.equal(MOVES.sent.length, 0);
  for (const to of ['idle', 'submitting', 'error', 'cooldown']) {
    assert.equal(canMove('sent', to), false, `sent -> ${to} must be refused`);
  }
  assert.equal(canMove('cooldown', 'submitting'), false);
  assert.equal(canMove('idle', 'sent'), false, 'only an in-flight submission can finish');
});

test('machine refuses illegal moves and keeps the attribute in step', () => {
  const el = stubEl();
  const m = machine(el, {});
  assert.equal(m.state(), 'idle');
  assert.equal(m.to('sent'), false);
  assert.equal(m.state(), 'idle');
  assert.ok(m.to('submitting'));
  assert.equal(el.getAttribute('data-state'), 'submitting');
  assert.ok(m.to('sent'));
  assert.equal(m.to('idle'), false, 'a late callback cannot resurrect a sent form');
  assert.equal(m.state(), 'sent');
});

test('machine reads state off the attribute, so direct writes stay consistent', () => {
  // AXBeat's view switch rebuilds a form and recovery code writes data-state
  // directly; any machine bound to that element must see the new state.
  const el = stubEl();
  const m = machine(el, {});
  el.setAttribute('data-state', 'submitting');
  assert.equal(m.busy(), true);
  assert.ok(m.to('error'));
  assert.equal(el.getAttribute('data-state'), 'error');
});

test('controls are disabled while submitting or cooling down, re-enabled after', () => {
  const el = stubEl();
  const a = { disabled: false };
  const b = { disabled: false };
  const t = stubTimers();
  const m = machine(el, { controls: () => [a, b], ...t });
  m.to('submitting');
  assert.ok(a.disabled && b.disabled);
  m.to('error');
  assert.ok(!a.disabled && !b.disabled);
  m.to('submitting');
  m.cooldown(1000);
  assert.ok(a.disabled && b.disabled, 'cooldown holds the form shut');
  t.fire(t.only());
  assert.equal(m.state(), 'idle');
  assert.ok(!a.disabled && !b.disabled);
});

test('a transition retires the pending cooldown timer', () => {
  const el = stubEl();
  const t = stubTimers();
  const m = machine(el, { ...t });
  m.to('submitting');
  m.cooldown(1000);
  const timer = t.only();
  assert.ok(m.to('idle'), 'cooldown -> idle is legal');
  assert.equal(t.pending.size, 0, 'the timer was cleared, not left to fire later');
  m.to('submitting');
  t.fire(timer); // a stale handle firing anyway must be a no-op
  assert.equal(m.state(), 'submitting');
});

test('busy covers submitting and cooldown, the states a submit must not re-enter', () => {
  const el = stubEl();
  const t = stubTimers();
  const m = machine(el, { ...t });
  assert.equal(m.busy(), false);
  m.to('submitting');
  assert.equal(m.busy(), true);
  m.cooldown(500);
  assert.equal(m.busy(), true);
  t.fire(t.only());
  assert.equal(m.busy(), false);
});

test('cooldown uses the shared default when no length is given', () => {
  const el = stubEl();
  const t = stubTimers();
  const m = machine(el, { ...t });
  m.to('submitting');
  m.cooldown();
  assert.equal([...t.pending.values()][0].ms, COOLDOWN_MS);
});

test('keys: 32 hex chars, unique, and refill issues a new one', () => {
  const k = newKey();
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.notEqual(newKey(), k);
  const m = machine(stubEl(), {});
  const first = m.key();
  assert.match(first, /^[0-9a-f]{32}$/);
  m.refill();
  assert.notEqual(m.key(), first, 'a changed field is a new fill');
});

test('fetchJSON resolves with parsed JSON and an empty object for a non-JSON body', async () => {
  const res = { ok: true, json: () => Promise.resolve({ ok: true }) };
  const out = await fetchJSON('/x', { a: 1 }, { fetch: async () => res });
  assert.equal(out.res, res);
  assert.deepEqual(out.data, { ok: true });

  const bad = { ok: false, json: () => Promise.reject(new Error('not json')) };
  const out2 = await fetchJSON('/x', {}, { fetch: async () => bad });
  assert.deepEqual(out2.data, {});
});

test('fetchJSON sends the body as JSON and aborts past its deadline', async () => {
  let got;
  await fetchJSON('/x', { email: 'a@b.co', key: 'k' }, {
    fetch: async (url, init) => { got = { url, init }; return { json: () => Promise.resolve({}) }; },
  });
  assert.equal(got.url, '/x');
  assert.equal(got.init.method, 'POST');
  assert.deepEqual(JSON.parse(got.init.body), { email: 'a@b.co', key: 'k' });
  assert.ok(got.init.signal, 'carries an abort signal');

  // A fetch that only settles when its signal aborts: with a 10ms deadline the
  // call must reject rather than hang in submitting forever.
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  await assert.rejects(
    fetchJSON('/slow', {}, { fetch: hang, timeoutMs: 10 }),
    /aborted/
  );
});

// The save-failure fallback: a mailto with the request pre-written, so a lead
// survives our side failing (a dead Notion token once ate every lead).
test('mailtoHref pre-fills subject and body, encoded', () => {
  const href = formState.mailtoHref('AXBeat: Starknet report', 'Email: a&b@x.co\nThanks');
  assert.equal(href,
    'mailto:hey@mooch.agency?subject=AXBeat%3A%20Starknet%20report&body=Email%3A%20a%26b%40x.co%0AThanks');
});
