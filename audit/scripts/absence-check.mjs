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

// Two pages "match" when one contains almost all of the other's lines. Comparing
// whole strings is too brittle: a 404 fallback often carries the requested path in
// a heading, so two 404s are never byte-identical.
function similarity(a, b) {
  if (!a || !b) return 0;
  const linesOf = (s) => new Set(norm(s).split(/(?<=[.!?|])\s+|\n+/).map(l => l.trim()).filter(l => l.length > 3));
  const A = linesOf(a), B = linesOf(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const l of A) if (B.has(l)) shared++;
  return shared / Math.min(A.size, B.size);
}

const MATCH = 0.85;

// Deterministic, unguessable, and stable across runs so two runs of the same audit
// probe the same control URL.
export const controlUrlFor = (siteUrl) =>
  new URL('/mooch-audit-control-404-do-not-create', siteUrl).toString();

/**
 * @param browser         a live puppeteer browser
 * @param siteUrl         the audited site's origin
 * @param finding         { url, absence_claim: 'missing'|'empty'|'wrong_page', ... }
 * @returns { verdict, actual, detail }  verdict: PASS | FAIL | UNVERIFIABLE
 */
export async function checkAbsence(browser, siteUrl, finding, cache = {}) {
  const controlUrl = controlUrlFor(siteUrl);

  if (!(controlUrl in cache)) cache[controlUrl] = await loadAndCapture(browser, controlUrl);
  const control = cache[controlUrl];
  // No control means no baseline, and guessing without one is what produced the
  // false positives this whole check exists to prevent.
  if (!control) return { verdict: 'UNVERIFIABLE', detail: 'control URL would not load; no 404 baseline' };

  if (!(finding.url in cache)) cache[finding.url] = await loadAndCapture(browser, finding.url);
  const target = cache[finding.url];
  if (!target) return { verdict: 'UNVERIFIABLE', detail: 'target page would not load' };

  if (!(siteUrl in cache)) cache[siteUrl] = await loadAndCapture(browser, siteUrl);
  const home = cache[siteUrl];

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
