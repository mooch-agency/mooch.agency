#!/usr/bin/env node
// ---------------------------------------------------------------------------
// copy-counts.mjs: bake the real "people have copied this" number into each
// prompt page at build time.
//
// Why build time and not a request
// --------------------------------
// The obvious shape is a serverless function the page calls on load. It is the
// wrong trade here. Baking the number in at build time ships the page as
// plain static HTML with a correct-looking number already in it, and lets
// /api/copy-count.js (the live, persistent counter) simply confirm or nudge
// that number on load instead of visibly overwriting a different one.
//
// The cost is staleness: the number only moves when the site is next deployed.
// At the volumes these pages see, that is not a real cost.
//
// Where the number comes from
// ---------------------------
// The same Notion page and Count property that api/copy-count.js reads and
// increments at runtime (see that file's header for the shape). This used to
// read Vercel Web Analytics' prompt_copy event instead, which was appealing
// because it needed no token: the Vercel CLI's own session was enough. But
// Analytics and Notion diverge the moment they're seeded, because Notion
// counts every click that reaches the endpoint while Analytics misses anyone
// blocking the analytics script or using ?notrack=1. That gap only widens, so
// every page load baked from Analytics rendered a smaller number and then
// visibly jumped to Notion's larger one once the runtime fetch landed, worse
// with every deploy. Reading the same source at build time as at runtime is
// the only way to make that jump disappear: this script now needs
// NOTION_TOKEN for exactly that reason.
//
// Run:   node scripts/copy-counts.mjs           refresh every counter
//        node scripts/copy-counts.mjs --check   verify only, exit 1 if stale
//        node scripts/copy-counts.mjs --dry     print what it would write
//
// Auth: needs NOTION_TOKEN in the environment (the same token api/copy-count.js
// uses in production). Get it with `vercel env pull` (writes .env.local) or
// export it directly: NOTION_TOKEN=secret_... pnpm counts:build.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ARGV = process.argv.slice(2);
const CHECK_ONLY = ARGV.includes('--check');
const DRY = ARGV.includes('--dry');

const NOTION_VERSION = '2026-03-11';

// Pages carrying a counter, mapped to the Notion page id api/copy-count.js
// reads and increments for that same slug (see PAGES there). Add a row here
// when a new prompt page ships. The page needs a matching data-copy-count
// element or this errors rather than silently doing nothing.
//
// This is baked in at build time from the same source /api/copy-count.js
// reads at runtime, so the two agree from the moment a page ships: no more
// jump from one number to a bigger one as the runtime fetch lands.
const PAGES = [
  { file: 'prompts/deslop.html', pageId: '3cb804529ed08134986cdeb19a30f57a' },
  { file: 'prompts/soundlikeme.html', pageId: '3cb804529ed0815fa148cea34d1880ea' },
  { file: 'say-less.html', pageId: '3cb804529ed081e2832ae8ac3dd6bcb9' },
];

function countOf(page) {
  const prop = page && page.properties && page.properties.Count;
  // Matches api/copy-count.js: a missing or renamed Count property is not a
  // genuine zero. Falling back to 0 here would bake a zero into every page,
  // and ui.css hides the counter at zero, so the whole thing would quietly
  // vanish from the site on the next deploy. Fail the build instead.
  if (!prop || typeof prop.number !== 'number') {
    throw new Error('Count property missing from Notion page');
  }
  return prop.number;
}

// Kept as a parameter (rather than reading process.env.NOTION_TOKEN directly)
// so a test harness can inject a fetch stub without touching the environment.
async function fetchCount(pageId, token, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'notion-version': NOTION_VERSION,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.message) || `Notion ${res.status}`;
    throw new Error(`${pageId}: ${msg}`);
  }
  return countOf(data);
}

// The counter element is the single source of truth for its own value: the
// visible text and the data attribute are rewritten together so they can never
// drift apart, and the attribute is what --check reads.
const RE = /(<span\b[^>]*\bdata-copy-count\b[^>]*>)([\s\S]*?)(<\/span>)/;

function render(count) {
  // Verb-first, not "N copies": a noun count reads as "N duplicates exist",
  // ambiguous right next to a button that makes duplicates. "Copied N times"
  // names the action instead. Plural handled here rather than in CSS/JS so
  // the shipped HTML reads correctly with no scripting at all.
  const noun = count === 1 ? 'time' : 'times';
  return `Copied ${count.toLocaleString('en-GB')} ${noun}`;
}

// Exported so a test harness can drive the whole run with a fake fetch and a
// fake token without shelling out or touching real files outside ROOT.
export async function run({ token, fetchImpl = fetch, root = ROOT, checkOnly = CHECK_ONLY, dry = DRY } = {}) {
  if (!token) {
    console.error(
      '✗ NOTION_TOKEN is not set. This script bakes the same Notion-backed\n' +
      '  count that api/copy-count.js serves at runtime, so it needs that\n' +
      '  token too. Get it with `vercel env pull` (writes .env.local), or\n' +
      '  export it directly: NOTION_TOKEN=secret_... pnpm counts:build',
    );
    process.exitCode = 1;
    return;
  }

  let stale = 0;
  let wrote = 0;

  for (const page of PAGES) {
    const file = path.join(root, page.file);
    const html = readFileSync(file, 'utf8');
    const m = html.match(RE);
    if (!m) {
      console.error(`✗ ${page.file}: no [data-copy-count] element found`);
      process.exitCode = 1;
      continue;
    }

    let count;
    try {
      count = await fetchCount(page.pageId, token, fetchImpl);
    } catch (e) {
      console.error(`✗ ${page.file}: ${e.message}`);
      process.exitCode = 1;
      continue;
    }

    const attr = ` data-copy-count="${count}"`;
    const openTag = m[1].replace(/\s*data-copy-count(="[^"]*")?/, '').replace(/>$/, `${attr}>`);
    const next = `${openTag}${render(count)}${m[3]}`;

    if (m[0] === next) {
      console.log(`= ${page.file}: ${count}`);
      continue;
    }

    if (checkOnly) {
      console.error(`✗ ${page.file}: counter is stale (page shows a different number to ${count})`);
      stale++;
      continue;
    }

    if (dry) {
      console.log(`→ ${page.file}: would write ${count}`);
      continue;
    }

    writeFileSync(file, html.replace(RE, next));
    console.log(`✓ ${page.file}: ${count}`);
    wrote++;
  }

  if (stale) {
    console.error(`\n${stale} counter(s) stale. Run: pnpm counts:build`);
    process.exitCode = 1;
  }
  if (wrote) console.log(`\nUpdated ${wrote} counter(s).`);
}

// Only run when invoked directly (`node scripts/copy-counts.mjs`), not when a
// test harness imports `run` for its own use. Compared as resolved paths,
// not raw strings, because a repo path containing spaces (this one does)
// round-trips through file:// URL-encoding and would never string-match.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await run({ token: process.env.NOTION_TOKEN });
  process.exit(process.exitCode || 0);
}
