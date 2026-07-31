// Stability gate: code-gate.mjs plus a second, independent capture.
//
// The problem it fixes (31 Jul, arm C). Once the auditor reads with a rendering
// browser, the original gate stops being an independent check: auditor and gate run
// the same puppeteer routine, so they share every blind spot and the gate degrades
// into a hallucination detector. On r3p that was not theoretical — arm B quoted a
// mid-animation "0.0M+ People using REP", the gate captured the same mid-animation
// frame, and a verified false positive shipped as CRITICAL.
//
// You cannot restore independence by swapping instruments: there is only one
// instrument that knows what is visible. So restore it in the time domain instead.
// Capture the page TWICE, seconds apart, on separate page loads, and require the
// quote in both. Text a user can actually read is stable across two loads. An
// animating counter, a rotating testimonial, a live feed, a randomised hero is not,
// and it is exactly that class the shared-instrument gate waves through.
//
// Verdicts:
//   PASS         in both captures
//   FAIL         in neither (hallucinated, paraphrased, or hidden markup)
//   UNSTABLE     in one but not the other -> the page changed under us; not the
//                same as a lie, but never safe to quote at a client
//   UNVERIFIABLE the page would not load; the gate could not look
//
// Usage: node code-gate-stable.mjs findings.json
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';

const { findings } = JSON.parse(readFileSync(process.argv[2], 'utf8'));

// Same normalisation as code-gate.mjs, deliberately: a gate that normalises
// differently from the one the pipeline ships would make the two arms
// incomparable for reasons that have nothing to do with the method.
const norm = (s) => s.normalize('NFC')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/ /g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
});

async function capture(url, settleMs) {
  const p = await browser.newPage();
  await p.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  await p.setViewport({ width: 1280, height: 800 });
  try {
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    // Same slow scroll as render-read.mjs, and it MUST be the same. The gate that
    // ships (code-gate.mjs) scrolls at 600px/80ms, which is too fast to fire an
    // IntersectionObserver, so it reads r3p's counters as "0.0M+" and would FAIL a
    // correct quote of "3.4M+" as hallucinated. A gate that is blinder than the
    // auditor rejects true findings, which is the worse of the two failure
    // directions: a false positive gets caught in review, a suppressed real finding
    // is invisible.
    await p.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await sleep(220); }
    });
    // Different dwell per capture. Identical dwell would reproduce the same
    // animation frame twice and agree with itself, which is the bug.
    await new Promise((r) => setTimeout(r, settleMs));
    return norm(await p.evaluate(() => document.body.innerText));
  } catch { return null; } finally { await p.close(); }
}

const urls = [...new Set(findings.map(f => f.url))];
const shots = {};
for (const url of urls) {
  const a = await capture(url, 1500);
  const b = await capture(url, 6000);
  shots[url] = [a, b];
}
await browser.close();

let pass = 0, fail = 0, unstable = 0, unver = 0;
for (const f of findings) {
  const [a, b] = shots[f.url] || [null, null];
  const tag = f.label ? ` [${f.label}]` : '';
  const q = norm(f.quote);
  if (a === null && b === null) { unver++; console.log(`UNVERIFIABLE${tag} | ${f.url} | page fetch failed`); continue; }
  const inA = a !== null && a.includes(q);
  const inB = b !== null && b.includes(q);
  if (inA && inB) { pass++; console.log(`PASS${tag} | ${f.url} | ${f.quote.slice(0, 55)}`); }
  else if (inA || inB) { unstable++; console.log(`UNSTABLE${tag} | ${f.url} | present in one capture, absent in the other | ${f.quote.slice(0, 55)}`); }
  else { fail++; console.log(`FAIL${tag} | ${f.url} | ${f.quote.slice(0, 55)}`); }
}
console.log(`\ngate result: ${pass} pass, ${fail} fail, ${unstable} unstable, ${unver} unverifiable of ${findings.length}`);
