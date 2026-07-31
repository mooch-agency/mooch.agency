// Verifying a finding that claims something ISN'T there.
//
// The gate can only ask "is this string on the page". An absence finding has no
// string: "the blog never renders posts", "there is no privacy policy", "the contact
// page is empty". So the gate deletes them, and on JS-rendered sites that is where
// the valuable findings live. propstrata /blog and samble /privacy are both this
// class and both are verified real; the quote gate killed the first one.
//
// Worse, the obvious workaround is to quote the loading message ("Loading tags...").
// That fails for a principled reason: a loading message is a thing that goes away,
// so it is never stable evidence. Quoting it makes the verdict depend on capture
// timing, which is not a property of the site at all.
//
// The method here is the one arm B invented unprompted on sambleinnovations, before
// any instruction told it to. HTTP status is useless on an SPA: every URL on that
// site returned 200 with an identical 1018-byte shell, so "page missing" and "page
// empty" are indistinguishable from the response. So build a negative control:
// request a URL that certainly does not exist, render it, and see what this site's
// genuine "not found" state looks like. Then classify the suspect page against it.
//
//   target ≈ control            -> MISSING    the page really does not exist
//   target ≠ control, is thin   -> EMPTY      the page exists and renders nothing
//   target ≠ control, has body  -> WRONG_PAGE it renders something else entirely
//   target ≈ homepage           -> WRONG_PAGE routed to the wrong place
//
// Each verdict is a different finding, and the auditor has to have claimed the right
// one. Claiming a page is missing when it actually renders the product page is
// wrong even though something IS broken, so a mismatch is a FAIL, not a pass.

import { loadAndCapture, norm } from './capture.mjs';

// Text below this length, once nav and footer are all that is left, is a shell
// rather than a page. Measured against samble (~380 chars of chrome) and
// propstrata (381 chars). Deliberately generous: the classifier only has to beat
// "identical to the control", which does most of the work.
const THIN_CHARS = Number(process.env.ABSENCE_THIN_CHARS || 900);

// How much of the TARGET is accounted for by the reference page. Comparing whole
// strings is too brittle: a 404 fallback often carries the requested path in a
// heading, so two 404s are never byte-identical.
//
// The denominator is target-size, and it must not be min(target, reference). A 404
// shell is small and every real page on the site repeats its nav and footer, so a
// min denominator measures "how much of the shell appears in this page", which is
// ~1.0 for every page on the site. Measured on sambleinnovations: full content
// pages of 2950-4820 chars scored 0.80 against the control under a min denominator,
// against a 0.85 threshold. Five points from classifying every rendered page as
// "missing" and rubber-stamping a false absence claim. Target-size denominator
// scores those same pages 0.10-0.16, which is the real answer.
function similarity(target, reference) {
  if (!target || !reference) return 0;
  const linesOf = (s) => new Set(norm(s).split(/(?<=[.!?|])\s+|\n+/).map(l => l.trim()).filter(l => l.length > 3));
  const A = linesOf(target), B = linesOf(reference);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const l of A) if (B.has(l)) shared++;
  return shared / A.size;
}

const MATCH = 0.85;

// Deterministic, unguessable, and stable across runs so two runs of the same audit
// probe the same control URL.
export const controlUrlFor = (siteUrl) =>
  new URL('/mooch-audit-control-404-do-not-create', siteUrl).toString();

// Origin of a URL, or null if it will not parse. Used to decide whether the caller's
// site URL is usable as the homepage sample for this finding.
const safeOrigin = (u) => { try { return new URL(u).origin; } catch { return null; } };

/**
 * @param browser         a live puppeteer browser
 * @param siteUrl         the audited site's origin
 * @param finding         { url, absence_claim: 'missing'|'empty'|'wrong_page', ... }
 * @returns { verdict, actual, detail }  verdict: PASS | FAIL | UNVERIFIABLE
 */
export async function checkAbsence(browser, siteUrl, finding, cache = {}) {
  // Derive the control and homepage from the FINDING's own origin, not the site URL
  // the run was started with. A lead submitted as apex that redirects to www (or the
  // reverse) otherwise gets its baseline from a different host: propstrata's findings
  // are on www.propstrata.com while the run is invoked with propstrata.com. It
  // happened to work there because the apex redirects, but on a site that serves
  // apex and www differently the control would describe the wrong site. This is the
  // same landed-host rule discovery.mjs already enforces for the pipeline.
  let origin;
  try { origin = new URL(finding.url).origin; }
  catch { return { verdict: 'UNVERIFIABLE', detail: `finding URL is not a URL: ${finding.url}` }; }
  const homeUrl = siteUrl && safeOrigin(siteUrl) === origin ? siteUrl : origin;
  const controlUrl = controlUrlFor(origin);

  if (!(controlUrl in cache)) cache[controlUrl] = await loadAndCapture(browser, controlUrl);
  const control = cache[controlUrl];
  // No control means no baseline, and guessing without one is what produced the
  // false positives this whole check exists to prevent.
  if (!control) return { verdict: 'UNVERIFIABLE', detail: 'control URL would not load; no 404 baseline' };

  if (!(finding.url in cache)) cache[finding.url] = await loadAndCapture(browser, finding.url);
  const target = cache[finding.url];
  if (!target) return { verdict: 'UNVERIFIABLE', detail: 'target page would not load' };

  if (!(homeUrl in cache)) cache[homeUrl] = await loadAndCapture(browser, homeUrl);
  const home = cache[homeUrl];

  const vsControl = similarity(target.text, control.text);
  const vsHome = home ? similarity(target.text, home.text) : 0;
  const len = norm(target.text).length;

  let actual;
  if (vsControl >= MATCH) actual = 'missing';
  else if (vsHome >= MATCH) actual = 'wrong_page';
  else if (len <= THIN_CHARS) actual = 'empty';
  else actual = 'wrong_page';

  const claim = String(finding.absence_claim || '').toLowerCase();
  const detail = `target vs control ${vsControl.toFixed(2)}, vs home ${vsHome.toFixed(2)}, ${len} chars -> ${actual}`;

  // A page that renders a full, distinct body is not absent in any sense. This is
  // the guard against an auditor calling a page "empty" because it could not read it.
  if (actual === 'wrong_page' && len > THIN_CHARS && claim !== 'wrong_page') {
    return { verdict: 'FAIL', actual, detail: `${detail} (renders real content; not an absence)` };
  }
  return { verdict: actual === claim ? 'PASS' : 'FAIL', actual, detail };
}
