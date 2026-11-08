// Tests for state.js, the shared widget-state core. The controllers are the
// logic that raced in the wild (the copy button stuck on "Copied" after a
// double click; the disclosure that snapped open when closed mid-animation),
// so the races are pinned down here deterministically through injected
// effects: no browser, no timers, no new dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  makeGen,
  copyReducer,
  disclosureReducer,
  counterMerge,
  countLabel,
  createCopyController,
  createDisclosureController,
} = require('../state.js');

// ── core ─────────────────────────────────────────────────────────────────────

test('makeGen: a token is retired the moment a newer one is taken', () => {
  const gen = makeGen();
  const first = gen.next();
  assert.ok(gen.isCurrent(first));
  const second = gen.next();
  assert.ok(!gen.isCurrent(first));
  assert.ok(gen.isCurrent(second));
});

test('counterMerge never goes backwards once a value has been shown', () => {
  assert.equal(counterMerge(null, 17), 17); // first value always lands
  assert.equal(counterMerge(18, 17), 18);   // a late, lower GET is ignored
  assert.equal(counterMerge(17, 18), 18);
  assert.equal(counterMerge(17, 17), 17);
});

test('countLabel pluralises', () => {
  assert.equal(countLabel(1), 'Copied 1 time');
  assert.equal(countLabel(2), 'Copied 2 times');
  assert.equal(countLabel(1200), 'Copied 1,200 times');
});

test('copyReducer: rejection never claims Copied, restore only leaves copied', () => {
  assert.equal(copyReducer('idle', 'copy_ok'), 'copied');
  assert.equal(copyReducer('idle', 'copy_fail'), 'idle');
  assert.equal(copyReducer('copied', 'copy_fail'), 'idle');
  assert.equal(copyReducer('copied', 'restore'), 'idle');
  assert.equal(copyReducer('idle', 'restore'), 'idle');
});

test('disclosureReducer: toggles head the other way, stale settles change nothing', () => {
  assert.equal(disclosureReducer('closed', 'toggle'), 'opening');
  assert.equal(disclosureReducer('opening', 'toggle'), 'closing');
  assert.equal(disclosureReducer('closing', 'toggle'), 'opening');
  assert.equal(disclosureReducer('open', 'toggle'), 'closing');
  assert.equal(disclosureReducer('opening', 'settled_open'), 'open');
  assert.equal(disclosureReducer('closing', 'settled_open'), 'closing'); // stale
  assert.equal(disclosureReducer('closing', 'settled_closed'), 'closed');
  assert.equal(disclosureReducer('opening', 'settled_closed'), 'opening'); // stale
});

// ── copy controller ──────────────────────────────────────────────────────────

function copyHarness(write) {
  const log = [];
  let timers = [];
  let nextId = 0;
  let label = 'Copy prompt'; // what render derives, as the DOM glue would
  const fx = {
    write: write || (() => Promise.resolve()),
    schedule(fn, ms) { const id = ++nextId; timers.push({ id, fn, ms }); return id; },
    cancel(id) { log.push(['cancel', id]); timers = timers.filter((t) => t.id !== id); },
    render(phase) { label = phase === 'copied' ? 'Copied' : 'Copy prompt'; log.push(['render', phase]); },
    copied() { log.push(['copied']); },
  };
  return {
    fx,
    log,
    label: () => label,
    timers: () => timers,
    runOldestTimer() { const t = timers.shift(); assert.ok(t, 'a timer to run'); t.fn(); },
  };
}

test('copy: the old failure, a double click inside the restore window, ends on the original label', async () => {
  const h = copyHarness();
  const ctrl = createCopyController(h.fx);
  await ctrl.click('text');
  assert.equal(h.label(), 'Copied');
  await ctrl.click('text'); // second click while still showing "Copied"
  assert.ok(h.log.some(([op]) => op === 'cancel'), 'the first restore timer is cleared');
  assert.equal(h.timers().length, 1, 'one live restore timer');
  h.runOldestTimer();
  assert.equal(ctrl.phase(), 'idle');
  assert.equal(h.label(), 'Copy prompt', 'restores the bind-time label, never "Copied"');
  assert.equal(h.timers().length, 0);
});

test('copy: a stale restore is a no-op even if cancel is broken', async () => {
  const h = copyHarness();
  h.fx.cancel = () => {}; // deliberately leave the first timer live
  const ctrl = createCopyController(h.fx);
  await ctrl.click('text');
  await ctrl.click('text');
  assert.equal(h.timers().length, 2);
  h.runOldestTimer(); // the first click's restore, generation now stale
  assert.equal(ctrl.phase(), 'copied', 'the stale timer did not restore');
  h.runOldestTimer(); // the second click's restore
  assert.equal(ctrl.phase(), 'idle');
});

test('copy: clipboard rejection never claims Copied and fires no side effects', async () => {
  const h = copyHarness(() => Promise.reject(new Error('denied')));
  const ctrl = createCopyController(h.fx);
  await ctrl.click('text');
  assert.equal(ctrl.phase(), 'idle');
  assert.equal(h.label(), 'Copy prompt');
  assert.ok(!h.log.some(([op]) => op === 'copied'), 'no event, no counter POST');
  assert.equal(h.timers().length, 0);
});

test('copy: a write that throws synchronously behaves like a rejection', async () => {
  const h = copyHarness(() => { throw new Error('no clipboard'); });
  const ctrl = createCopyController(h.fx);
  await ctrl.click('text');
  assert.equal(ctrl.phase(), 'idle');
});

test('copy: the copied hook (event + counter POST) waits for the write to land', async () => {
  let resolveWrite;
  const h = copyHarness(() => new Promise((res) => { resolveWrite = res; }));
  const ctrl = createCopyController(h.fx);
  const p = ctrl.click('text');
  assert.ok(!h.log.some(([op]) => op === 'copied'), 'nothing counted before the copy lands');
  resolveWrite();
  await p;
  assert.equal(h.log.filter(([op]) => op === 'copied').length, 1);
});

// ── disclosure controller ────────────────────────────────────────────────────

function discHarness({ reduced = false } = {}) {
  const log = [];
  let pendingEnd = null; // as the glue's single transitionend listener holds it
  const deferred = [];
  const fx = {
    measure: () => 120,
    setMax(v) { log.push(['max', v]); },
    setOpenClass(on) { log.push(['class', on]); },
    reduced: () => reduced,
    expectTransitionEnd(fn) { pendingEnd = fn; },
    defer(fn) { deferred.push(fn); },
    render(phase) { log.push(['render', phase]); },
  };
  return {
    fx,
    log,
    // The glue fires whatever callback is registered when ANY max-height
    // transition on the body ends, which is exactly how the stale open
    // listener used to snap a closing disclosure back open.
    fireTransitionEnd() { const fn = pendingEnd; pendingEnd = null; if (fn) fn(); },
    runDeferred() { const fn = deferred.shift(); assert.ok(fn, 'a deferred frame to run'); fn(); },
  };
}

test('disclosure: a clean open settles and releases the pixel cap', () => {
  const h = discHarness();
  const ctrl = createDisclosureController(h.fx);
  ctrl.toggle();
  assert.equal(ctrl.phase(), 'opening');
  h.fireTransitionEnd();
  assert.equal(ctrl.phase(), 'open');
  assert.deepEqual(h.log.filter(([op]) => op === 'max').pop(), ['max', 'none']);
});

test('disclosure: the old failure, closing mid-open, stays closed', () => {
  const h = discHarness();
  const ctrl = createDisclosureController(h.fx);
  ctrl.toggle(); // opening
  ctrl.toggle(); // closing, before the open transition ended
  const maxWritesBefore = h.log.filter(([op, v]) => op === 'max' && v === 'none').length;
  // The CLOSE transition ends and fires the stale open callback:
  h.fireTransitionEnd();
  assert.equal(ctrl.phase(), 'closing', 'the stale open settle changed nothing');
  assert.equal(
    h.log.filter(([op, v]) => op === 'max' && v === 'none').length,
    maxWritesBefore,
    'max-height is never released to none after the close began'
  );
  h.runDeferred();
  assert.equal(ctrl.phase(), 'closed');
  assert.deepEqual(h.log.filter(([op]) => op === 'class').pop(), ['class', false]);
});

test('disclosure: reopening mid-close stays open', () => {
  const h = discHarness();
  const ctrl = createDisclosureController(h.fx);
  ctrl.toggle();
  h.fireTransitionEnd(); // open
  ctrl.toggle();         // closing, settle deferred
  ctrl.toggle();         // reopened before the deferred frames ran
  h.runDeferred();       // the stale close settle
  assert.equal(ctrl.phase(), 'opening', 'the stale close settle changed nothing');
  assert.ok(!h.log.some(([op, v]) => op === 'class' && v === false), '.open was never removed');
  h.fireTransitionEnd();
  assert.equal(ctrl.phase(), 'open');
});

test('disclosure: reduced motion settles the open immediately', () => {
  const h = discHarness({ reduced: true });
  const ctrl = createDisclosureController(h.fx);
  ctrl.toggle();
  assert.equal(ctrl.phase(), 'open');
  assert.deepEqual(h.log.filter(([op]) => op === 'max').pop(), ['max', 'none']);
});
