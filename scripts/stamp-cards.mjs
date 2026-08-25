#!/usr/bin/env node
// ---------------------------------------------------------------------------
// stamp-cards.mjs: content-hash every share-card URL, so a changed card is
// always a new URL.
//
// Why this exists
// ---------------
// Telegram, X and LinkedIn cache preview images keyed on the image URL, and they
// do not revalidate a URL they have already fetched. This site reused stable
// filenames while the contents changed underneath them: og-image.png has held
// three different designs, and in b65479f it also changed job (case-study card
// became brand card). The URL never changed, so those platforms kept serving a
// card from months earlier. Telegram's @WebpageBot did not help, because it
// clears the cached *page*, not the cached *image*.
//
// Stamping each URL with a hash of the file's own bytes means a redesigned card
// is a different URL, which every platform treats as an image it has never seen.
// Nothing needs purging, and the stamp updates itself whenever the card changes.
//
// What gets stamped
// -----------------
//   *.html, prompts/*.html   absolute og:image / twitter:image URLs
//   vercel.json              the `destination` of a retired-card redirect
//
// vercel.json matters as much as the pages: a redirect that lands on the bare
// /og-image.png sends the crawler straight back to the poisoned cache key the
// stamp exists to escape. Its `source` is deliberately left alone, since that is
// the old URL we are catching, not a URL we serve.
//
// Run:   node scripts/stamp-cards.mjs           rewrite every card URL
//        node scripts/stamp-cards.mjs --check   verify only, exit 1 if stale (CI)
//        node scripts/stamp-cards.mjs <root>    operate on a copy elsewhere
//
// Regenerating cards? Run mooch-cards/og-site.sh, copy the PNGs in, then run
// this. `pnpm ci:check` fails if you forget, so a stale stamp cannot ship.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { allHtmlFiles } from './site-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARGV = process.argv.slice(2);
const CHECK_ONLY = ARGV.includes('--check');
const rootArg = ARGV.find((a) => !a.startsWith('-'));
const ROOT = rootArg ? path.resolve(rootArg) : path.resolve(__dirname, '..');

const SITE_ORIGIN = 'https://mooch.agency';
const REDIRECT_CONFIG = 'vercel.json';
const STAMP_LEN = 8; // 8 hex chars of sha256: collision risk is nil at this scale

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const has = (rel) => existsSync(path.join(ROOT, rel));
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A card filename. The extension group accepts jpg as well as png so that a
// future jpg card is stamped (or loudly reported as missing) rather than
// silently skipped by a regex that never matched it.
const CARD_FILE = String.raw`og-[a-z0-9-]+\.(?:png|jpg)`;
const STAMP = String.raw`(\?v=[0-9a-f]+)?`;

// Absolute card URLs in page markup, built from SITE_ORIGIN so that changing the
// origin cannot leave this regex silently matching nothing.
// Template placeholders (og-[slug].png) never match by construction: `[` is
// outside the filename character class, so copy-and-replace scaffolding in
// case-study-template.html and prompt-template.html is left untouched.
const PAGE_CARD_URL = new RegExp(`${reEscape(SITE_ORIGIN)}/(${CARD_FILE})${STAMP}`, 'gi');

// Only the destination of a redirect, never the source.
const REDIRECT_DESTINATION = new RegExp(
  String.raw`("destination"\s*:\s*")/(${CARD_FILE})${STAMP}(")`,
  'gi',
);

// Short content hash of a card file. Keyed on bytes, so a no-op regenerate
// produces an identical stamp and no churn in git.
const stampCache = new Map();
function stampFor(file) {
  if (!stampCache.has(file)) {
    const bytes = readFileSync(path.join(ROOT, file));
    stampCache.set(file, createHash('sha256').update(bytes).digest('hex').slice(0, STAMP_LEN));
  }
  return stampCache.get(file);
}

const changed = [];             // files rewritten, or needing a rewrite under --check
const stale = [];               // { rel, file, found, want }, reported by --check
const missingFiles = new Set(); // card URLs pointing at a file that is not on disk

// A stamping rule: which pattern to match, where the filename and any existing
// stamp sit in its captures, and how to write the reference back out.
const PAGE_RULE = {
  pattern: PAGE_CARD_URL,
  file: 1,
  stamp: 2,
  render: (m, want) => `${SITE_ORIGIN}/${m[1]}${want}`,
};
const REDIRECT_RULE = {
  pattern: REDIRECT_DESTINATION,
  file: 2,
  stamp: 3,
  render: (m, want) => `${m[1]}/${m[2]}${want}${m[4]}`,
};

function stampFile(rel, rule) {
  const raw = read(rel);
  let touched = false;

  const next = raw.replace(rule.pattern, (...args) => {
    const m = args.slice(0, -2); // drop offset + whole-string trailing args
    const whole = m[0];
    const file = m[rule.file];
    // A card URL with no file behind it is a real bug (a deleted or renamed
    // card), so report it rather than silently stamping nothing.
    if (!has(file)) {
      missingFiles.add(`${rel} -> ${file}`);
      return whole;
    }
    const want = `?v=${stampFor(file)}`;
    const replacement = rule.render(m, want);
    if (replacement === whole) return whole;
    touched = true;
    if (CHECK_ONLY) stale.push({ rel, file, found: m[rule.stamp] || '(none)', want });
    return replacement;
  });

  if (!touched) return;
  changed.push(rel);
  if (!CHECK_ONLY) writeFileSync(path.join(ROOT, rel), next);
}

for (const rel of allHtmlFiles(ROOT)) stampFile(rel, PAGE_RULE);
if (has(REDIRECT_CONFIG)) stampFile(REDIRECT_CONFIG, REDIRECT_RULE);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (missingFiles.size) {
  console.error('✗ card URL does not resolve to a file on disk:');
  for (const m of missingFiles) console.error(`    ${m}`);
  console.error('');
}

if (CHECK_ONLY) {
  if (stale.length) {
    console.error(`✗ stamp-cards: ${stale.length} stale or unstamped card URL(s) across ${changed.length} file(s)`);
    for (const s of stale) console.error(`    ${s.rel}  ${s.file}  found ${s.found}, want ${s.want}`);
    console.error('\n  Fix: node scripts/stamp-cards.mjs');
    process.exit(1);
  }
  if (missingFiles.size) process.exit(1);
  console.log('PASS: every share-card URL carries its current content stamp.');
  process.exit(0);
}

if (missingFiles.size) process.exit(1);
if (!changed.length) {
  console.log('stamp-cards: already current, nothing to rewrite.');
} else {
  console.log(`stamp-cards: stamped ${changed.length} file(s)`);
  for (const c of changed) console.log(`  - ${c}`);
}
