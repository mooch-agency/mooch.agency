// Agentic reader for the A/B shape test: one URL -> rendered visible innerText on stdout.
// Same instrument as the code gate. If READER_LOG is set, append the URL fetched (ground-truth
// coverage count, not self-report). UA-masked so Cloudflare-fronted sites do not challenge.
// Usage: node read-url.mjs "https://example.com/page"
import puppeteer from 'puppeteer-core';
import { appendFileSync } from 'fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2];
if (!url) { console.error('usage: node read-url.mjs <url>'); process.exit(2); }
if (process.env.READER_LOG) { try { appendFileSync(process.env.READER_LOG, url + '\n'); } catch {} }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--disable-blink-features=AutomationControlled'],
});
try {
  const p = await browser.newPage();
  await p.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await p.evaluate(async () => { await new Promise(r => { let t = 0; const i = setInterval(() => { window.scrollBy(0, 600); t += 600; if (t >= document.body.scrollHeight) { clearInterval(i); r(); } }, 80); }); window.scrollTo(0, 0); });
  await new Promise(r => setTimeout(r, 700));
  const title = await p.title();
  const text = await p.evaluate(() => document.body.innerText);
  process.stdout.write(`URL: ${url}\nTITLE: ${title}\n\n${text}\n`);
} catch (e) {
  process.stdout.write(`URL: ${url}\nFETCH_ERROR: ${String(e).slice(0, 200)}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
