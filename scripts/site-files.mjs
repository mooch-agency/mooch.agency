// ---------------------------------------------------------------------------
// site-files.mjs: one answer to "which HTML files does this repo have, and
// which of them are shipped pages?", shared by every script under scripts/.
//
// It lives here because two scripts need the question answered differently and
// the difference is deliberate:
//
//   shippedPages()  the indexable site: what check-site.mjs asserts SEO, copy
//                   and structure rules against.
//   allHtmlFiles()  every file that could carry a share-card URL, excluded ones
//                   included. stamp-cards.mjs uses this on purpose: a retired
//                   page like ready.html still points at a card, and that URL
//                   must stay correctly stamped even though nothing indexes it.
//
// Keeping both in one file means the two scripts can never drift on what a page
// is by accident, only on purpose.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Non-shipped repo-root/prompts pages, excluded from the indexable-site checks.
// Kept explicit so a genuinely NEW page (not listed here, not in the sitemap)
// trips the index-hygiene check instead of slipping through silently.
export const EXCLUDED = new Set([
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
  'og-explorations.html',           // share-card review page (noindex, not in sitemap)
]);

// Every .html at the repo root plus prompts/*.html, sorted. We do NOT walk
// audit/, node_modules/, api/, docs/ or pg-rewriter/: those are not site pages.
export function allHtmlFiles(root) {
  const rootHtml = readdirSync(root).filter((f) => f.endsWith('.html'));
  const promptsDir = path.join(root, 'prompts');
  const promptsHtml = existsSync(promptsDir)
    ? readdirSync(promptsDir).filter((f) => f.endsWith('.html')).map((f) => `prompts/${f}`)
    : [];
  return [...rootHtml, ...promptsHtml].sort();
}

// The pages the site actually ships: everything above minus EXCLUDED.
export function shippedPages(root) {
  return allHtmlFiles(root).filter((rel) => !EXCLUDED.has(rel));
}
