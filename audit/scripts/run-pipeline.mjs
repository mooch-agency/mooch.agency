// Pipeline shape prototype: Haiku picks key pages -> parallel puppeteer innerText fetch ->
// ONE Opus judge call over the bundle -> code gate on the same bundle. Measures cost per stage.
// Saves picker input (full link list) + picks so a human can judge pick quality.
// Usage: node run-pipeline.mjs <site_url> <run_id> [picker_model]
import Anthropic from '@anthropic-ai/sdk';
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// fileURLToPath decodes percent-encoding (e.g. a space -> %20); using .pathname
// directly would write to a literal "%20" path that decoded readers can't find.
const OUT = fileURLToPath(new URL('./runs/', import.meta.url));
mkdirSync(OUT, { recursive: true });

// LLM engine (story 16). AUDIT_LLM=api (default) uses the SDK + ANTHROPIC_API_KEY:
// the measured, validated path. AUDIT_LLM=subscription shells out to `claude -p`
// on Tahi's subscription ($0 marginal, the R2 target); requires the claude CLI to
// be logged in. Both return { text, usage } so the rest of the pipeline is
// engine-blind; subscription cost is reported as 0.
const ENGINE = (process.env.AUDIT_LLM || 'api').toLowerCase();
const anthropic = ENGINE === 'api' ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function llmCall({ model, system, prompt, maxTokens, thinking }) {
  if (ENGINE === 'api') {
    const res = await anthropic.messages.create({
      model, max_tokens: maxTokens,
      ...(thinking ? { thinking } : {}),
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    return { text: res.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), usage: res.usage };
  }
  // subscription: claude -p, prompt on stdin, JSON envelope out for usage numbers.
  const { spawn } = await import('node:child_process');
  const args = ['-p', '--model', model, '--output-format', 'json'];
  if (system) args.push('--append-system-prompt', system);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`claude -p exited ${code}`));
      try {
        const j = JSON.parse(out);
        resolve({ text: j.result || '', usage: j.usage || { input_tokens: 0, output_tokens: 0 } });
      } catch (e) { reject(new Error(`claude -p output not JSON: ${String(out).slice(0, 200)}`)); }
    });
    child.stdin.end(prompt);
  });
}

const t0 = Date.now();
const PRICE = { 'claude-haiku-4-5': { in: 1, out: 5 }, 'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-opus-4-8': { in: 5, out: 25 } };
const PRICE_KEYS = Object.keys(PRICE);
const [site, runId = '1', pickerModel = 'claude-sonnet-4-6'] = process.argv.slice(2);
if (!site || !/^https?:\/\//.test(site)) { console.error('usage: node run-pipeline.mjs <site_url> [run_id] [picker_model]'); process.exit(2); }
if (!PRICE_KEYS.includes(pickerModel)) { console.error(`unknown picker model ${pickerModel}; known: ${PRICE_KEYS.join(', ')}`); process.exit(2); }
const slug = site.replace(/https?:\/\/(www\.)?/, '').split(/[/.]/)[0];
const tag = `${slug}_pipe_r${runId}`;
// Subscription runs cost $0 marginal; API runs are priced from the usage numbers.
const cost = (model, u) => ENGINE !== 'api' ? 0 : ((u.input_tokens * PRICE[model].in) + (u.output_tokens * PRICE[model].out)) / 1e6;

async function fetchPage(browser, url) {
  const p = await browser.newPage();
  await p.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  await p.setViewport({ width: 1280, height: 800 });
  try {
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await p.evaluate(async () => { await new Promise(r => { let t = 0; const i = setInterval(() => { window.scrollBy(0, 600); t += 600; if (t >= document.body.scrollHeight) { clearInterval(i); r(); } }, 80); }); window.scrollTo(0, 0); });
    await new Promise(r => setTimeout(r, 700));
    const title = await p.title();
    const text = await p.evaluate(() => document.body.innerText);
    const links = await p.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, label: (a.innerText || '').trim().slice(0, 60) })));
    await p.close(); return { url, title, text, links };
  } catch (e) { await p.close(); return { url, title: '', text: '', links: [], error: String(e).slice(0, 150) }; }
}

// A page is unusable if it errored, returned near-empty text, or shows a bot
// challenge instead of real content. These are the cases the fallback rescues.
const THIN_CHARS = 200;
const CHALLENGE = /verify (you are|you're) human|checking your browser|enable javascript to|access denied|are you a robot|captcha|cf-browser-verification|attention required/i;
function unusable(p) {
  return !p || p.error || !p.text || p.text.length < THIN_CHARS || CHALLENGE.test(p.text.slice(0, 1500));
}

// One retry with a longer settle: some pages are slow-hydrating SPAs or throw a
// transient interstitial that clears on a second, more patient load.
async function fetchWithRetry(browser, url) {
  const first = await fetchPage(browser, url);
  if (!unusable(first)) return first;
  await new Promise(r => setTimeout(r, 2500));
  const retry = await fetchPage(browser, url);
  return unusable(retry) ? first : retry;
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--disable-blink-features=AutomationControlled'] });
process.on('uncaughtException', async (e) => { console.error(e); try { await browser.close(); } catch {} process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error(e); try { await browser.close(); } catch {} process.exit(1); });

// STAGE 1: homepage fetch + link inventory.
const tFetch1 = Date.now();
const home = await fetchPage(browser, site);
const origin = new URL(site).origin;
const internal = []; const seen = new Set();
for (const l of home.links) {
  try {
    const u = new URL(l.href); if (u.origin !== origin) continue;
    const clean = (u.origin + u.pathname).replace(/\/$/, '');
    if (clean === (origin + '').replace(/\/$/, '') || seen.has(clean)) continue;
    seen.add(clean); internal.push({ url: clean, label: l.label });
  } catch {}
}
const stage1_ms = Date.now() - tFetch1;

// STAGE 2: picker model chooses up to 4 pages (home is always included as #5).
const pickerInput = `You select which pages of a small-business website to include in a content audit.
Website: ${site}
Homepage title: ${home.title}
Homepage visible text (for context):
${home.text.slice(0, 4000)}

Internal links found on the homepage (url | link label):
${internal.map(l => `${l.url} | ${l.label}`).join('\n').slice(0, 8000)}

Pick UP TO 4 links (the homepage is already included). Priority: revenue pages (pricing/shop/services/booking) > trust/conversion (about/contact) > support (FAQ/delivery/terms). For shops/e-commerce, collections and product pages ARE the revenue pages: include at least one. Prefer pages likely to carry claims, prices, or counts that can contradict other pages. Reply with ONLY a JSON array of URLs, e.g. ["https://..","https://.."].`;
const tPick = Date.now();
const pick = await llmCall({ model: pickerModel, prompt: pickerInput, maxTokens: 500 });
const pickText = pick.text;
let picked = [];
try { picked = JSON.parse(pickText.match(/\[[\s\S]*\]/)[0]).slice(0, 4); } catch {}
// Only fetch picks that exist in the homepage's internal-link inventory: blocks hallucinated or
// page-injected URLs from entering the judge context, and guarantees same-origin.
const allowed = new Set(internal.map(l => l.url));
picked = picked.map(u => String(u).replace(/\/$/, '')).filter(u => allowed.has(u));
const picker_ms = Date.now() - tPick, picker_cost = cost(pickerModel, pick.usage);

// STAGE 3: fetch picked pages, with a thin-text / bot-block fallback. A page that
// stays unusable after a longer-settle retry is swapped for the next-priority
// unused internal link, and the swap (or the skip) is recorded in coverage notes
// so the report can disclose exactly what was and wasn't read.
const tFetch2 = Date.now();
const coverageNotes = [];
const usedUrls = new Set([site.replace(/\/$/, ''), ...picked]);
const fallbackPool = internal.map(l => l.url).filter(u => !usedUrls.has(u));
// Fast path stays parallel: fetch all picked at once. Only the (rare) unusable
// ones fall through to sequential swapping, so the common case keeps its speed.
const initial = await Promise.all(picked.map((u, i) => fetchWithRetry(browser, u).then(p => [i, p])));
initial.sort((a, b) => a[0] - b[0]);
const good = [];
for (const [, page] of initial) {
  if (!unusable(page)) { good.push(page); continue; }
  let swapped = false;
  while (fallbackPool.length) {
    const alt = fallbackPool.shift();
    const altPage = await fetchWithRetry(browser, alt);
    if (!unusable(altPage)) {
      good.push(altPage);
      coverageNotes.push(`${page.url} was unreadable (bot-block or empty); audited ${alt} instead`);
      swapped = true;
      break;
    }
  }
  if (!swapped) coverageNotes.push(`${page.url} was unreadable and no readable substitute was available`);
}
if (unusable(home)) coverageNotes.push(`the homepage ${site} was unreadable (bot-block or empty); findings may be limited`);
const pages = [home, ...good].filter(p => p.text && p.text.length > THIN_CHARS);
const stage3_ms = Date.now() - tFetch2;

// Nothing readable = no audit. Without this, the judge would run on an empty
// bundle, return 0 findings, and the thin-report floor would emit "your site's
// in good shape" for a site we never read (story 13: never a half report).
// Exit 3 tells the runner "unreadable site, reply personally", distinct from
// exit 1 (crash).
if (pages.length === 0) {
  console.error(`No readable pages on ${site} (${coverageNotes.join('; ') || 'all fetches empty'}). Aborting before the judge.`);
  await browser.close().catch(() => {});
  process.exit(3);
}

// STAGE 4: programmatic hard-404 check on audited pages' internal links (status only), in parallel spirit but sequential here for simplicity.
const tLinks = Date.now();
const allLinks = [...new Set(pages.flatMap(p => p.links.map(l => { try { const u = new URL(l.href); return u.origin === origin ? (u.origin + u.pathname).replace(/\/$/, '') : null; } catch { return null; } }).filter(Boolean)))];
const linkResults = []; const unreachable = [];
for (const u of allLinks.slice(0, 60)) {
  try {
    const r = await fetch(u, { method: 'GET', redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, signal: AbortSignal.timeout(10000) });
    // Only definitive not-found statuses are reportable. 403/429/5xx are often bot-blocks or blips:
    // recording them as broken would violate the near-zero-FP rule, so they are logged, never reported.
    if (r.status === 404 || r.status === 410) linkResults.push({ url: u, status: r.status });
    else if (r.status >= 400) unreachable.push({ url: u, status: r.status });
  } catch { unreachable.push({ url: u, status: 'timeout/error' }); }
}
const links_ms = Date.now() - tLinks;
await browser.close().catch(() => {});

// STAGE 5: single Opus judge call over the bundle.
const SYSTEM = `You are a meticulous website content auditor. You receive the rendered VISIBLE text of several pages from ONE website. Find real content issues. Near-zero false positives: one wrong finding costs more than five missed ones.
FIND (on and ACROSS pages): pricing inconsistencies; cross-page contradictions (counts, names, claims, hours, dates); naming inconsistencies; spelling/grammar; visible formatting artifacts; stale content; factual errors. Cross-page contradictions are the highest value.
FACTUAL ERRORS are statements that are demonstrably, verifiably wrong: a cited law/regulation/standard that has been repealed or superseded, a plainly incorrect date or figure, a claim that is impossible or self-refuting. Flag ONLY when you are certain it is wrong from widely established fact; if it depends on the business's private data or you are not sure, do NOT flag it. Never guess. This is the highest-FP-risk category, so hold it to the strictest bar.
RULES: every finding = exact page URL + VERBATIM quote copied character-for-character from the provided text + severity + category. No paraphrase. Do NOT flag intentional design, responsive duplicates, HTML-level issues, or anything not quotable verbatim. Pricing: exact figure + billing period. "Including X and Y" = examples, not exhaustive.
END with ONE fenced json block: {"findings":[{"url","quote","evidence_type":"body|title","severity":"critical|high|medium|low","category":"contradiction|pricing|naming|spelling|grammar|stale|formatting|factual"}]}. Empty findings is valid.`;
const bundle = pages.map(p => `=== PAGE: ${p.url}\nTITLE: ${p.title}\n\n${p.text}`).join('\n\n');
const tJudge = Date.now();
const judge = await llmCall({ model: 'claude-opus-4-8', maxTokens: 16000, thinking: { type: 'adaptive' }, system: SYSTEM, prompt: `Website: ${site}\nAudit these ${pages.length} pages.\n\n${bundle}` });
const judgeText = judge.text;
let findings = [];
try { const blocks = [...judgeText.matchAll(/```json\s*([\s\S]*?)```/g)]; for (let i = blocks.length - 1; i >= 0; i--) { const j = JSON.parse(blocks[i][1]); if (Array.isArray(j.findings)) { findings = j.findings; break; } } } catch {}
const judge_ms = Date.now() - tJudge, judge_cost = cost('claude-opus-4-8', judge.usage);

// STAGE 6: code gate against the same bundle text (verbatim check).
const norm = (s) => (s || '').normalize('NFC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
const bodyByUrl = Object.fromEntries(pages.map(p => [p.url.replace(/\/$/, ''), norm(p.text)]));
const gated = findings.map(f => { const b = bodyByUrl[(f.url || '').replace(/\/$/, '')]; const pass = b ? b.includes(norm(f.quote)) : Object.values(bodyByUrl).some(x => x.includes(norm(f.quote))); return { ...f, gate: pass ? 'pass' : 'fail' }; });

const total_ms = Date.now() - t0;
const record = {
  tag, site, pickerModel,
  timing: { total_s: Math.round(total_ms / 1000), homepage_fetch_s: Math.round(stage1_ms / 1000), picker_s: Math.round(picker_ms / 1000), page_fetch_s: Math.round(stage3_ms / 1000), link_check_s: Math.round(links_ms / 1000), judge_s: Math.round(judge_ms / 1000) },
  cost: { picker: +picker_cost.toFixed(4), judge: +judge_cost.toFixed(4), total: +(picker_cost + judge_cost).toFixed(4) },
  picker: { input_links: internal, picked, pages_used: pages.map(p => p.url) },
  coverage: { notes: coverageNotes },
  link_check: { checked: Math.min(allLinks.length, 60), broken: linkResults, unreachable_not_reported: unreachable },
  findings: gated, n: gated.length, gate_pass: gated.filter(f => f.gate === 'pass').length, gate_fail: gated.filter(f => f.gate === 'fail').length,
  judge_usage: judge.usage,
};
writeFileSync(`${OUT}${tag}.json`, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ tag, total_s: record.timing.total_s, cost: record.cost, pages: pages.length, findings: record.n, gate_fail: record.gate_fail, broken_links: linkResults.length, picked }, null, 2));
