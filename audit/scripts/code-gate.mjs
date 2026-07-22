// Code gate: verify every finding's verbatim quote appears in the cited page's RENDERED text.
// Catches: hallucinated quotes, hidden-DOM quotes (present in source, invisible to users), stale evidence.
// Usage: node code-gate.mjs findings.json
// findings.json: {"findings":[{"url":"...","quote":"...","label":"optional"}]}
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';

const { findings } = JSON.parse(readFileSync(process.argv[2], 'utf8'));

// Normalisation: the curly-quote lesson from the gails spot-check. Exact match after
// unicode NFC, curly->straight quotes, dash unification, whitespace collapse.
const norm = (s) => s.normalize('NFC')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/ /g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
});

// Fetch each unique URL once.
const urls = [...new Set(findings.map(f => f.url))];
const pageText = {};
for (const url of urls) {
  const p = await browser.newPage();
  await p.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  await p.setViewport({ width: 1280, height: 800 });
  try {
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await p.evaluate(async () => { await new Promise(r => { let t = 0; const i = setInterval(() => { window.scrollBy(0, 600); t += 600; if (t >= document.body.scrollHeight) { clearInterval(i); r(); } }, 80); }); });
    await new Promise(r => setTimeout(r, 800));
    pageText[url] = norm(await p.evaluate(() => document.body.innerText));
  } catch (e) {
    pageText[url] = null; // unreachable -> findings on it are UNVERIFIABLE, never FAILED
  }
  await p.close();
}
await browser.close();

let pass = 0, fail = 0, unver = 0;
for (const f of findings) {
  const text = pageText[f.url];
  const tag = f.label ? ` [${f.label}]` : '';
  if (text === null) { unver++; console.log(`UNVERIFIABLE${tag} | ${f.url} | page fetch failed`); continue; }
  if (text.includes(norm(f.quote))) { pass++; console.log(`PASS${tag} | ${f.url} | ${f.quote.slice(0, 55)}`); }
  else { fail++; console.log(`FAIL${tag} | ${f.url} | ${f.quote.slice(0, 55)}`); }
}
console.log(`\ngate result: ${pass} pass, ${fail} fail, ${unver} unverifiable of ${findings.length}`);
