// Agentic reader: one URL -> rendered visible innerText on stdout.
// Same instrument as the code gate, and now literally the same code: both call
// captureText() from capture.mjs, so the reader and its checker cannot drift apart.
// If READER_LOG is set, append the URL fetched (ground-truth coverage count, not
// self-report). UA-masked so Cloudflare-fronted sites do not challenge.
// Usage: node read-url.mjs "https://example.com/page"
import puppeteer from 'puppeteer-core';
import { appendFileSync } from 'fs';
import { CHROME, LAUNCH_ARGS, preparePage, captureText } from './capture.mjs';

const url = process.argv[2];
if (!url) { console.error('usage: node read-url.mjs <url>'); process.exit(2); }
if (process.env.READER_LOG) { try { appendFileSync(process.env.READER_LOG, url + '\n'); } catch {} }

const browser = await puppeteer.launch({ executablePath: CHROME(), headless: 'new', args: LAUNCH_ARGS });
try {
  const p = await browser.newPage();
  await preparePage(p);
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  const { text, settled, waited } = await captureText(p);
  const title = await p.title();
  // Announce an unsettled page rather than hiding it. A page still changing when
  // we gave up is one whose numbers are a frame, not a fact.
  const note = settled
    ? `SETTLED: yes (${waited}ms)`
    : `SETTLED: NO - still changing after ${waited}ms; treat any counter or live value here as unreliable`;
  process.stdout.write(`URL: ${url}\nTITLE: ${title}\n${note}\n\n${text}\n`);
} catch (e) {
  process.stdout.write(`URL: ${url}\nFETCH_ERROR: ${String(e).slice(0, 200)}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
