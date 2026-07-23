#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-site.mjs — deterministic pre-launch checks for the mooch.agency site.
//
// This is the scriptable, CI-gateable version of the `pre-launch-website-check`
// skill (github.com/mooch-agency/skills). It parses every shipped .html page and
// asserts a fixed set of rules, exits non-zero on any failure, and prints each
// violation grouped by discipline with the file and (where feasible) line.
//
// Run:   node scripts/check-site.mjs            (checks this repo)
//        node scripts/check-site.mjs <root-dir> (checks a copy elsewhere — used
//                                                 by the verification harness)
//
// Rules implemented (see AC in Sprint 9 ticket "Add programmatic CI workflow"):
//   SEO & Meta ........... title length, meta-description length, canonical
//   Content hygiene ...... no em dash in prose, copyright year current
//   Trust & contact ...... footer contact (valid mailto:)
//   Mobile ............... viewport meta present
//   Design tokens ........ no hardcoded colours in inline CSS (tokens.css only)
//   Social cards ......... og:title/description/image + image exists ~1200x630
//   Index hygiene ........ sitemap <-> pages bijection, no stray noindex, robots
//   Uniqueness ........... unique titles + descriptions, exactly one <h1>
//
// Scoping: we check the pages the site actually ships — every *.html at the repo
// root plus prompts/*.html — MINUS a documented exclusion list of templates,
// dev tools, redirect targets and noindex lab pages (see EXCLUDED below). We do
// NOT walk audit/, node_modules/, api/, docs/ or pg-rewriter/: those are not
// site pages.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load } from 'cheerio';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');

const SITE_ORIGIN = 'https://mooch.agency';
const CURRENT_YEAR = new Date().getFullYear(); // today; a page dated 2026 passes in 2026, is "stale" in 2027

// ---- Sensible SEO bounds ---------------------------------------------------
// The skill's *ideal* is title 50-60 / description 120-160. mooch uses short,
// punchy brand titles (the homepage is ~26 chars) so the CI gate uses wider
// "sensible" bounds: fail only on genuinely broken lengths (empty / stub titles,
// SERP-truncating titles, thin or rambling descriptions), not on brand voice.
const TITLE_MIN = 15, TITLE_MAX = 70;   // ideal 50-60
const DESC_MIN = 70, DESC_MAX = 165;    // ideal 120-160

// og:image target with a +/-5% tolerance ("roughly 1200x630").
const OG_W = 1200, OG_H = 630, OG_TOL = 0.05;

// ---- Page scoping ----------------------------------------------------------
// Non-shipped repo-root/prompts pages, excluded from every check. Kept explicit
// so a genuinely NEW page (not listed here, not in the sitemap) trips the
// index-hygiene check instead of slipping through silently.
const EXCLUDED = new Set([
  '404.html',                       // error page (noindex, not indexable content)
  'case-study-template.html',       // template, not a page
  'prompt-template.html',           // template, not a page
  'stagger-tuner.html',             // internal motion-tuning dev tool (noindex)
  'styleguide.html',                // internal design reference (noindex)
  'ready.html',                     // redirected to / in vercel.json (/ready -> /)
  'paulgraham.html',                // interactive demo, intentionally unlisted (no canonical)
  'portfolio-all.html',             // portfolio index / lab page (noindex, not in sitemap)
  'portfolio-explorations.html',    // portfolio lab page (noindex, not in sitemap)
  'portfolio-explorations-2.html',  // portfolio lab page (noindex, not in sitemap)
]);

// Pages that legitimately sit in the sitemap AND carry noindex: the prompt
// utility pages are kept discoverable (sitemap + llms.txt) but deliberately not
// indexed. Anything else in the sitemap with noindex is a real bug.
const SITEMAP_NOINDEX_ALLOWED = new Set(['prompts/deslop.html', 'prompts/soundlikeme.html']);

// Raw colour literals tolerated inside inline CSS. These are pre-existing
// achromatic structural neutrals that are not yet tokens in tokens.css. Tech
// debt: migrate to a token and delete this allowlist. Everything else hardcoded
// gets flagged.
const ALLOWED_INLINE_HEX = new Set(['#2a2a2c']); // dark-footer hairline

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const findings = []; // { discipline, file, line, message }
function fail(discipline, file, message, line) {
  findings.push({ discipline, file, line: line ?? null, message });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const has = (rel) => existsSync(path.join(ROOT, rel));

function offsetToLine(raw, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < raw.length; i++) if (raw[i] === '\n') line++;
  return line;
}
// First line whose text matches `re` (a RegExp with no global flag).
function lineOf(raw, re) {
  const m = re.exec(raw);
  return m ? offsetToLine(raw, m.index) : null;
}

// Byte ranges of <style>, <script> and <!-- --> so we can tell CSS/JS/comment
// text apart from visible copy.
function excludedTextRanges(raw) {
  const ranges = [];
  const patterns = [/<style\b[^>]*>[\s\S]*?<\/style>/gi, /<script\b[^>]*>[\s\S]*?<\/script>/gi, /<!--[\s\S]*?-->/g];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(raw))) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}
const inRanges = (ranges, i) => ranges.some(([s, e]) => i >= s && i < e);

// Inner CSS text of every <style> block plus every style="" attribute value,
// each with its absolute start offset (for line numbers).
function inlineCssChunks(raw) {
  const chunks = [];
  const styleTag = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleTag.exec(raw))) chunks.push({ start: m.index + m[0].indexOf(m[1]), text: m[1] });
  const styleAttr = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((m = styleAttr.exec(raw))) {
    const val = m[2] ?? m[3] ?? '';
    chunks.push({ start: m.index + m[0].indexOf(val), text: val });
  }
  return chunks;
}

// Decode the handful of entities we compare against as visible text.
const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—')
  .replace(/&#8212;/g, '—').replace(/&#x2014;/gi, '—');

// ---------------------------------------------------------------------------
// Image dimensions (PNG + JPEG) — avoids adding an image-size dependency.
// ---------------------------------------------------------------------------
function imageSize(buf) {
  // PNG: 8-byte signature, then IHDR with width@16 height@20 (big-endian).
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan segment markers for a Start-Of-Frame (SOFn).
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      // SOF0..SOF15 hold the dimensions; skip DHT/DAC/RSTn (0xc4/0xc8/0xcc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = buf.readUInt16BE(o + 2);
      o += 2 + len;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL <-> file mapping (Vercel cleanUrls: /gov-uk serves gov-uk.html).
// ---------------------------------------------------------------------------
// Canonical key for a page file:  index.html -> '',  gov-uk.html -> 'gov-uk',
// prompts/deslop.html -> 'prompts/deslop'.
function fileToKey(rel) {
  const noExt = rel.replace(/\.html$/i, '');
  return noExt === 'index' ? '' : noExt;
}
// Canonical key for a sitemap <loc>: strip origin + surrounding slashes.
function locToKey(loc) {
  let p = loc.trim().replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '');
  return p; // '' == home
}
// Resolve a sitemap key back to a file on disk, honouring cleanUrls.
function keyToFile(key) {
  if (key === '') return 'index.html';
  for (const cand of [`${key}.html`, `${key}/index.html`, key]) if (has(cand)) return cand;
  return null;
}

// ---------------------------------------------------------------------------
// Discover shipped pages
// ---------------------------------------------------------------------------
function discoverPages() {
  const rootHtml = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  const promptsHtml = has('prompts')
    ? readdirSync(path.join(ROOT, 'prompts')).filter((f) => f.endsWith('.html')).map((f) => `prompts/${f}`)
    : [];
  return [...rootHtml, ...promptsHtml]
    .filter((rel) => !EXCLUDED.has(rel))
    .sort();
}

// ---------------------------------------------------------------------------
// Per-page checks
// ---------------------------------------------------------------------------
function checkPage(rel, seenTitles, seenDescs) {
  const raw = read(rel);
  const $ = load(raw);

  // --- SEO & Meta ---
  const title = $('title').first().text().trim();
  if (!title) {
    fail('SEO & Meta', rel, 'missing <title>', lineOf(raw, /<title/i));
  } else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    fail('SEO & Meta', rel, `title is ${title.length} chars (want ${TITLE_MIN}-${TITLE_MAX}): "${title}"`, lineOf(raw, /<title/i));
  }

  const descEl = $('meta[name="description"]').first();
  const desc = (descEl.attr('content') || '').trim();
  if (!descEl.length || !desc) {
    fail('SEO & Meta', rel, 'missing <meta name="description">', lineOf(raw, /name=["']description["']/i));
  } else if (desc.length < DESC_MIN || desc.length > DESC_MAX) {
    fail('SEO & Meta', rel, `meta description is ${desc.length} chars (want ${DESC_MIN}-${DESC_MAX})`, lineOf(raw, /name=["']description["']/i));
  }

  const canonical = $('link[rel="canonical"]').first();
  if (!canonical.length || !(canonical.attr('href') || '').trim()) {
    fail('SEO & Meta', rel, 'missing <link rel="canonical"> with an href', lineOf(raw, /rel=["']canonical["']/i));
  }

  // --- Content hygiene: no em dash in visible prose ---
  // An em dash is flagged only when used as sentence punctuation (its text run
  // also contains a word character). A lone em dash in its own element (e.g. a
  // "not included" table cell) is a UI glyph, not prose, so it is allowed.
  const skip = excludedTextRanges(raw);
  const dash = /—|&mdash;|&#8212;|&#x2014;/gi;
  let dm;
  while ((dm = dash.exec(raw))) {
    if (inRanges(skip, dm.index)) continue;               // inside <style>/<script>/comment
    const runStart = raw.lastIndexOf('>', dm.index) + 1;  // start of this text run
    let runEnd = raw.indexOf('<', dm.index);
    if (runEnd === -1) runEnd = raw.length;
    const before = raw.slice(runStart, dm.index);
    const after = raw.slice(dm.index + dm[0].length, runEnd);
    if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) {
      const ctx = decode((before.slice(-20) + '—' + after.slice(0, 20)).replace(/\s+/g, ' ')).trim();
      fail('Content hygiene', rel, `em dash in copy: "…${ctx}…" (mooch house style: never use em dashes)`, offsetToLine(raw, dm.index));
    }
  }

  // --- Content hygiene: copyright year current ---
  const cy = /(?:©|&copy;|copyright)\s*(?:&copy;\s*)?(\d{4}(?:\s*[–—-]\s*\d{4})?)/i.exec(raw);
  if (cy) {
    const years = cy[1].match(/\d{4}/g);
    const last = Number(years[years.length - 1]);
    if (last !== CURRENT_YEAR) {
      fail('Content hygiene', rel, `copyright year is ${cy[1]} (current year is ${CURRENT_YEAR})`, offsetToLine(raw, cy.index));
    }
  }

  // --- Trust & contactability: footer contact (valid mailto:) ---
  const mailtos = $('a[href^="mailto:"]');
  let validMail = false;
  mailtos.each((_, a) => {
    const addr = ($(a).attr('href') || '').slice('mailto:'.length).split('?')[0];
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) validMail = true;
  });
  if (!validMail) {
    fail('Trust & contactability', rel, 'no footer contact: expected a valid mailto: link', null);
  }

  // --- Mobile: viewport meta ---
  const vp = $('meta[name="viewport"]').first();
  if (!vp.length || !/width=device-width/i.test(vp.attr('content') || '')) {
    fail('Mobile', rel, 'missing <meta name="viewport" content="width=device-width, ...">', lineOf(raw, /name=["']viewport["']/i));
  }

  // --- Design tokens: no hardcoded colours in inline CSS ---
  checkColours(rel, raw);

  // --- Social cards ---
  checkSocial(rel, raw, $);

  // --- Uniqueness bookkeeping (evaluated site-wide later) ---
  if (title) (seenTitles[title] ||= []).push(rel);
  if (desc) (seenDescs[desc] ||= []).push(rel);

  // exactly one <h1>
  const h1s = $('h1');
  if (h1s.length !== 1) {
    fail('Uniqueness & structure', rel, `expected exactly one <h1>, found ${h1s.length}`, lineOf(raw, /<h1[\s>]/i));
  }

  return { title, desc };
}

// Colour literals in inline CSS, minus documented exceptions.
function checkColours(rel, raw) {
  const chunks = inlineCssChunks(raw);
  const colour = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|(?:rgba?|hsla?)\([^)]*\)/g;
  const isBlackWhite = (v) => {
    const s = v.toLowerCase().replace(/\s+/g, '');
    return ['#000', '#000000', '#fff', '#ffffff', 'rgb(0,0,0)', 'rgba(0,0,0,1)', 'rgb(255,255,255)', 'rgba(255,255,255,1)'].includes(s);
  };
  for (const { start, text } of chunks) {
    // Ranges of `@media print { ... }` inside this chunk are exempt (print
    // stylesheets legitimately hardcode black/white).
    const printRanges = [];
    const pm = /@media\s+print[^{]*\{/gi;
    let p;
    while ((p = pm.exec(text))) {
      let depth = 1, i = pm.lastIndex;
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
      }
      printRanges.push([p.index, i]);
    }
    let m;
    while ((m = colour.exec(text))) {
      const val = m[0];
      const norm = val.toLowerCase();
      if (isBlackWhite(val)) continue;
      if (ALLOWED_INLINE_HEX.has(norm)) continue;
      if (printRanges.some(([s, e]) => m.index >= s && m.index < e)) continue;
      // Custom-property definition (`--name: <colour>`) is a legit token (re)definition.
      const declStart = Math.max(text.lastIndexOf(';', m.index), text.lastIndexOf('{', m.index)) + 1;
      if (/^\s*--[\w-]+\s*:/.test(text.slice(declStart, m.index))) continue;
      fail('Design tokens', rel, `hardcoded colour "${val}" in inline CSS — use a var(--token) from tokens.css`, offsetToLine(raw, start + m.index));
    }
  }
}

// og:title / og:description / og:image present; image resolves and is ~1200x630.
function checkSocial(rel, raw, $) {
  for (const prop of ['og:title', 'og:description', 'og:image']) {
    const el = $(`meta[property="${prop}"]`).first();
    if (!el.length || !(el.attr('content') || '').trim()) {
      fail('Social cards', rel, `missing <meta property="${prop}">`, lineOf(raw, new RegExp(`property=["']${prop}["']`, 'i')));
    }
  }
  const ogImage = ($('meta[property="og:image"]').first().attr('content') || '').trim();
  if (!ogImage) return;
  const imgRel = ogImage.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
  if (!has(imgRel)) {
    fail('Social cards', rel, `og:image "${ogImage}" does not resolve to a file on disk`, lineOf(raw, /property=["']og:image["']/i));
    return;
  }
  const dim = imageSize(readFileSync(path.join(ROOT, imgRel)));
  if (!dim) {
    fail('Social cards', rel, `og:image ${imgRel}: could not read dimensions (expected PNG/JPEG ~${OG_W}x${OG_H})`, null);
  } else {
    const okW = Math.abs(dim.width - OG_W) <= OG_W * OG_TOL;
    const okH = Math.abs(dim.height - OG_H) <= OG_H * OG_TOL;
    if (!okW || !okH) {
      fail('Social cards', rel, `og:image ${imgRel} is ${dim.width}x${dim.height} (want ~${OG_W}x${OG_H})`, null);
    }
  }
}

// ---------------------------------------------------------------------------
// Site-wide checks (index hygiene, uniqueness)
// ---------------------------------------------------------------------------
function checkIndexHygiene(pages) {
  if (!has('sitemap.xml')) {
    fail('Index hygiene', 'sitemap.xml', 'sitemap.xml is missing', null);
    return;
  }
  const sitemapRaw = read('sitemap.xml');
  const locs = [...sitemapRaw.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
  const sitemapKeys = new Set(locs.map(locToKey));
  const pageKeys = new Set(pages.map(fileToKey));

  // 1. Every sitemap <loc> resolves to a real file (catches stale entries /
  //    broken internal links in the sitemap).
  for (const loc of locs) {
    if (keyToFile(locToKey(loc)) === null) {
      fail('Index hygiene', 'sitemap.xml', `sitemap entry does not resolve to a page: ${loc}`,
        lineOf(sitemapRaw, new RegExp(loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
    }
  }
  // 2. Every shipped page is listed in the sitemap (catches a new page that was
  //    forgotten). Excluded/dev pages are already filtered out of `pages`.
  for (const rel of pages) {
    if (!sitemapKeys.has(fileToKey(rel))) {
      fail('Index hygiene', rel, 'shipped page is missing from sitemap.xml', null);
    }
  }
  // 3. No stray noindex: a page in the sitemap must be indexable, unless it is a
  //    deliberate sitemap+noindex utility page (SITEMAP_NOINDEX_ALLOWED).
  for (const rel of pages) {
    if (!sitemapKeys.has(fileToKey(rel))) continue;
    const raw = read(rel);
    if (/<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(raw) && !SITEMAP_NOINDEX_ALLOWED.has(rel)) {
      fail('Index hygiene', rel, 'page is in the sitemap but marked noindex', lineOf(raw, /name=["']robots["']/i));
    }
  }
  // 4. robots.txt must not Disallow any indexable page.
  if (has('robots.txt')) {
    const disallows = [...read('robots.txt').matchAll(/^\s*Disallow:\s*(\S+)/gim)].map((m) => m[1]).filter((p) => p && p !== '/');
    for (const rel of pages) {
      if (SITEMAP_NOINDEX_ALLOWED.has(rel)) continue;
      const url = '/' + fileToKey(rel);
      for (const d of disallows) {
        if (url === d || url.startsWith(d.endsWith('/') ? d : d + '/')) {
          fail('Index hygiene', 'robots.txt', `robots.txt Disallow "${d}" blocks indexable page ${url}`, null);
        }
      }
    }
  }
}

function checkUniqueness(seenTitles, seenDescs) {
  for (const [title, rels] of Object.entries(seenTitles)) {
    if (rels.length > 1) fail('Uniqueness & structure', rels.join(', '), `duplicate <title> across pages: "${title}"`, null);
  }
  for (const [, rels] of Object.entries(seenDescs)) {
    if (rels.length > 1) fail('Uniqueness & structure', rels.join(', '), `duplicate meta description across pages: ${rels.join(', ')}`, null);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const pages = discoverPages();
const seenTitles = {}, seenDescs = {};
for (const rel of pages) checkPage(rel, seenTitles, seenDescs);
checkUniqueness(seenTitles, seenDescs);
checkIndexHygiene(pages);

// ---------------------------------------------------------------------------
// Output — grouped by discipline, file + line where feasible.
// ---------------------------------------------------------------------------
const DISCIPLINES = ['SEO & Meta', 'Content hygiene', 'Trust & contactability', 'Mobile', 'Design tokens', 'Social cards', 'Index hygiene', 'Uniqueness & structure'];
console.log(`check-site: ${pages.length} shipped pages under ${ROOT}`);
console.log(pages.map((p) => `  - ${p}`).join('\n'));
console.log('');

if (findings.length === 0) {
  console.log('PASS — all disciplines clean.');
  process.exit(0);
}

for (const d of DISCIPLINES) {
  const group = findings.filter((f) => f.discipline === d);
  if (!group.length) continue;
  console.log(`✗ ${d} (${group.length})`);
  for (const f of group) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`  ${loc}  ${f.message}`);
  }
  console.log('');
}
console.log(`FAIL — ${findings.length} problem(s) across ${new Set(findings.map((f) => f.discipline)).size} discipline(s).`);
process.exit(1);
