#!/usr/bin/env node
// ---------------------------------------------------------------------------
// copy-counts.mjs: bake the real "people have copied this" number into each
// prompt page at build time.
//
// Why build time and not a request
// --------------------------------
// The obvious shape is a serverless function the page calls on load. It is the
// wrong trade here. Vercel's Web Analytics query API has no read-only scope, so
// a runtime reader means storing a full-account API token in production to
// render one integer. Baking the number in at build time keeps that token on
// the machine that runs this script (the Vercel CLI's own session, already
// authenticated) and ships the page as plain static HTML with nothing to call.
//
// The cost is staleness: the number only moves when the site is next deployed.
// At the volumes these pages see, that is not a real cost.
//
// Where the number comes from
// ---------------------------
// The `prompt_copy` custom event, filtered to the page's own path. That event
// is what the copy buttons already fire, so this counts real copies rather than
// visits. It undercounts by whatever share of visitors block the analytics
// script, which is the honest floor, not the true total.
//
// One wrinkle in the history: until the split landed, both copy buttons on a
// prompt page (the prompt, and the install commands) fired prompt_copy. Events
// from before then are therefore a mix of the two, so the earliest part of the
// count runs slightly high. Everything recorded since is prompt-only.
//
// Run:   node scripts/copy-counts.mjs           refresh every counter
//        node scripts/copy-counts.mjs --check   verify only, exit 1 if stale
//        node scripts/copy-counts.mjs --dry     print what it would write
//
// Auth: uses the Vercel CLI's session (`vercel api`). Run `vercel login` once.
// In CI, set VERCEL_TOKEN and this uses it instead.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ARGV = process.argv.slice(2);
const CHECK_ONLY = ARGV.includes('--check');
const DRY = ARGV.includes('--dry');

const PROJECT_ID = 'prj_9ktpx6Qd6nCMT8BT5k7N7Vu4WOBx';
const TEAM_ID = 'team_EQeV0ciRFVyubEPoQGf21bfC';

// Pages carrying a counter, mapped to the request path and event name their
// copy fires under. /say-less predates the prompt_copy convention and keeps
// its own sayless_copy_prompt name; add a row here when a new prompt page
// ships. The page needs a matching data-copy-count element or this errors
// rather than silently doing nothing.
//
// This is the render seen for an instant before /api/copy-count (backed by
// Notion, the actual persistent counter) overwrites it on load, so it only
// needs to be roughly right, not exact: Vercel Analytics stays the source
// here rather than Notion, so this script doesn't need NOTION_TOKEN too.
const PAGES = [
  { file: 'prompts/deslop.html', requestPath: '/prompts/deslop', eventName: 'prompt_copy' },
  { file: 'prompts/soundlikeme.html', requestPath: '/prompts/soundlikeme', eventName: 'prompt_copy' },
  { file: 'say-less.html', requestPath: '/say-less', eventName: 'sayless_copy_prompt' },
];

// Analytics retains a bounded window, but these pages are newer than any of it,
// so a wide range is simply "all time" without needing the page's ship date.
const SINCE = Date.now() - 365 * 86_400_000;
const UNTIL = Date.now();

function odata(requestPath, eventName) {
  return `eventName eq '${eventName}' and requestPath eq '${requestPath}'`;
}

// The CLI prints a "did you mean to deploy" warning to stdout on some repos, so
// the JSON is located rather than assumed to start at byte zero.
function parseLoose(out) {
  const start = out.indexOf('{');
  if (start === -1) throw new Error(`no JSON in response:\n${out}`);
  return JSON.parse(out.slice(start));
}

function fetchCount(requestPath, eventName) {
  const qs = new URLSearchParams({
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    since: String(SINCE),
    until: String(UNTIL),
    filter: odata(requestPath, eventName),
  });
  const url = `/v1/query/web-analytics/events/count?${qs}`;

  let out;
  if (process.env.VERCEL_TOKEN) {
    // CI path: no CLI session to lean on.
    const res = execFileSync(
      'curl',
      ['-sS', '-H', `Authorization: Bearer ${process.env.VERCEL_TOKEN}`, `https://api.vercel.com${url}`],
      { encoding: 'utf8' },
    );
    out = res;
  } else {
    out = execFileSync('vercel', ['api', url], { encoding: 'utf8', cwd: ROOT });
  }

  const json = parseLoose(out);
  if (json.error) throw new Error(`${requestPath}: ${json.error.message}`);
  const count = json?.data?.count;
  if (typeof count !== 'number') throw new Error(`${requestPath}: no count in response`);
  return count;
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

let stale = 0;
let wrote = 0;

for (const page of PAGES) {
  const file = path.join(ROOT, page.file);
  const html = readFileSync(file, 'utf8');
  const m = html.match(RE);
  if (!m) {
    console.error(`✗ ${page.file}: no [data-copy-count] element found`);
    process.exitCode = 1;
    continue;
  }

  const count = fetchCount(page.requestPath, page.eventName);
  const attr = ` data-copy-count="${count}"`;
  const openTag = m[1].replace(/\s*data-copy-count(="[^"]*")?/, '') .replace(/>$/, `${attr}>`);
  const next = `${openTag}${render(count)}${m[3]}`;

  if (m[0] === next) {
    console.log(`= ${page.file}: ${count}`);
    continue;
  }

  if (CHECK_ONLY) {
    console.error(`✗ ${page.file}: counter is stale (page shows a different number to ${count})`);
    stale++;
    continue;
  }

  if (DRY) {
    console.log(`→ ${page.file}: would write ${count}`);
    continue;
  }

  writeFileSync(file, html.replace(RE, next));
  console.log(`✓ ${page.file}: ${count}`);
  wrote++;
}

if (stale) {
  console.error(`\n${stale} counter(s) stale. Run: pnpm counts:build`);
  process.exit(1);
}
if (wrote) console.log(`\nUpdated ${wrote} counter(s).`);
