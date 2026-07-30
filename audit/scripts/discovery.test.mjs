// Tests for the page-discovery host rules. No browser, no network.
//   node --test scripts/discovery.test.mjs
//
// The regression these exist for: aud_ms5wzapuwu93mo (29 Jul). The lead
// submitted the apex, the site 307d to www, and the inventory compared the
// rendered anchors against the submitted apex origin. Every link was binned,
// the audit read the homepage alone, and a thirteen-page site was told it
// looked in good shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameSiteFactory, cleanUrl, buildInventory, onLandedHost } from './discovery.mjs';

const page = (...hrefs) => ({ links: hrefs.map((href) => ({ href, label: 'L' })) });

test('sameSiteFactory: www and apex are the same site, both directions', () => {
  const fromApex = sameSiteFactory('https://sambleinnovations.com/');
  assert.equal(fromApex('https://www.sambleinnovations.com/privacyos'), true);
  assert.equal(fromApex('https://sambleinnovations.com/faq'), true);

  const fromWww = sameSiteFactory('https://www.sambleinnovations.com/');
  assert.equal(fromWww('https://sambleinnovations.com/faq'), true);
});

test('sameSiteFactory: a different host is not the same site', () => {
  const same = sameSiteFactory('https://sambleinnovations.com/');
  assert.equal(same('https://cal.com/samble-innovations/freeconsultation'), false);
  assert.equal(same('https://notsambleinnovations.com/'), false);
  assert.equal(same('mailto:miles@sambleinnovations.com'), false);
  assert.equal(same('not a url'), false);
});

test('cleanUrl: strips query, hash and trailing slash', () => {
  assert.equal(cleanUrl('https://x.com/a/?q=1#top'), 'https://x.com/a');
  assert.equal(cleanUrl('https://x.com/'), 'https://x.com');
});

test('buildInventory: keeps internal links after an apex -> www redirect', () => {
  const home = page(
    'https://www.sambleinnovations.com/privacyos',
    'https://www.sambleinnovations.com/knowledge-continuity',
    'https://cal.com/samble-innovations/freeconsultation'
  );
  // Submitted apex, landed on www: the pre-fix code returned [] here.
  const inv = buildInventory(home, 'https://www.sambleinnovations.com/');
  assert.deepEqual(
    inv.map((l) => l.url),
    ['https://www.sambleinnovations.com/privacyos', 'https://www.sambleinnovations.com/knowledge-continuity']
  );
});

test('buildInventory: drops the landed homepage, not the submitted one', () => {
  const home = page(
    'https://www.sambleinnovations.com/',
    'https://www.sambleinnovations.com/#products',
    'https://www.sambleinnovations.com/faq'
  );
  const inv = buildInventory(home, 'https://www.sambleinnovations.com/');
  assert.deepEqual(inv.map((l) => l.url), ['https://www.sambleinnovations.com/faq']);
});

test('buildInventory: dedupes the same page reached by different URLs', () => {
  const home = page(
    'https://x.com/pricing',
    'https://x.com/pricing/',
    'https://x.com/pricing?ref=nav',
    'https://x.com/pricing#plans'
  );
  const inv = buildInventory(home, 'https://x.com/');
  assert.deepEqual(inv.map((l) => l.url), ['https://x.com/pricing']);
});

test('buildInventory: survives junk hrefs and a page with no links', () => {
  assert.deepEqual(buildInventory(page('javascript:void(0)', 'tel:+441234'), 'https://x.com/'), []);
  assert.deepEqual(buildInventory({ links: [] }, 'https://x.com/'), []);
  assert.deepEqual(buildInventory(undefined, 'https://x.com/'), []);
});

// onLandedHost: the regression is apexvolumetrics.com (30 Jul). The sitemap
// lists the apex host; the apex host 308s to www and, on some requests, resets
// the connection outright. Two runs of the same site read different pages and
// reached opposite verdicts because a failed redirect hop silently swapped the
// page for a different one instead of being retried.
test('onLandedHost: rewrites a sitemap URL onto the host the homepage landed on', () => {
  const rewritten = onLandedHost(
    'https://apexvolumetrics.com/refund-policy',
    'https://www.apexvolumetrics.com/'
  );
  assert.equal(rewritten, 'https://www.apexvolumetrics.com/refund-policy');
});

test('onLandedHost: preserves query and hash', () => {
  const rewritten = onLandedHost(
    'https://apexvolumetrics.com/faq?ref=nav#section',
    'https://www.apexvolumetrics.com/'
  );
  assert.equal(rewritten, 'https://www.apexvolumetrics.com/faq?ref=nav#section');
});

test('onLandedHost: already on the landed host is a no-op', () => {
  const url = 'https://www.apexvolumetrics.com/terms';
  assert.equal(onLandedHost(url, 'https://www.apexvolumetrics.com/'), url);
});

test('onLandedHost: leaves a different site alone', () => {
  const url = 'https://cal.com/samble-innovations/freeconsultation';
  assert.equal(onLandedHost(url, 'https://www.apexvolumetrics.com/'), url);
});

test('onLandedHost: a junk URL comes back unchanged, not thrown', () => {
  assert.equal(onLandedHost('javascript:void(0)', 'https://www.apexvolumetrics.com/'), 'javascript:void(0)');
});

test('onLandedHost: also rewrites in the reverse direction, www to bare apex', () => {
  const rewritten = onLandedHost(
    'https://www.apexvolumetrics.com/refund-policy',
    'https://apexvolumetrics.com/'
  );
  assert.equal(rewritten, 'https://apexvolumetrics.com/refund-policy');
});

// Same host, different scheme is not "already fine": comparing only .host (no
// protocol) let an http page on the landed host look identical to the https one
// and skip the retry that would have fixed it.
test('onLandedHost: same host but wrong scheme still gets rewritten', () => {
  const rewritten = onLandedHost(
    'http://www.apexvolumetrics.com/refund-policy',
    'https://www.apexvolumetrics.com/'
  );
  assert.equal(rewritten, 'https://www.apexvolumetrics.com/refund-policy');
});

// Mutating u.protocol/u.host in place kept a stale port from the original URL
// when the landed host had none. Rebuilding from landed.origin doesn't.
test('onLandedHost: does not carry a stale port onto the landed host', () => {
  const rewritten = onLandedHost('https://apexvolumetrics.com:8443/faq', 'https://www.apexvolumetrics.com/');
  assert.equal(rewritten, 'https://www.apexvolumetrics.com/faq');
});

test('onLandedHost: mailto and tel links pass through untouched', () => {
  for (const link of ['mailto:miles@sambleinnovations.com', 'tel:+441234567890']) {
    assert.equal(onLandedHost(link, 'https://www.apexvolumetrics.com/'), link);
  }
});

// ── Item 2 (recall-gap ticket): the link checker sees subdomains ────────────
// sameSiteFactory stays strict on purpose: page DISCOVERY must not wander onto
// quiz.example.com and audit it. sameDomainFactory is the link-check filter,
// where a subdomain of the client's own domain is the client's own link.
// The apexvolumetrics case: the hero CTA pointed at www.quiz.apexvolumetrics.com,
// which sameSiteFactory reduced to a third-party host, so the dead link was
// never even probed.
import { sameDomainFactory } from './discovery.mjs';

test('sameDomainFactory: a subdomain of the audited domain is same-domain', () => {
  const sameDomain = sameDomainFactory('https://apexvolumetrics.com/');
  assert.equal(sameDomain('https://quiz.apexvolumetrics.com/x'), true);
  assert.equal(sameDomain('https://www.quiz.apexvolumetrics.com//default'), true);
  assert.equal(sameDomain('https://www.apexvolumetrics.com/faq'), true);
  assert.equal(sameDomain('https://apexvolumetrics.com/'), true);
});

test('sameDomainFactory: lookalike and third-party hosts are not', () => {
  const sameDomain = sameDomainFactory('https://apexvolumetrics.com/');
  assert.equal(sameDomain('https://evilapexvolumetrics.com/'), false);
  assert.equal(sameDomain('https://apexvolumetrics.com.evil.example/'), false);
  assert.equal(sameDomain('https://example.com/'), false);
  assert.equal(sameDomain('not a url'), false);
});

// When the audited site is itself a subdomain, its own children count but its
// parent does not: lisbon.amplify.eu was sold as the site, amplify.eu was not.
test('sameDomainFactory: children of a subdomain site count, the parent does not', () => {
  const sameDomain = sameDomainFactory('https://lisbon.amplify.eu/');
  assert.equal(sameDomain('https://book.lisbon.amplify.eu/'), true);
  assert.equal(sameDomain('https://amplify.eu/'), false);
  assert.equal(sameDomain('https://porto.amplify.eu/'), false);
});
