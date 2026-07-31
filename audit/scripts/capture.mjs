// The one page-capture routine. Reader, gate and pipeline all call this.
//
// Before 31 Jul this logic was copy-pasted into four files (read-url, code-gate,
// run-pipeline, and later render-read), all with the same bug, which is exactly how
// a bug survives: fixing one copy leaves three, and a gate that captures differently
// from the reader rejects true findings.
//
// The bug: `scrollBy(0, 600)` every 80ms, then `scrollTo(0, 0)`, then a flat 700ms
// wait. That is faster than an IntersectionObserver fires, so scroll-triggered
// content never starts. On r3p.xyz the stat counters were captured as a stable
// "0.0M+" where a human sees "3.4M+" — stable, so no amount of extra waiting
// detected it. "Never animated" and "finished animating" are indistinguishable.
// The judge has been silently rejecting those counters as an artifact on every r3p
// run for weeks; it was compensating for its own instrument.
//
// The fix, measured rather than guessed:
//   1. Scroll SLOWLY (400px, 220ms dwell) so observers actually fire.
//   2. Do NOT snap back to top. Snapping back raced the animations we just started.
//   3. Then wait until innerText stops changing, rather than a fixed delay.
//
// Step 3 alone does not work, which is the part that cost an evening: if the scroll
// is too fast the content never starts, so "stable" is satisfied immediately by the
// wrong value. The slow scroll is what makes the settle meaningful.
//
// Verified against a real Chrome window on r3p.xyz:
//   600px/80ms  -> 0.0M+ / 0M+ / 0.0M+ / 0K+      (wrong)
//   400px/220ms -> 3.4M+ / 30M+ / 8.5M+ / 24K+    (matches a human)
//
// Known consequence, and it is correct behaviour: transient text is no longer
// captured. propstrata.com/blog shows "Loading tags..." for under ~1.5s and then
// settles to nav and footer with no posts. The settled capture is the honest one.
// The blog IS broken, but a loading message cannot be the evidence, because a
// loading message is by definition a thing that goes away. Absence findings need a
// control probe, not a quote. See absence-check.mjs.

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'];

export const CHROME = () => process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Scroll step and dwell. Env-overridable so a future experiment can move them
// without another round of copy-paste, but the defaults are the measured ones.
const STEP = Number(process.env.CAPTURE_SCROLL_STEP || 400);
const DWELL = Number(process.env.CAPTURE_SCROLL_DWELL || 220);
const SETTLE_MAX = Number(process.env.CAPTURE_SETTLE_MAX_MS || 12000);
// Cap the scroll on very long pages so one 40,000px article does not spend 20s
// scrolling. Past this we stop stepping and let the settle loop finish the job.
const MAX_SCROLL_MS = Number(process.env.CAPTURE_MAX_SCROLL_MS || 20000);

export async function preparePage(page) {
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 800 });
}

// Scroll the page slowly, then wait for the visible text to stop changing.
// Returns { text, settled, waited }. `settled: false` means the page was still
// moving when we gave up: a live ticker, a clock, an infinite feed. Callers should
// treat numbers on such a page as unreliable rather than quote them.
export async function captureText(page, { settleMaxMs = SETTLE_MAX } = {}) {
  await page.evaluate(async (step, dwell, maxMs) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await sleep(dwell);
      if (Date.now() - t0 > maxMs) break;
    }
  }, STEP, DWELL, MAX_SCROLL_MS);

  return page.evaluate(async (maxMs) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    let prev = document.body.innerText;
    while (Date.now() - t0 < maxMs) {
      await sleep(600);
      const now = document.body.innerText;
      if (now === prev) return { text: now, settled: true, waited: Date.now() - t0 };
      prev = now;
    }
    return { text: prev, settled: false, waited: Date.now() - t0 };
  }, settleMaxMs);
}

// goto + prepare + capture. Returns null on any failure, so callers can tell
// "could not look" apart from "looked and it was not there" — the difference
// between UNVERIFIABLE and FAIL, which must never collapse into each other.
export async function loadAndCapture(browser, url, { timeout = 45000 } = {}) {
  const p = await browser.newPage();
  try {
    await preparePage(p);
    await p.goto(url, { waitUntil: 'networkidle2', timeout });
    const { text, settled } = await captureText(p);
    return { text, settled, title: await p.title() };
  } catch (e) {
    return null;
  } finally {
    await p.close();
  }
}

// Normalisation shared by every quote comparison. The curly-quote lesson from the
// gails spot-check, plus ellipsis, which the original missed: a page rendering "…"
// would fail a quote typed as "...".
export const norm = (s) => s.normalize('NFC')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/…/g, '...')
  .replace(/ /g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
