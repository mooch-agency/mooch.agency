#!/usr/bin/env node
// ---------------------------------------------------------------------------
// creditcards-update.mjs: keep /creditcards fresh.
//
// Three jobs, in order, each surviving the others' failure:
//
//   1. Discovery (needs X_BEARER_TOKEN): two recent-search requests against the
//      X API for new Credits-related projects (the main query, plus replies to
//      @jesusdoteth's own posts, where builders submit to the index). New external links land in
//      data/creditcards.json as status "pending". Nothing pending ever renders;
//      a human flips it to "approved" (and tidies the blurb) first. Rejected
//      entries stay as tombstones so a re-announced URL is never re-added.
//      Cost control: max 50 posts per run on a pay-per-use token, windowed by
//      since_id so a quiet day reads almost nothing.
//
//   2. Stats refresh (best effort, keyless): the same two OpenSea endpoints
//      api/creditcards-stats.js proxies at runtime. Baking the numbers here
//      means the page shows a value at most a day old with no JavaScript at
//      all, and the runtime fetch merely nudges it. Same trade as
//      copy-counts.mjs, same reason.
//
//   3. Bake: regenerate the approved-projects block between the
//      creditcards:projects markers in creditcards.html, and the data-stat
//      spans. Output is deterministic (stable sort, fixed indentation) so a
//      no-change run produces no git diff and the daily workflow commits
//      nothing.
//
// Run:   node scripts/creditcards-update.mjs              full run
//        node scripts/creditcards-update.mjs --bake-only  skip X and OpenSea
//        node scripts/creditcards-update.mjs --dry        print, write nothing
//
// Auth: X_BEARER_TOKEN in the environment for discovery. Without it the script
// logs one line, skips discovery and still bakes, exiting 0: the daily
// workflow stays green before the secret exists.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ARGV = process.argv.slice(2);
const DRY = ARGV.includes('--dry');
const BAKE_ONLY = ARGV.includes('--bake-only');

const DATA_FILE = 'data/creditcards.json';
const PAGE_FILE = 'creditcards.html';

// One request a day at 50 posts is the agreed budget (pay-per-use reads cost
// about $0.005 a post, so the worst month is around $7.50). The query anchors
// on Jack's name or the mint page URL because "credits" alone matches half the
// internet; replies and reposts are noise at this budget. No lang filter:
// grid-art projects announce in any language, and the human review gate
// absorbs what the query lets through.
const X_ENDPOINT = 'https://api.x.com/2/tweets/search/recent';
const X_QUERY =
  '(credits ("jack butcher" OR jackbutcher OR @jackbutcher) OR url:"jack.art/credits") has:links -is:retweet -is:reply';
const X_MAX_RESULTS = 50;

// Second, smaller search: replies to @jesusdoteth's own posts. Builders often
// submit a project by replying to the Credit Cards thread, and the main query
// drops every reply. Scoped with to: so it only reads replies addressed to
// Tahi, never replies across the rest of X. Links only, since a reply without
// one gives the index nothing to add. Its own since_id window
// (meta.replySinceId) so the two searches never skip each other's posts.
const X_REPLY_HANDLE = 'jesusdoteth';
const X_REPLY_QUERY = `to:${X_REPLY_HANDLE} is:reply has:links -is:retweet -from:${X_REPLY_HANDLE}`;
const X_REPLY_MAX_RESULTS = 25;

// Hosts that are never a community project: the collection's own surfaces,
// marketplaces, explorers and link shorteners the search will hit constantly.
const HOST_BLOCKLIST = new Set([
  'x.com',
  'twitter.com',
  't.co',
  'opensea.io',
  'jack.art',
  'etherscan.io',
  'blur.io',
  'magiceden.io',
  'foundation.app',
  'mooch.agency',
]);

const MARKER_RE = /(<!-- creditcards:projects:start -->)([\s\S]*?)(<!-- creditcards:projects:end -->)/;

// --- shared formatting ------------------------------------------------------
// These mirror the inline formatters in creditcards.html exactly, so the
// runtime refresh lands on the same string the bake produced and nothing
// visibly jumps.

function fmtEth(n) {
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function fmtInt(n) {
  return n.toLocaleString('en-GB');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// House style bans dashes outright, and check-site fails the build on an em
// dash in visible text, so nothing X-sourced gets to carry one onto the page.
function stripDashes(s) {
  return String(s).replace(/\s*[—–]\s*/g, ', ');
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Dedupe key: same project announced with and without a trailing slash, or
// with tracking query params bolted on, is still the same project.
function normaliseUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.search = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

function hostOf(normalised) {
  try {
    return new URL(normalised).hostname;
  } catch {
    return null;
  }
}

// --- discovery ---------------------------------------------------------------

async function discover(data, token, fetchImpl, { query = X_QUERY, maxResults = X_MAX_RESULTS, sinceKey = 'sinceId' } = {}) {
  const params = new URLSearchParams({
    query,
    max_results: String(maxResults),
    'tweet.fields': 'created_at,public_metrics,entities',
    expansions: 'author_id',
    'user.fields': 'username',
  });
  if (data.meta[sinceKey]) {
    params.set('since_id', data.meta[sinceKey]);
    // Inside a since_id window the request is capped at 50 anyway; if a day
    // ever produces more, relevancy surfaces the announcements over the chat.
    params.set('sort_order', 'relevancy');
  } else {
    // First ever run: look back two days, newest first, to seed the window.
    params.set('start_time', new Date(Date.now() - 48 * 3600_000).toISOString());
    params.set('sort_order', 'recency');
  }

  const res = await fetchImpl(`${X_ENDPOINT}?${params}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body && (body.title || body.detail) ? ` (${body.title || body.detail})` : '';
    throw new Error(`X search ${res.status}${detail}`);
  }

  const users = new Map(((body.includes && body.includes.users) || []).map((u) => [u.id, u.username]));
  const tweets = body.data || [];

  const known = new Set(data.projects.map((p) => normaliseUrl(p.url)).filter(Boolean));
  let added = 0;

  for (const t of tweets) {
    const urls = (t.entities && t.entities.urls) || [];
    for (const u of urls) {
      const raw = u.unwound_url || u.expanded_url;
      if (!raw) continue;
      const normalised = normaliseUrl(raw);
      if (!normalised) continue;
      const host = hostOf(normalised);
      if (!host || HOST_BLOCKLIST.has(host)) continue;
      if (known.has(normalised)) continue;
      known.add(normalised);

      const handle = users.get(t.author_id) || '';
      data.projects.push({
        id: `${host}${new URL(normalised).pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase(),
        name: host,
        url: normalised,
        x: handle,
        post: handle ? `https://x.com/${handle}/status/${t.id}` : `https://x.com/i/status/${t.id}`,
        blurb: '',
        status: 'pending',
        added: new Date().toISOString().slice(0, 10),
        metrics: {
          likes: (t.public_metrics && t.public_metrics.like_count) || 0,
          reposts: (t.public_metrics && t.public_metrics.retweet_count) || 0,
        },
        // For review in the GitHub diff only; never rendered.
        tweetText: stripDashes(t.text || '').slice(0, 200),
      });
      added++;
    }
  }

  // Advance the window even on a zero-find day, so tomorrow never re-reads
  // (and re-pays for) today's posts.
  if (body.meta && body.meta.newest_id) data.meta[sinceKey] = body.meta.newest_id;
  return added;
}

// --- stats --------------------------------------------------------------------

// OpenSea's keyless API refuses some cloud IP ranges some of the time
// (GitHub's runners got a 401 on the collection endpoint on 25 Sep while
// Vercel's egress got 200s). When the direct call fails, the site's own
// /api/creditcards-stats serves the same four numbers from Vercel, so the
// baked fallback never goes stale just because the runner was refused.
const SITE_STATS = 'https://mooch.agency/api/creditcards-stats';

async function refreshStats(data, fetchImpl) {
  try {
    await refreshStatsDirect(data, fetchImpl);
    return 'OpenSea';
  } catch (direct) {
    const res = await fetchImpl(SITE_STATS, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${direct.message}; site stats ${res.status}`);
    const s = await res.json();
    if (typeof s.floorEth !== 'number' || typeof s.supply !== 'number' || typeof s.owners !== 'number') {
      throw new Error(`${direct.message}; site stats payload missing a field`);
    }
    data.meta.stats = {
      floorEth: s.floorEth,
      floorUsd: typeof s.floorUsd === 'number' ? s.floorUsd : data.meta.stats.floorUsd,
      supply: s.supply,
      owners: s.owners,
      fetchedAt: new Date().toISOString(),
    };
    return `site API (OpenSea direct failed: ${direct.message})`;
  }
}

async function refreshStatsDirect(data, fetchImpl) {
  const headers = { accept: 'application/json' };
  if (process.env.OPENSEA_API_KEY) headers['x-api-key'] = process.env.OPENSEA_API_KEY;
  const opts = { headers, signal: AbortSignal.timeout(10_000) };

  const [colRes, statsRes] = await Promise.all([
    fetchImpl('https://api.opensea.io/api/v2/collections/credits', opts),
    fetchImpl('https://api.opensea.io/api/v2/collections/credits/stats', opts),
  ]);
  if (!colRes.ok || !statsRes.ok) throw new Error(`OpenSea ${colRes.status}/${statsRes.status}`);
  const col = await colRes.json();
  const stats = await statsRes.json();

  const floorEth = stats.total && stats.total.floor_price;
  const usdPerEth = Number(col.pricing_currencies && col.pricing_currencies.listing_currency && col.pricing_currencies.listing_currency.usd_price);
  const supply = col.total_supply;
  const owners = stats.total && stats.total.num_owners;
  if (typeof floorEth !== 'number' || typeof supply !== 'number' || typeof owners !== 'number') {
    throw new Error('OpenSea payload missing a field');
  }

  data.meta.stats = {
    floorEth,
    floorUsd: Number.isFinite(usdPerEth) ? Math.round(floorEth * usdPerEth) : data.meta.stats.floorUsd,
    supply,
    owners,
    fetchedAt: new Date().toISOString(),
  };
}

// --- bake ----------------------------------------------------------------------

// The colours live in tokens.css so the marks follow the design system, and
// so check-site's no-colour-literals rule holds even for baked markup.
const GRID_COLOURS = ['var(--credit-c)', 'var(--credit-m)', 'var(--credit-y)', 'var(--credit-k)'];

// Each card's tile is an 8x8 CMYK grid drawn from a SHA-256 of the project's
// id, the same move as the collection itself: a Credit is drawn from its
// hashed transaction ID. Cell on/off comes from the hash's first 64 bits;
// colour from a second hash so the two choices stay independent. Pure
// function of the id, so the bake stays byte-stable run to run.
function gridSvg(id) {
  const on = createHash('sha256').update(id).digest();
  const colour = createHash('sha256').update(`${id}:colour`).digest();
  let rects = '';
  for (let i = 0; i < 64; i++) {
    if (!((on[i >> 3] >> (i & 7)) & 1)) continue;
    const fill = GRID_COLOURS[colour[i % 32] & 3];
    rects += `<rect x="${(i % 8) * 10 + 1}" y="${Math.floor(i / 8) * 10 + 1}" width="8" height="8" fill="${fill}"/>`;
  }
  return `<svg class="proj-art" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${rects}</svg>`;
}

function renderProjects(projects) {
  const approved = projects
    .filter((p) => p.status === 'approved')
    .sort((a, b) => (a.added === b.added ? a.name.localeCompare(b.name) : b.added.localeCompare(a.added)));

  if (!approved.length) {
    return (
      '\n    <p class="projects-empty">Nothing listed yet. The first finds land here once a human has looked at them.</p>\n    '
    );
  }

  // One featured slot at most: the first approved entry flagged
  // "featured": true in the data file. It leads the grid on a black base,
  // full width, so it never leaves a hole in the rows below it.
  const featured = approved.find((p) => p.featured);
  const ordered = featured ? [featured, ...approved.filter((p) => p !== featured)] : approved;

  const items = ordered
    .map((p) => {
      const isFeatured = p === featured;
      const name = escapeHtml(stripDashes(p.name));
      const blurb = escapeHtml(stripDashes(p.blurb));
      const handle = escapeHtml(p.x);
      const url = escapeHtml(p.url);
      const by = p.x
        ? `<a href="${escapeHtml(p.post)}" target="_blank" rel="noopener" data-event="creditcards_post_click">@${handle}</a>`
        : '<span></span>';
      return [
        isFeatured ? '      <li class="proj-card proj-card--featured">' : '      <li class="proj-card">',
        `        ${gridSvg(p.id)}`,
        isFeatured
          ? '        <p class="proj-flag"><span class="proj-flag-marks" aria-hidden="true"><i></i><i></i><i></i><i></i></span>Featured</p>'
          : null,
        `        <a class="proj-name" href="${url}" target="_blank" rel="noopener" data-event="creditcards_project_click">${name}</a>`,
        blurb ? `        <p class="proj-blurb">${blurb}</p>` : null,
        isFeatured
          ? `        <p class="proj-cta"><a class="pill" href="${url}" target="_blank" rel="noopener" data-event="creditcards_featured_click">Open ${name} <span class="arrow">&rarr;</span></a></p>`
          : null,
        `        <p class="proj-by">${by}<span>${fmtDate(p.added)}</span></p>`,
        '      </li>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  return `\n    <ol class="projects">\n${items}\n    </ol>\n    `;
}

function bakeStat(html, key, value) {
  const re = new RegExp(`(<span data-stat="${key}">)([^<]*)(</span>)`);
  if (!re.test(html)) throw new Error(`no data-stat="${key}" span in ${PAGE_FILE}`);
  return html.replace(re, `$1${value}$3`);
}

function bake(html, data) {
  if (!MARKER_RE.test(html)) throw new Error(`creditcards:projects markers missing from ${PAGE_FILE}`);
  let next = html.replace(MARKER_RE, (_, open, __, close) => `${open}${renderProjects(data.projects)}${close}`);
  const s = data.meta.stats;
  next = bakeStat(next, 'floorEth', fmtEth(s.floorEth));
  next = bakeStat(next, 'floorUsd', fmtInt(s.floorUsd));
  next = bakeStat(next, 'supply', fmtInt(s.supply));
  next = bakeStat(next, 'owners', fmtInt(s.owners));
  return next;
}

// --- run -------------------------------------------------------------------------

export async function run({ xToken, fetchImpl = fetch, root = ROOT, dry = DRY, bakeOnly = BAKE_ONLY } = {}) {
  const dataFile = path.join(root, DATA_FILE);
  const pageFile = path.join(root, PAGE_FILE);
  const data = JSON.parse(readFileSync(dataFile, 'utf8'));
  const html = readFileSync(pageFile, 'utf8');

  if (bakeOnly) {
    console.log('= discovery and stats skipped (--bake-only)');
  } else {
    if (!xToken) {
      console.log('= X_BEARER_TOKEN not set, discovery skipped (add it as an Actions secret to enable)');
    } else {
      try {
        const added = await discover(data, xToken, fetchImpl);
        console.log(`✓ X search: ${added} new candidate(s) pending review`);
      } catch (e) {
        // A rate limit or auth blip must not kill the bake; the 7-day search
        // window means tomorrow's run covers today's gap.
        console.error(`✗ X search failed, continuing: ${e.message}`);
      }
      try {
        const added = await discover(data, xToken, fetchImpl, {
          query: X_REPLY_QUERY,
          maxResults: X_REPLY_MAX_RESULTS,
          sinceKey: 'replySinceId',
        });
        console.log(`✓ X replies to @${X_REPLY_HANDLE}: ${added} new candidate(s) pending review`);
      } catch (e) {
        console.error(`✗ X reply search failed, continuing: ${e.message}`);
      }
    }
    try {
      const source = await refreshStats(data, fetchImpl);
      console.log(`✓ Stats via ${source}: floor ${fmtEth(data.meta.stats.floorEth)} ETH, supply ${fmtInt(data.meta.stats.supply)}`);
    } catch (e) {
      console.error(`✗ Stats refresh failed, keeping baked stats: ${e.message}`);
    }
    data.meta.lastRun = new Date().toISOString();
  }

  const nextHtml = bake(html, data);
  const nextJson = JSON.stringify(data, null, 2) + '\n';
  const htmlChanged = nextHtml !== html;
  const jsonChanged = nextJson !== readFileSync(dataFile, 'utf8');

  if (dry) {
    console.log(`→ would ${htmlChanged ? 'rewrite' : 'leave'} ${PAGE_FILE}, ${jsonChanged ? 'rewrite' : 'leave'} ${DATA_FILE}`);
    return;
  }
  if (jsonChanged) writeFileSync(dataFile, nextJson);
  if (htmlChanged) writeFileSync(pageFile, nextHtml);
  console.log(`${htmlChanged || jsonChanged ? '✓ wrote' : '= no changes to'} ${PAGE_FILE} + ${DATA_FILE}`);
}

// Only run when invoked directly, not when a test harness imports `run`.
// Compared as resolved paths, matching copy-counts.mjs.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await run({ xToken: process.env.X_BEARER_TOKEN });
  process.exit(process.exitCode || 0);
}
