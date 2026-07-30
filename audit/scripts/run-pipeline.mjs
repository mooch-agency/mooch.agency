// Pipeline shape prototype: Haiku picks key pages -> parallel puppeteer innerText fetch ->
// ONE Opus judge call over the bundle -> code gate on the same bundle. Measures cost per stage.
// Saves picker input (full link list) + picks so a human can judge pick quality.
// Usage: node run-pipeline.mjs <site_url> <run_id> [picker_model]
import Anthropic from '@anthropic-ai/sdk';
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { THIN_CHARS, unusable, fetchWithRetry, resolveWithSwaps } from './page-fallback.mjs';
import { sameSiteFactory, sameDomainFactory, cleanUrl, buildInventory, onLandedHost } from './discovery.mjs';
import { statusOfFactory, REPORTABLE } from './link-check.mjs';
import { buildBundle } from './bundle.mjs';
import { parseJudge } from './judge-parse.mjs';

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

async function llmCall({ model, system, prompt, maxTokens, thinking, effort }) {
  if (ENGINE === 'api') {
    // Streamed, then reassembled. The SDK refuses a non-streaming request whose
    // projected duration exceeds 10 minutes, which the judge's token budget now
    // crosses. finalMessage() gives back the same Message shape, so nothing
    // downstream changes.
    //
    // No temperature anywhere: Sonnet 5 and Opus 4.8 both reject a non-default
    // temperature/top_p/top_k with a 400. Steer these calls by prompt only.
    const res = await anthropic.messages.stream({
      model, max_tokens: maxTokens,
      ...(thinking ? { thinking } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }).finalMessage();
    return {
      text: res.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
      thinking: res.content.filter(b => b.type === 'thinking').map(b => b.thinking).join('\n'),
      usage: res.usage,
      // 'max_tokens' here means the response was cut off mid-sentence. The judge's
      // JSON block then has no closing fence and parses to nothing, which used to
      // look exactly like a clean site.
      stop_reason: res.stop_reason,
    };
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
        resolve({ text: j.result || '', thinking: '', usage: j.usage || { input_tokens: 0, output_tokens: 0 } });
      } catch (e) { reject(new Error(`claude -p output not JSON: ${String(out).slice(0, 200)}`)); }
    });
    child.stdin.end(prompt);
  });
}

const t0 = Date.now();
// Standard list rates. Sonnet 5 has introductory pricing ($2/$10) through
// 2026-08-31; we bill ourselves at the standard rate so the numbers on a record
// don't quietly rise when the intro period ends. `effort` marks models that accept
// output_config.effort: Haiku 4.5 rejects it with a 400, so the picker must not
// send it when running on Haiku.
const PRICE = {
  'claude-haiku-4-5': { in: 1, out: 5, effort: false },
  'claude-sonnet-4-6': { in: 3, out: 15, effort: true },
  'claude-sonnet-5': { in: 3, out: 15, effort: true },
  'claude-opus-4-8': { in: 5, out: 25, effort: true },
};
const PRICE_KEYS = Object.keys(PRICE);
const [site, runId = '1', pickerModel = 'claude-sonnet-5'] = process.argv.slice(2);
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
    // Where the page ACTUALLY ended up. An apex -> www redirect (or the reverse)
    // changes the origin every downstream comparison keys off, so callers need
    // the landed URL, not the one we asked for. `requested` is kept so a caller
    // can still tell which pick this page answers.
    const landed = p.url() || url;
    await p.close(); return { url: landed, requested: url, title, text, links };
  } catch (e) { await p.close(); return { url, requested: url, title: '', text: '', links: [], error: String(e).slice(0, 150) }; }
}

// Thin-text / bot-block fallback lives in its own module so it can be unit-tested
// without a browser (see page-fallback.test.mjs).

// ── Page-DISCOVERY fallbacks ────────────────────────────────────────────────
// These only decide WHICH pages to read (the inventory the picker chooses from);
// they never provide content for findings. The audit still reads rendered text
// via puppeteer and every quote is gate-checked, so the no-hidden-DOM rule holds.
// They run only when the rendered homepage yields zero internal links (a soft
// bot-block or a JS nav that never hydrated), where the audit would otherwise
// silently collapse to the homepage alone.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
async function fetchText(u) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    return r.ok ? await r.text() : '';
  } catch { return ''; }
}
// sameSiteFactory + cleanUrl live in discovery.mjs so the host-matching rules
// are unit-testable. Sitemaps often list the apex while the audited URL is www
// (or vice-versa), so everything here matches on the registrable host.

// Fallback 1: parse anchors from the SERVER HTML (a plain fetch, pre-JS). Recovers
// SSR nav that the headless browser was served without or stripped.
async function inventoryFromRawHtml(site) {
  const sameSite = sameSiteFactory(site);
  const html = await fetchText(site);
  if (!html) return [];
  const homeClean = cleanUrl(site);
  const seen = new Set(); const inv = [];
  for (const m of html.matchAll(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href; try { href = new URL(m[1], site).href; } catch { continue; }
    if (!sameSite(href)) continue;
    let clean; try { clean = cleanUrl(href); } catch { continue; }
    if (clean === homeClean || seen.has(clean)) continue;
    seen.add(clean); inv.push({ url: clean, label: m[2].replace(/<[^>]+>/g, '').trim().slice(0, 60) });
  }
  return inv;
}

// Fallback 2: robots.txt Sitemap: line, then /sitemap.xml and /sitemap_index.xml.
// Handles a <sitemapindex> by fetching a few child sitemaps (page-* first).
async function inventoryFromSitemap(site) {
  const sameSite = sameSiteFactory(site);
  const origin = new URL(site).origin;
  const candidates = [];
  const robots = await fetchText(origin + '/robots.txt');
  for (const m of robots.matchAll(/sitemap:\s*(\S+)/gi)) candidates.push(m[1].trim());
  candidates.push(origin + '/sitemap.xml', origin + '/sitemap_index.xml');
  const tried = new Set(); const pageUrls = new Set();
  for (const sm of candidates) {
    if (tried.has(sm)) continue; tried.add(sm);
    const xml = await fetchText(sm);
    if (!xml.includes('<loc')) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
    if (/<sitemapindex/i.test(xml)) {
      const kids = locs.sort((a, b) => (b.includes('page') ? 1 : 0) - (a.includes('page') ? 1 : 0)).slice(0, 3);
      for (const k of kids) { if (tried.has(k)) continue; tried.add(k); const cx = await fetchText(k); for (const m of cx.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) pageUrls.add(m[1]); }
    } else {
      for (const l of locs) pageUrls.add(l);
    }
    if (pageUrls.size) break;
  }
  const homeClean = cleanUrl(site);
  const seen = new Set(); const inv = [];
  for (const u of pageUrls) {
    if (!sameSite(u)) continue;
    let clean; try { clean = cleanUrl(u); } catch { continue; }
    if (clean === homeClean || seen.has(clean)) continue;
    seen.add(clean); inv.push({ url: clean, label: '' });
  }
  return inv;
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'] });
process.on('uncaughtException', async (e) => { console.error(e); try { await browser.close(); } catch {} process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error(e); try { await browser.close(); } catch {} process.exit(1); });
// The fallback helpers take an injected fetcher so tests can swap the browser out.
const fetchRaw = (url) => fetchPage(browser, url);

// STAGE 1: homepage fetch + link inventory.
const tFetch1 = Date.now();
// fetchWithRetry, not a bare fetchPage. Every OTHER page in the run has had a
// settle-retry for months; the homepage, the one page that is always audited and
// usually carries the hero, the pricing and the primary CTA, had none. One
// transient interstitial and the audit lost its most valuable page, kept going,
// and (before the honesty gate) could still tell the client their site was in
// good shape. Observed on apexvolumetrics, 30 Jul: 2 runs, both "homepage
// unreadable", and a third run minutes later read it fine.
// Longer settle than the default: an anti-bot interstitial takes longer to clear
// than a slow hydration, and this page is worth the extra seconds.
let home = await fetchWithRetry((u) => fetchPage(browser, u), site, { settleMs: 6000 });
// Everything downstream compares hosts: the link inventory, the soft-404 probe
// and the on-page link check. Key them off where the homepage LANDED, not the
// URL the lead submitted. An apex -> www redirect otherwise bins every rendered
// anchor, and the audit collapses to the homepage without saying so.
const landedUrl = home.url || site;
const sameSite = sameSiteFactory(landedUrl);
const homeUrl = cleanUrl(landedUrl);
let internal = buildInventory(home, landedUrl);
// If the direct fetch comes back unusable, retry once on the host the homepage
// actually landed on before this page is written off as unreadable and swapped
// for a different one (see onLandedHost in discovery.mjs for why). A failed
// redirect hop is not evidence the PAGE is bad, and letting it look that way is
// why two runs of one site could read different pages and reach different
// verdicts on the same evidence.
//
// fetchOne is itself wrapped in fetchWithRetry at every call site (a second
// attempt on the SAME url after a longer settle, for slow-hydrating pages -
// a different failure class than a bad host). Without altHostFailed, a page
// unusable on both host and settle grounds would cost 4 raw fetches (raw, alt,
// then raw, alt again) instead of 2, on exactly the flaky-host sites this exists
// for. Once the alt host has failed once for a URL, skip it on later calls and
// let the settle-retry do only what it is actually for: waiting, not re-asking
// a host that already said no.
const altHostFailed = new Set();
async function fetchOne(url) {
  const first = await fetchRaw(url);
  if (!unusable(first)) return first;
  const alt = onLandedHost(url, landedUrl);
  if (alt === url || altHostFailed.has(url)) return first;
  const retry = await fetchRaw(alt);
  if (unusable(retry)) { altHostFailed.add(url); return first; }
  return retry;
}
// Homepage text present but zero internal links means the nav hadn't rendered
// when we snapshotted (late-hydrating menu). Without this, every picked page is
// filtered out against an empty inventory and the audit silently degrades to the
// homepage alone. One patient refetch recovers the links.
let discovery = 'dom';
if (internal.length === 0 && home.text && home.text.length > 200) {
  const retry = await fetchWithRetry(fetchOne, site);
  if (retry.links && retry.links.length) { home = retry; internal = buildInventory(home, landedUrl); }
}
// Discovery fallbacks when the rendered nav is missing: server HTML, then sitemap.
// Both run against the landed URL so a redirecting site resolves its own robots
// and sitemap, not the pre-redirect origin's.
if (internal.length === 0) { internal = await inventoryFromRawHtml(landedUrl); if (internal.length) discovery = 'raw-html'; }
if (internal.length === 0) { internal = await inventoryFromSitemap(landedUrl); if (internal.length) discovery = 'sitemap'; }
// Nothing found anywhere. Say so, rather than leaving 'dom' to claim the
// rendered navigation supplied pages on precisely the runs where it supplied none.
if (internal.length === 0) discovery = 'none';
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
// AUDIT_PIN_PAGES=/refund-policy,/terms,/data-integrity (bare paths or full
// URLs, comma-separated) bypasses the picker LLM call and reads these pages
// instead. Matched by pathname, not exact URL, so a pin survives the inventory
// carrying a different host form than the one you typed.
//
// This exists to isolate a pipeline fix from picker variance: run the same page
// set before and after a fix and any difference in findings is attributable to
// the fix, not to the picker choosing differently between runs. A debugging aid
// for verifying a specific fix, not the steady state - unset it once satisfied
// and let the picker choose normally again.
const pinEnv = process.env.AUDIT_PIN_PAGES;
let picked, pick, pinned = false;
if (pinEnv) {
  pinned = true;
  const wantPaths = pinEnv.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    try { return new URL(s, site).pathname.replace(/\/$/, '') || '/'; } catch { return s; }
  });
  const byPath = (u) => { try { return new URL(u).pathname.replace(/\/$/, '') || '/'; } catch { return u; } };
  picked = wantPaths
    .map((path) => internal.find((l) => byPath(l.url) === path)?.url)
    .filter(Boolean)
    .slice(0, 4);
  // The homepage is always read and is deliberately absent from `internal`
  // (buildInventory drops it so the picker cannot pick the page it already has),
  // so pinning "/" is legitimate and must not count as missing. Without this the
  // hard-fail below rejects every pin list that includes the homepage, which is
  // most of them: it killed a noise-floor run within minutes of being written.
  const homePath = byPath(homeUrl);
  const missed = wantPaths.filter(
    (path) => path !== homePath && !internal.some((l) => byPath(l.url) === path)
  );
  // A PIN THAT CANNOT BE HONOURED IS A FAILED RUN, not a quieter one. This used
  // to warn on stderr and carry on with whatever did match, which silently
  // audits a DIFFERENT page set than the one you pinned. On 30 Jul that voided
  // an apexvolumetrics arm of a prompt experiment (pinned 5 www URLs, read 4
  // other pages) and the comparison looked valid until the page lists were
  // diffed by hand. The whole point of pinning is holding evidence constant, so
  // failing loudly is the only useful behaviour.
  // AUDIT_PIN_LENIENT=1 restores best-effort matching for exploratory use.
  if (missed.length && process.env.AUDIT_PIN_LENIENT !== '1') {
    console.error(`AUDIT_PIN_PAGES could not be honoured: ${missed.length} of ${wantPaths.length} pinned pages are not in this site's inventory.`);
    console.error(`  missing: ${missed.join(', ')}`);
    console.error(`  inventory has: ${internal.slice(0, 12).map((l) => byPath(l.url)).join(', ')}${internal.length > 12 ? ', ...' : ''}`);
    console.error('Auditing a different page set than the one pinned would invalidate whatever this run is measuring.');
    console.error('Fix the paths, or set AUDIT_PIN_LENIENT=1 to accept a partial match.');
    await browser.close().catch(() => {});
    process.exit(4);
  }
  if (missed.length) console.error(`[picker pinned, LENIENT] not in the inventory, skipped: ${missed.join(', ')}`);
  console.error(`[picker pinned] ${picked.join(', ') || '(none matched)'}`);
} else {
  // Thinking OFF, explicitly. On Sonnet 4.6 omitting `thinking` meant no
  // thinking; on Sonnet 5 the same call runs adaptive, and thinking spends from
  // the same 500 tokens as the answer. A picker that thinks would truncate its
  // own JSON array and hand back picked: [], which is the failure we chased for
  // two days. Effort low because choosing 4 links off a labelled list is not
  // hard. Temperature would be the obvious way to pin this down, but Sonnet 5
  // rejects a non-default temperature with a 400, so the picks stay
  // model-chosen: the remedy for a bad pick is the judge log, not a sampling
  // parameter.
  pick = await llmCall({
    model: pickerModel, prompt: pickerInput, maxTokens: 500,
    thinking: { type: 'disabled' },
    ...(PRICE[pickerModel].effort ? { effort: 'low' } : {}),
  });
  const pickText = pick.text;
  if (process.env.AUDIT_DEBUG) console.error('[picker raw]', JSON.stringify(pickText));
  try { picked = JSON.parse(pickText.match(/\[[\s\S]*\]/)[0]).slice(0, 4); } catch { picked = []; }
}
// Only fetch picks that exist in the homepage's internal-link inventory: blocks hallucinated or
// page-injected URLs from entering the judge context, and guarantees same-origin.
const allowed = new Set(internal.map(l => l.url));
picked = picked.map(u => String(u).replace(/\/$/, '')).filter(u => allowed.has(u));
const picker_ms = Date.now() - tPick, picker_cost = pinned ? 0 : cost(pickerModel, pick.usage);

// STAGE 3: fetch picked pages, with a thin-text / bot-block fallback. A page that
// stays unusable after a longer-settle retry is swapped for the next-priority
// unused internal link, and the swap (or the skip) is recorded in coverage notes
// so the report can disclose exactly what was and wasn't read.
const tFetch2 = Date.now();
const coverageNotes = [];
// Seeded with the LANDED homepage: on a redirecting site the submitted URL is a
// different string, and the homepage would leak back into the fallback pool and
// get audited twice.
const usedUrls = new Set([homeUrl, site.replace(/\/$/, ''), ...picked]);
const fallbackPool = internal.map(l => l.url).filter(u => !usedUrls.has(u));
// Fast path stays parallel: fetch all picked at once. Only the (rare) unusable
// ones fall through to sequential swapping, so the common case keeps its speed.
const initial = await Promise.all(picked.map((u, i) => fetchWithRetry(fetchOne, u).then(p => [i, p])));
initial.sort((a, b) => a[0] - b[0]);
const { good, notes: swapNotes } = await resolveWithSwaps({
  initial: initial.map(([, p]) => p),
  fallbackPool,
  fetchOne,
});
coverageNotes.push(...swapNotes);
// The homepage note is deliberately blunt. It is the page most likely to carry
// the claims an audit is for, so losing it is not a minor coverage caveat: the
// honesty gate reads these notes and downgrades the whole verdict to
// inconclusive rather than let a run this incomplete certify a site.
if (unusable(home)) coverageNotes.push(`the homepage ${site} was unreadable even after a retry (bot-block or empty); this is the page most likely to carry pricing and headline claims, so findings are significantly limited`);
else if (internal.length === 0) coverageNotes.push(`only the homepage could be read; its navigation links did not load, so deeper pages were not audited`);
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
// SOFT-404 GUARD: some sites return a 404 STATUS for pages that still load fine,
// serving a shell that hydrates (or client-side redirects) to real content. On
// those origins the HTTP status is meaningless, so a status-based "broken link"
// is a false positive. Evidence (anglianphe.co.uk, 23 Jul): /contact returns 404
// to a plain GET but JS-redirects to a live /contact-us/, and an AUDITED page
// (/locations/colchester/shower-repair) returns the SAME 404. We detect this by
// re-fetching the pages we KNOW are real (pages_used): if the server 404s any of
// them, its codes can't be trusted and we suppress the broken-links section
// rather than ship phantom findings. Near-zero false positives is the whole point.
const tLinks = Date.now();
const LINK_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
// Memoised so a URL probed as an audited page isn't re-fetched when it also shows
// up in the on-page link inventory below. Classification (dead_domain vs
// transient error, one DNS retry) lives in link-check.mjs where it is
// unit-tested; this only supplies the real fetch.
const statusOf = statusOfFactory((u) =>
  fetch(u, { method: 'GET', redirect: 'follow', headers: { 'user-agent': LINK_UA }, signal: AbortSignal.timeout(10000) })
);
// Probe the audited pages first, in parallel. A not-found status on a page we
// successfully read proves the origin soft-404s and disqualifies status-based
// link checking this run. cleanUrl-normalised so keys align with allLinks (below)
// and the memoised statusOf dedupes the overlap.
const auditedSameOrigin = [...new Set(pages.map(p => p.url).filter(sameSite).map(cleanUrl))];
const softNotFound = (await Promise.all(auditedSameOrigin.map(statusOf))).some(s => s === 404 || s === 410);
// sameDomain, not sameSite: the link CHECK covers subdomains of the client's
// domain (a dead quiz.example.com CTA is the client's own broken link), while
// page discovery stays strict. Item 2 of the recall-gap ticket.
const sameDomain = sameDomainFactory(pages[0]?.url || site);
const allLinks = [...new Set(pages.flatMap(p => p.links.map(l => { try { return sameDomain(l.href) ? cleanUrl(l.href) : null; } catch { return null; } }).filter(Boolean)))];
const linkResults = []; const unreachable = [];
// On a soft-404 origin the HTTP status is meaningless, so skip status-based link
// reporting entirely. Recorded internally via link_check.soft_404 (+ note), never
// surfaced to the client. Otherwise check each on-page link.
// Note dead_domain is NOT gated by soft-404: a soft-404 origin lies with HTTP
// statuses, but NXDOMAIN is a DNS answer, which the origin cannot fake.
if (!softNotFound) {
  for (const u of allLinks.slice(0, 60)) {
    const s = await statusOf(u);
    // Only REPORTABLE statuses (404/410/dead_domain) reach the client. 403/429/5xx
    // are often bot-blocks or blips: logged, never reported (near-zero-FP rule).
    if (REPORTABLE.has(s)) linkResults.push({ url: u, status: s });
    else if (typeof s === 'number' && s >= 400) unreachable.push({ url: u, status: s });
    else if (s === 'error') unreachable.push({ url: u, status: 'timeout/error' });
  }
}
const links_ms = Date.now() - tLinks;
await browser.close().catch(() => {});

// STAGE 5: single Opus judge call over the bundle.
const SYSTEM = `You are a meticulous website content auditor. You receive the rendered VISIBLE text of several pages from ONE website. Find real content issues. Near-zero false positives: one wrong finding costs more than five missed ones.
FIND (on and ACROSS pages): pricing inconsistencies; cross-page contradictions (counts, names, claims, hours, dates); naming inconsistencies; spelling/grammar; visible formatting artifacts; stale content; factual errors. Cross-page contradictions are the highest value.
Each page may end with a LINKS list (link text -> destination). Use it for link-level content faults: a call to action pointing at a destination marked [BROKEN], the same label pointing to two different destinations across pages, or link text that contradicts where it goes. A [BROKEN] marker is the link checker's own verified result, so you may state it as fact. Never infer a link is broken from the look of its URL, and never treat a section as empty because you cannot see its text: content that opens on click is not missing. For a link finding the "quote" must be the link's TEXT exactly as it appears in the page text above, never the "text -> destination" line; put the destination in "issue".
FACTUAL ERRORS are statements that are demonstrably, verifiably wrong: a cited law/regulation/standard that has been repealed or superseded, a plainly incorrect date or figure, a claim that is impossible or self-refuting. Flag ONLY when you are certain it is wrong from widely established fact; if it depends on the business's private data or you are not sure, do NOT flag it. Never guess. This is the highest-FP-risk category, so hold it to the strictest bar.
RULES: every finding = exact page URL + VERBATIM quote copied character-for-character from the provided text + severity + category + issue. No paraphrase in the quote. Do NOT flag intentional design, responsive duplicates, HTML-level issues, or anything not quotable verbatim. Pricing: exact figure + billing period. "Including X and Y" = examples, not exhaustive.
For contradiction, pricing and naming findings, ALSO include "quote2": the OTHER verbatim line it conflicts with (same character-for-character rule), plus "url2" when that line is on a different page. A contradiction you cannot quote from both sides is not a finding.
ISSUE: one short plain-English sentence naming exactly what is wrong, in your own words. Name the specific problem: the misspelled word, the two figures that disagree, the outdated claim. Concrete enough to get in 3 seconds. For spelling/grammar, include the correction ("sumptous" should be "sumptuous"). For everything else, diagnose only; do not rewrite their copy (that conversation is the engagement).
The remaining fields are for OUR internal reviewer, never shown to the client. They exist so a human can audit your judgement without re-reading the site, so do not restate the issue in them. Write them for a colleague who will challenge you.
CHECK: per finding, ONE line, max 15 words, naming the evidence that makes it certain (e.g. "both bullets in the same terms list, one promo").
REASONING: per finding, 2 to 4 sentences on HOW you got there. Say what in the page text put you onto it, what innocent explanation you tested (a second promo, a deliberate variant, a regional difference, an intentional repeat) and what in the text rules that explanation out, and why you set that severity rather than one higher or lower. If something is still uncertain, say so plainly and say what you would need to settle it.
APPROACH: one top-level "approach", 2 to 3 sentences: what you compared across these pages, and anything about the site that limited what you could check (thin pages, duplicated boilerplate, text you could see but could not attribute to a page).
REJECTED: one top-level "rejected", an array of one-line strings, max 20 words each, max 6 entries, for anything you considered and deliberately did NOT flag, WITH the reason (e.g. "repeated nav labels: template, not a content error"). This is how we spot a judge that is too shy or too keen. Empty array is valid.
END with ONE fenced json block: {"approach":"...","findings":[{"url","quote","quote2","url2","evidence_type":"body|title","severity":"critical|high|medium|low","category":"contradiction|pricing|naming|spelling|grammar|stale|formatting|factual","issue":"...","check":"...","reasoning":"..."}],"rejected":["..."]}. quote2/url2 only where required above. Empty findings is valid.`;
// Item 4: destinations enter the evidence, with the link checker's verdict
// attached where it has one. See bundle.mjs for what is deliberately NOT added.
const bundle = buildBundle(pages, linkResults);
const tJudge = Date.now();
// 32k, not 16k: adaptive thinking spends from the same budget, and since the
// judge started carrying quote2 + reasoning + approach + rejected, a five-page
// bundle overran 16k and came back cut off mid-JSON.
// display: 'summarized' is load-bearing on the API path, not decoration. On Opus
// 4.8 `display` defaults to 'omitted', which still returns thinking blocks but
// with EMPTY text. Note this is a readable SUMMARY - the raw chain of thought is
// never returned on this model.
//
// IT ONLY APPLIES TO ENGINE=api. The `thinking` argument below is dropped on the
// floor when AUDIT_LLM=subscription, because that path shells out to `claude -p`,
// which has no thinking parameter and emits no thinking blocks. Verified 30 Jul
// on claude-opus-4-8: --output-format json carries no thinking field, and
// stream-json --include-partial-messages --effort high produces zero
// thinking_delta events and zero thinking content blocks. So a subscription run
// CANNOT produce a raw reasoning log, at any display setting.
//
// This cost a diagnostic cycle on 30 Jul: the baseline benchmark ran on
// subscription, came back with an empty raw log, and the error string below sent
// the reader to `display` - which was already correct - instead of to the engine.
// If you need a raw log, run that one site on AUDIT_LLM=api and pay for it.
const judge = await llmCall({ model: 'claude-opus-4-8', maxTokens: 32000, thinking: { type: 'adaptive', display: 'summarized' }, system: SYSTEM, prompt: `Website: ${site}\nAudit these ${pages.length} pages.\n\n${bundle}` });
const judgeText = judge.text;
// Accepts a fenced block with any tag, a bare JSON reply, or JSON wrapped in
// prose. See judge-parse.mjs for why: requiring a lowercase `json` fence threw
// away three complete verdicts in two days.
const { parsed, findings, rejected, approach } = parseJudge(judgeText);
const judge_ms = Date.now() - tJudge, judge_cost = cost('claude-opus-4-8', judge.usage);
// Keep the raw reasoning before anything can abort, so a failed run is still
// diagnosable on the runner.
// If thinking is empty here it means the engine returned none, not that the judge
// did not think: say which, so nobody reads an empty section as "the judge
// answered off the cuff". Name the actual cause per engine - pointing a
// subscription run at the `display` setting wastes a cycle, since no display
// setting can make `claude -p` emit thinking.
const noThinking = ENGINE === 'api'
  ? '(no thinking text returned by the API for this run: thinking still happened and was billed, it just was not sent back. Check display:"summarized" on the judge call.)'
  : '(no thinking text: this run used AUDIT_LLM=subscription, which shells out to `claude -p`. That path emits no thinking blocks at any effort or display setting, so a raw reasoning log is not obtainable here. Re-run this site on AUDIT_LLM=api if you need one. Thinking still happened; it was never sent back.)';
writeFileSync(`${OUT}${tag}.judge-raw.txt`, `${judge.thinking || noThinking}\n\n=== OUTPUT ===\n${judgeText}`);

// NEVER A HALF REPORT, same rule as the no-readable-pages abort above. A judge
// response we could not parse is not a clean site, it is a run with no verdict.
// Treating it as zero findings sent propstrata a "your site's in good shape"
// report off a response that was cut off mid-JSON (29 Jul, aud_ms5sy6lmrhf0mu).
// Exit 4 tells the runner to leave the lead Approved and try again.
if (!parsed) {
  console.error(`Judge returned no parseable findings block for ${site} (stop_reason=${judge.stop_reason || 'unknown'}, output_tokens=${judge.usage?.output_tokens ?? '?'}, chars=${judgeText.length}). Refusing to report zero findings off a verdict we could not read. Raw reasoning: ${tag}.judge-raw.txt`);
  // The raw file only ever lived on the runner, and on a CI runner that disk dies
  // with the container, so the one artefact that explains the failure was
  // guaranteed to be destroyed. Put the diagnosis in the log itself: what we
  // asked about, what fences came back, and the head of the actual response.
  console.error(`  discovery=${discovery} pages_read=${pages.length} picked=${JSON.stringify(picked)}`);
  console.error(`  fence tags in response: ${JSON.stringify((judgeText.match(/```([A-Za-z]*)/g) || []))}`);
  console.error(`  ---- judge response, first 2000 chars ----\n${judgeText.slice(0, 2000)}\n  ---- end ----`);
  process.exit(4);
}

// STAGE 6: code gate against the same bundle text (verbatim check).
const norm = (s) => (s || '').normalize('NFC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
const bodyByUrl = Object.fromEntries(pages.map(p => [p.url.replace(/\/$/, ''), norm(p.text)]));
// A quote passes if it appears verbatim on its cited page (or, failing a URL
// match, anywhere in the bundle). A finding with a counter-quote (quote2) must
// pass on BOTH quotes: a contradiction we can only evidence from one side is
// not shippable under the near-zero-FP rule.
const quoteFound = (url, quote) => { const b = bodyByUrl[(url || '').replace(/\/$/, '')]; return b ? b.includes(norm(quote)) : Object.values(bodyByUrl).some(x => x.includes(norm(quote))); };
const gated = findings.map(f => { const pass = quoteFound(f.url, f.quote) && (!f.quote2 || quoteFound(f.url2 || f.url, f.quote2)); return { ...f, gate: pass ? 'pass' : 'fail' }; });

// Review aid. The record is attached to the Notion lead row, so this has to be
// SCANNABLE: one line per finding saying why the judge kept it, plus what it
// considered and rejected. A reviewer reads this to spot a judge that is too
// keen or too shy without re-running the audit. Gate-failed findings are listed
// too (they never reach the report, and a run full of them is the signal that
// the judge is paraphrasing instead of quoting). The raw reasoning is far too
// long to skim, so it goes to a sibling file that never leaves the runner.
const pathOnly = (u) => { try { return new URL(u).pathname || '/'; } catch { return u || '?'; } };
const logLine = (f) => `${String(f.severity || 'low').toUpperCase()} ${f.category || 'issue'} ${pathOnly(f.url)}${f.gate === 'fail' ? ' [GATE FAIL, dropped]' : ''}: ${f.check || 'no rationale given'}`;
const judge_log = {
  summary: `${gated.filter(f => f.gate === 'pass').length} findings kept, ${gated.filter(f => f.gate === 'fail').length} dropped by the quote gate, ${rejected.length} considered and rejected by the judge.`,
  // How we found the pages, for us only, not the client. Two runs of the same
  // site can read different pages (nav vs sitemap, plus unreadable-page swaps),
  // which is the first thing to check when two runs disagree.
  discovery: `${pinned ? 'Pages were PINNED via AUDIT_PIN_PAGES, not picked by the model. ' : ''}${{
    dom: "Pages found via the site's rendered navigation.",
    'raw-html': 'Pages found in the server HTML; the rendered navigation was empty.',
    sitemap: 'Pages found via the sitemap; no navigation links were found.',
    none: 'No internal links found at all: not in the rendered page, the server HTML, or a sitemap. The homepage was the only page available to read.',
  }[discovery] || `Page discovery mode: ${discovery}.`} Read: ${pages.map(p => pathOnly(p.url)).join(', ')}.`,
  approach,
  kept: gated.map(logLine),
  rejected,
  raw: `verbatim transcript in the "Judge's full reasoning (raw)" toggle on the lead row, and as the judge-raw artifact on the Actions run`,
};

const total_ms = Date.now() - t0;
const record = {
  tag, site, pickerModel,
  timing: { total_s: Math.round(total_ms / 1000), homepage_fetch_s: Math.round(stage1_ms / 1000), picker_s: Math.round(picker_ms / 1000), page_fetch_s: Math.round(stage3_ms / 1000), link_check_s: Math.round(links_ms / 1000), judge_s: Math.round(judge_ms / 1000) },
  cost: { picker: +picker_cost.toFixed(4), judge: +judge_cost.toFixed(4), total: +(picker_cost + judge_cost).toFixed(4) },
  picker: { discovery, input_links: internal, picked, pages_used: pages.map(p => p.url) },
  coverage: { notes: coverageNotes },
  link_check: { checked: softNotFound ? 0 : Math.min(allLinks.length, 60), soft_404: softNotFound, ...(softNotFound ? { note: 'broken-link check skipped: origin returns 404 statuses for pages that still load (soft-404), so status codes are unreliable' } : {}), broken: linkResults, unreachable_not_reported: unreachable },
  findings: gated, n: gated.length, gate_pass: gated.filter(f => f.gate === 'pass').length, gate_fail: gated.filter(f => f.gate === 'fail').length,
  judge_usage: judge.usage,
  judge_stop_reason: judge.stop_reason,
  judge_log,
};
writeFileSync(`${OUT}${tag}.json`, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ tag, total_s: record.timing.total_s, cost: record.cost, pages: pages.length, findings: record.n, gate_fail: record.gate_fail, broken_links: linkResults.length, picked }, null, 2));
