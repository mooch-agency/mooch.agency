// Settle-aware rendering reader. Same job as read-url.mjs — one URL, visible
// innerText — but it waits for the page to stop moving before it captures.
//
// Why this exists (31 Jul, arm C): read-url.mjs scrolls the page, scrolls back to
// top, waits a flat 700ms, and captures. On r3p.xyz that window lands in the middle
// of a scroll-triggered count-up, so the reader records "0.0M+ People using REP"
// where a real user sees "3.4M+". Verified in a real browser: the counters pass
// through 1.1M+ at ~2s and settle at 3.4M+.
//
// That is not a cosmetic difference. The pipeline's judge spends a rejection on
// those counters on every single r3p run, and arm B's auditor — reading the same
// mid-animation capture, and gated by an instrument that captures it the same way —
// shipped it as a CRITICAL contradiction against the hero stats. A verified false
// positive, produced entirely by the capture window.
//
// Fix: poll innerText until two consecutive reads match, then capture. Bounded, so
// a page with a live ticker (a clock, a feed) still returns rather than hanging;
// when the bound is hit the header says so, and anything quoted off that page
// deserves the suspicion.
//
// Usage: node render-read.mjs "https://example.com/page"
// Env:   READER_LOG   append each URL fetched (ground-truth coverage)
//        SETTLE_MAX_MS  give up waiting for stability (default 12000)
import puppeteer from 'puppeteer-core';
import { appendFileSync } from 'fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SETTLE_MAX = Number(process.env.SETTLE_MAX_MS || 12000);
const url = process.argv[2];
if (!url) { console.error('usage: node render-read.mjs <url>'); process.exit(2); }
if (process.env.READER_LOG) { try { appendFileSync(process.env.READER_LOG, url + '\n'); } catch {} }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
});
try {
  const p = await browser.newPage();
  await p.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

  // Scroll slowly, dwelling at each step, and leave the viewport where it lands
  // rather than snapping back to top.
  //
  // The speed is the whole fix, and it was measured, not guessed. read-url.mjs
  // scrolls 600px every 80ms; at that rate r3p's stat counters never fire at all
  // and the reader records a stable "0.0M+" — stable, so no amount of waiting
  // afterwards detects it. At 400px every 220ms the same counters fire and settle
  // to 3.4M+ / 30M+ / 8.5M+ / 24K+, matching what a human sees in a real browser.
  //
  // So the old reader's failure was never a settle-time problem. It was scrolling
  // past IntersectionObserver thresholds faster than they could trigger, which
  // makes "never animated" and "finished animating" look identical downstream.
  await p.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await sleep(220);
    }
  });

  // Settle: capture every 600ms until two consecutive captures are identical.
  const { text, settled, waited } = await p.evaluate(async (maxMs) => {
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
  }, SETTLE_MAX);

  const title = await p.title();
  const note = settled
    ? `SETTLED: yes (${waited}ms)`
    : `SETTLED: NO - page still changing after ${waited}ms; treat any number or counter on it as unreliable`;
  process.stdout.write(`URL: ${url}\nTITLE: ${title}\n${note}\n\n${text}\n`);
} catch (e) {
  process.stdout.write(`URL: ${url}\nFETCH_ERROR: ${String(e).slice(0, 200)}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
