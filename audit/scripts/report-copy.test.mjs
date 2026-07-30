// Guards the copy that changes with the thin-report floor. No browser: the
// renderer returns an HTML string, so these are plain string assertions.
//   node --test scripts/report-copy.test.mjs
//
// The regression: the closer BODY branched on `thin` from the start, the closer
// TITLE never did. A good-shape report closed with "Want these fixed" above a
// paragraph saying the pages were clean, pointing at a findings list that
// variant never prints (propstrata, aud_ms5sy6lmrhf0mu).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../report/render-report.mjs';

const finding = (severity) => ({
  url: 'https://example.com/pricing',
  quote: 'Plans from £19 a month',
  severity,
  category: 'pricing',
  issue: 'Two different prices for the same plan.',
  gate: 'pass',
});

const record = (findings, link_check = { broken: [] }) => ({
  site: 'https://example.com/',
  auditId: 'aud_test',
  findings,
  picker: { pages_used: ['https://example.com/', 'https://example.com/pricing'] },
  coverage: { notes: [] },
  link_check,
});

// Two lows total weight 2, under THIN_FLOOR_WEIGHT, so this is the good-shape
// variant even though the gate passed real findings. Exactly Uche's case.
test('good-shape report never asks to fix findings it did not print', () => {
  const out = renderReport(record([finding('low'), finding('low')]), '29 July 2026');
  assert.equal(out.thin, true);
  assert.ok(!out.html.includes('Want these fixed'), 'closer must not say "these" with no list above it');
  assert.match(out.html, /Want your whole site read the same way\?/);
});

test('findings report still asks to fix them', () => {
  const out = renderReport(record([finding('high')]), '29 July 2026');
  assert.equal(out.thin, false);
  assert.match(out.html, /Want these fixed, or the whole site read\?/);
});

// The good-shape body used to restate the verdict, restate the coverage scope
// line and repeat the upsell, so the same three claims appeared up to four
// times in about 90 words.
test('good-shape report states the result once', () => {
  const out = renderReport(record([finding('low')]), '29 July 2026');
  const count = (re) => (out.html.match(re) || []).length;
  assert.equal(out.thin, true);
  assert.equal(count(/nothing material to fix/gi), 1);
  assert.equal(count(/whole site/gi), 1);
  assert.ok(!out.html.includes('rarer than you would think'));
});

// "No broken links" was asserted unconditionally, including on soft-404 origins
// where the check never ran (anglianphe, 24 Jul).
test('a clean report never claims links are fine', () => {
  const out = renderReport(record([finding('low')]), '29 July 2026');
  assert.ok(!/no broken links/i.test(out.html));
});

test('a skipped link check is disclosed to the client', () => {
  const skipped = record([finding('low')], { broken: [], soft_404: true });
  assert.match(renderReport(skipped, '29 July 2026').html, /couldn't check your links/i);
  // ...and stays silent when the check did run and found nothing.
  assert.ok(!/couldn't check your links/i.test(renderReport(record([finding('low')]), '29 July 2026').html));
});

// The fallback fired whenever there were broken links but no findings.
test('the verdict never promises a fix timeline', () => {
  const withBroken = record([], { broken: [{ url: 'https://example.com/gone', status: 404 }] });
  assert.ok(!/fixable in an afternoon/i.test(renderReport(withBroken, '29 July 2026').html));
});

// ── Item 1 (recall-gap ticket): broken links defeat the thin floor ──────────
// The apexvolumetrics case: zero findings above the floor, but the hero CTA is
// dead. That record used to render thin: true, drop the URL entirely, and say
// "found nothing material to fix". A verified broken link IS material.
test('a broken link alone defeats the good-shape variant', () => {
  const out = renderReport(
    record([], { broken: [{ url: 'https://example.com/quiz', status: 404 }] }),
    '30 July 2026'
  );
  assert.equal(out.thin, false);
  assert.match(out.html, /example\.com\/quiz/);
  assert.match(out.html, /1 content issue/);
});

test('low findings under the floor plus a broken link still render in full', () => {
  const out = renderReport(
    record([finding('low')], { broken: [{ url: 'https://example.com/gone', status: 410 }] }),
    '30 July 2026'
  );
  assert.equal(out.thin, false);
  assert.match(out.html, /example\.com\/gone/);
});

// A dead domain reads differently from a 404 in the client-facing list: "the
// page is gone" vs "the domain doesn't exist".
test('a dead-domain link is labelled as such, not as a status code', () => {
  const out = renderReport(
    record([], { broken: [{ url: 'https://www.quiz.example.com//default', status: 'dead_domain' }] }),
    '30 July 2026'
  );
  assert.equal(out.thin, false);
  assert.match(out.html, /domain doesn't resolve/i);
  assert.ok(!/dead_domain/.test(out.html), 'internal status token must not leak to the client');
});

// ── The honesty gate ────────────────────────────────────────────────────────
// Goal: every audit either surfaces something a prospect would act on, or says
// plainly that it couldn't. The good-shape variant used to claim the second
// case never happens. apexvolumetrics (30 Jul) shipped "found nothing material
// to fix. Your site's in good shape." on a run where the homepage was never
// read at all: a clean bill of health issued over the one page that carries the
// hero, the pricing and the primary CTA.
//
// "We found nothing" and "we couldn't look properly" are different claims and
// only one of them is ours to make.
const degraded = (notes, extra = {}) =>
  record([finding('low')], { broken: [], ...extra.link_check });

test('a thin run with unread pages does not claim the site is in good shape', () => {
  const rec = record([finding('low')]);
  rec.coverage = { notes: ['the homepage https://example.com/ was unreadable (bot-block or empty); findings may be limited'] };
  const out = renderReport(rec, '31 July 2026');
  assert.ok(!/good shape/i.test(out.html), 'must not certify a site it could not read');
  assert.ok(!/nothing material to fix/i.test(out.html));
  assert.match(out.html, /couldn't read/i);
  assert.equal(out.inconclusive, true);
});

test('the inconclusive verdict names what it could not read', () => {
  const rec = record([]);
  rec.coverage = { notes: ['the homepage https://example.com/ was unreadable (bot-block or empty); findings may be limited'] };
  const out = renderReport(rec, '31 July 2026');
  assert.equal(out.inconclusive, true);
  assert.match(out.html, /homepage/i);
});

// A skipped link check alone is a coverage limit too: the report already
// discloses it in the notes, but the verdict used to certify the site anyway.
test('a skipped link check also blocks the good-shape claim', () => {
  const out = renderReport(record([finding('low')], { broken: [], soft_404: true }), '31 July 2026');
  assert.equal(out.inconclusive, true);
  assert.ok(!/good shape/i.test(out.html));
});

// The clean case must still read as clean: this gate is not allowed to make
// every report hedge. Nothing unread, nothing skipped, nothing found.
test('a genuinely complete thin run still says good shape', () => {
  const out = renderReport(record([finding('low')]), '31 July 2026');
  assert.equal(out.inconclusive, false);
  assert.equal(out.thin, true);
  assert.match(out.html, /good shape/i);
});

// Findings outrank coverage gaps: if we have something to show, show it. The
// gate exists to stop a false all-clear, not to bury real findings behind a
// caveat.
test('a run with real findings reports them even when coverage was degraded', () => {
  const rec = record([finding('high')]);
  rec.coverage = { notes: ['the homepage was unreadable'] };
  const out = renderReport(rec, '31 July 2026');
  assert.equal(out.inconclusive, false);
  assert.equal(out.thin, false);
  assert.match(out.html, /Want these fixed/);
});

// The inconclusive closer asks for the thing it actually needs. A run that
// couldn't reach a page has a better offer available than "want the whole
// site?", and it is also the honest one.
test('the inconclusive closer offers to read what it could not reach', () => {
  const rec = record([finding('low')]);
  rec.coverage = { notes: ['the homepage was unreadable'] };
  const out = renderReport(rec, '31 July 2026');
  assert.match(out.html, /Want us to read the pages we couldn't reach\?/);
  assert.ok(!/Want these fixed/.test(out.html), 'no findings list on this variant');
});
