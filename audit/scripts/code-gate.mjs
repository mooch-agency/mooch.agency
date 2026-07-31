// Code gate: verify every finding against the cited page as a real browser renders it.
//
// Two kinds of finding, two kinds of check:
//
//   quote findings   -> the verbatim quote must appear in the rendered text. This is
//                       the client-facing guarantee: they will ctrl-F your quote on
//                       their own page, and if it is not there the audit is dead.
//   absence findings -> there is no quote to check ("the blog renders no posts").
//                       Classified against a 404 control probe instead. See
//                       absence-check.mjs.
//
// Catches: hallucinated quotes, silently reworded quotes, hidden-DOM quotes (present
// in source, invisible to users), stale evidence, and absence claims that turn out to
// be the auditor failing to read rather than the site failing to render.
//
// Usage: node code-gate.mjs findings.json [site_url]
// findings.json: {"findings":[
//   {"url":"...","quote":"...","label":"optional"},
//   {"url":"...","absence_claim":"missing|empty|wrong_page","label":"optional"}
// ]}
// site_url is required if any finding is an absence finding (the control probe needs
// an origin); it otherwise defaults to the origin of the first finding's URL.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';
import { CHROME, LAUNCH_ARGS, loadAndCapture, norm } from './capture.mjs';
import { checkAbsence } from './absence-check.mjs';

const { findings } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const siteUrl = process.argv[3] || (findings[0] && new URL(findings[0].url).origin) || null;

const browser = await puppeteer.launch({ executablePath: CHROME(), headless: 'new', args: LAUNCH_ARGS });

const isAbsence = (f) => !!f.absence_claim;

// Fetch each unique URL once. Shared with the absence checker so a page cited by
// both a quote finding and an absence finding is not loaded twice.
const cache = {};
for (const url of [...new Set(findings.filter(f => !isAbsence(f)).map(f => f.url))]) {
  if (!(url in cache)) cache[url] = await loadAndCapture(browser, url);
}

let pass = 0, fail = 0, unver = 0;
for (const f of findings) {
  const tag = f.label ? ` [${f.label}]` : '';
  if (isAbsence(f)) {
    const r = await checkAbsence(browser, siteUrl, f, cache);
    if (r.verdict === 'PASS') { pass++; console.log(`PASS${tag} | ${f.url} | absence:${f.absence_claim} | ${r.detail}`); }
    else if (r.verdict === 'UNVERIFIABLE') { unver++; console.log(`UNVERIFIABLE${tag} | ${f.url} | ${r.detail}`); }
    else { fail++; console.log(`FAIL${tag} | ${f.url} | claimed ${f.absence_claim}, actually ${r.actual} | ${r.detail}`); }
    continue;
  }
  const cap = cache[f.url];
  // Unreachable -> findings on it are UNVERIFIABLE, never FAILED. "We could not
  // look" and "we looked and it was not there" must never collapse into each other.
  if (!cap) { unver++; console.log(`UNVERIFIABLE${tag} | ${f.url} | page fetch failed`); continue; }
  if (norm(cap.text).includes(norm(f.quote))) { pass++; console.log(`PASS${tag} | ${f.url} | ${f.quote.slice(0, 55)}`); }
  else { fail++; console.log(`FAIL${tag} | ${f.url} | ${f.quote.slice(0, 55)}`); }
}

await browser.close();
console.log(`\ngate result: ${pass} pass, ${fail} fail, ${unver} unverifiable of ${findings.length}`);
