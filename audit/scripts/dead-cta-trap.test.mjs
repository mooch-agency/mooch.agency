// REGRESSION TRAP: the apexvolumetrics dead hero CTA, end to end.
//   node --test scripts/dead-cta-trap.test.mjs
//
// This is the case the whole recall-gap ticket was opened over. A live site's
// primary call to action pointed at www.quiz.apexvolumetrics.com//default,
// which does not resolve, and the client was sent a report saying "found
// nothing material to fix. Your site's in good shape."
//
// FOUR independent defects each hid it on their own, so fixing any one of them
// would not have surfaced it, and a regression in any one would bury it again.
// Fixture-based on purpose: the live site's DNS could be fixed tomorrow, and
// this trap has to keep failing loudly if the pipeline regresses regardless.
//
// The four gates, in the order the evidence passes through them:
//   1. sameDomainFactory  - is the link ours to check at all?
//   2. statusOfFactory    - is ENOTFOUND reportable, or a generic error?
//   3. buildBundle        - does the judge get to see the destination?
//   4. renderReport       - does the client actually get told?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameDomainFactory } from './discovery.mjs';
import { statusOfFactory, REPORTABLE } from './link-check.mjs';
import { buildBundle } from './bundle.mjs';
import { renderReport } from '../report/render-report.mjs';

const SITE = 'https://www.apexvolumetrics.com/';
const DEAD = 'https://www.quiz.apexvolumetrics.com//default';

// The exact failure: NXDOMAIN, every time.
const nxdomain = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };

test('gate 1: a subdomain CTA is the client\'s own link, not a third party', () => {
  // sameSiteFactory (page discovery) correctly says no; the LINK CHECK must say
  // yes. Conflating the two is what dropped this link before it was ever probed.
  assert.equal(sameDomainFactory(SITE)(DEAD), true);
});

test('gate 2: ENOTFOUND is reportable, not a generic error', async () => {
  const status = await statusOfFactory(nxdomain)(DEAD);
  assert.equal(status, 'dead_domain');
  assert.ok(REPORTABLE.has(status), 'a dead domain must reach the client');
});

test('gate 3: the judge sees the destination and the verdict', () => {
  const bundle = buildBundle(
    [{
      url: SITE,
      title: 'Apex Volumetrics',
      text: 'Monitor high-volume liquidity allocations. Take the quiz',
      links: [{ href: DEAD, label: 'Take the quiz' }],
    }],
    [{ url: DEAD, status: 'dead_domain' }]
  );
  assert.match(bundle, /Take the quiz -> https:\/\/www\.quiz\.apexvolumetrics\.com\/\/default/);
  assert.match(bundle, /\[BROKEN: the domain does not resolve\]/);
  // And the anchor text is still in the page text, so a finding quoting it
  // survives the quote gate (which reads p.text only).
  assert.match(bundle, /Take the quiz\nLINKS ON THIS PAGE/);
});

test('gate 4: the client is told, even with zero judge findings', () => {
  const out = renderReport({
    site: SITE,
    findings: [],
    picker: { pages_used: [SITE, SITE + 'faq'] },
    coverage: { notes: [] },
    link_check: { broken: [{ url: DEAD, status: 'dead_domain' }], soft_404: false },
  }, '31 July 2026');

  assert.equal(out.thin, false, 'a dead link alone must defeat the good-shape floor');
  assert.ok(!/good shape/i.test(out.html), 'the sentence that shipped to the client must not');
  assert.ok(!/nothing material to fix/i.test(out.html));
  assert.match(out.html, /quiz\.apexvolumetrics\.com/, 'the URL must appear, not be dropped');
  assert.match(out.html, /domain doesn't resolve/i);
  assert.ok(!/dead_domain/.test(out.html), 'internal token must not leak');
});

// The honesty gate is the backstop for the version of this where the homepage
// never loaded at all: apex ran twice that way on 30 Jul. Zero findings AND a
// coverage gap must never read as a clean site.
test('backstop: an incomplete run never certifies the site', () => {
  const out = renderReport({
    site: SITE,
    findings: [],
    picker: { pages_used: [SITE + 'faq'] },
    coverage: { notes: [`the homepage ${SITE} was unreadable even after a retry (bot-block or empty); this is the page most likely to carry pricing and headline claims, so findings are significantly limited`] },
    link_check: { broken: [], soft_404: false },
  }, '31 July 2026');

  assert.equal(out.inconclusive, true);
  assert.ok(!/good shape/i.test(out.html));
  assert.match(out.html, /couldn't read/i);
  assert.match(out.html, /homepage/i);
});
