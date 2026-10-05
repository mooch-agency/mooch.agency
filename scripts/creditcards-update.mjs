#!/usr/bin/env node
// ---------------------------------------------------------------------------
// creditcards-update.mjs: keep /creditcards fresh.
//
// Three jobs, in order, each surviving the others' failure:
//
//   1. Discovery (needs X_BEARER_TOKEN, see creditcards-discover.mjs): two
//      sources, each with its own since-id in data.meta: the main keyword
//      search (sinceId) and replies to @jesusdoteth where builders submit
//      (replySinceId).
//      Posts are mined for links in the post, in a quoted or reposted post, in
//      the author's bio when the post says "link in bio", and in the author's
//      own first reply when the post itself has none. New external links land
//      in data/creditcards.json as status "pending", with a score and flags
//      (coin, denylist, article) that only rank and label, plus a suggested
//      category (a keyword guess, see creditcards-categories.mjs). Nothing
//      pending ever renders; a human flips it to "approved" (and tidies the
//      blurb, name and category) first. Rejected entries stay as tombstones so a re-announced URL is
//      never re-added. Cost control: at most 50 + 25 search posts and
//      one 25-post thread lookup a run, windowed by since-ids so a
//      quiet day reads almost nothing; at most 15 new entries a run and 3 per
//      author.
//
//   2. Stats refresh (best effort, keyless): the same two OpenSea endpoints
//      api/creditcards-stats.js proxies at runtime. Baking the numbers here
//      means the page shows a value at most a day old with no JavaScript at
//      all, and the runtime fetch merely nudges it. Same trade as
//      copy-counts.mjs, same reason.
//
//   3. Bake: regenerate the approved-projects block between the
//      creditcards:projects markers in creditcards.html (the count line, the
//      category filter pills with their counts, and a data-category on every
//      card, plus the Perks pill and view from data.perks, see
//      creditcards-perks.mjs), the top-creditors
//      list between the creditcards:creditors markers, and the data-stat
//      spans. Output is deterministic (stable sort, fixed indentation) so a
//      no-change run produces no git diff and the daily workflow commits
//      nothing. Every approved project needs a category from
//      creditcards-categories.mjs; one without fails the bake (and
//      check-site), so a half-finished approval never reaches the page.
//
// Entry fields in data/creditcards.json (projects[]):
//   id, name, url      identity; the url is the dedupe key once normalised
//   x, post            builder handle and the announcement post
//   with               optional, co-builders' X handles, shown after x
//   blurb              one line for the card, written by a human
//   category           rarity | art | statements | games | markets. Required
//                      once approved; discovery pre-fills a suggestion on
//                      pending entries, so approving is one edit (status)
//   status             pending | approved | rejected (rejected = tombstone)
//   featured,sponsored optional, the one featured slot (see renderProjects)
//   added              YYYY-MM-DD, drives the order on the page
//   metrics            likes and reposts at discovery time
//   source, score, flags, tweetText
//                      review aids from discovery, never rendered
//
// Perks (perks[], written by a human, never by discovery): fields and the
// status rule are documented in creditcards-perks.mjs. Status (open, ended,
// unknown) is worked out for the UTC day the bake runs, so a perk flips to
// Ended on the first bake after its end date, and that run commits the page.
//
// Run:   node scripts/creditcards-update.mjs              full run
//        node scripts/creditcards-update.mjs --bake-only  skip X and OpenSea
//        node scripts/creditcards-update.mjs --dry        print, write nothing
//
// Auth: X_BEARER_TOKEN in the environment for discovery. Without it the script
// logs one line, skips discovery and still bakes, exiting 0: the daily
// workflow stays green before the secret exists.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  MAX_NEW_PER_AUTHOR,
  MAX_NEW_PER_RUN,
  TCO_MAX_RESOLVE,
  THREAD_MAX_CONVERSATIONS,
  X_API,
  acceptableUrl,
  assess,
  entityLinks,
  hostOf,
  isShortener,
  knownHostOf,
  mentionsLinkInBio,
  normaliseUrl,
  pickCandidates,
  refOf,
  strayTcoLinks,
} from './creditcards-discover.mjs';
import { CATEGORIES, categoryProblems, suggestCategory } from './creditcards-categories.mjs';
import { PERK_TYPES, perkProblems, perkStatus, sortPerks, todayUtc } from './creditcards-perks.mjs';

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

// Fields every tweet read asks for: entities for links, referenced tweets for
// quotes, reposts and threads, and the author's profile link for "link in bio".
const TWEET_FIELDS = 'created_at,public_metrics,entities,referenced_tweets,conversation_id,author_id';
const TWEET_EXPANSIONS = 'author_id,referenced_tweets.id,referenced_tweets.id.author_id';
const USER_FIELDS = 'username,url,entities';

// Every X read goes through here. A 429 says when the window resets, so the
// workflow log shows whether the next scheduled run will clear it.
async function xGet(pathAndQuery, token, fetchImpl) {
  const res = await fetchImpl(`${X_API}${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    let detail = body && (body.title || body.detail) ? ` (${body.title || body.detail})` : '';
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset'));
      if (Number.isFinite(reset) && reset > 0) detail += `, rate limited until ${new Date(reset * 1000).toISOString()}`;
    }
    throw new Error(`X ${res.status}${detail}`);
  }
  return body;
}

const MARKER_RE = /(<!-- creditcards:projects:start -->)([\s\S]*?)(<!-- creditcards:projects:end -->)/;
const CREDITORS_RE = /(<!-- creditcards:creditors:start -->)([\s\S]*?)(<!-- creditcards:creditors:end -->)/;

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

// --- discovery ---------------------------------------------------------------

const ANNOUNCE_RE = /credit|jack|built|made|try|play|live|check|launch/i;

// One pool for the whole run. Sources add pages of posts to it, resolve()
// turns posts into candidate links, and commit() adds the best of them.
class Pool {
  constructor(data, fetchImpl) {
    this.data = data;
    this.fetchImpl = fetchImpl;
    this.known = new Set(data.projects.map((p) => normaliseUrl(p.url)).filter(Boolean));
    this.users = new Map();
    this.tweets = new Map();
    this.items = []; // { tweet, source }
    this.threadRoots = new Map(); // conversation id -> { tweet, source }
    this.cands = new Map(); // normalised url -> candidate
    this.tcoBudget = TCO_MAX_RESOLVE;
  }

  addPage(body, source) {
    for (const u of (body.includes && body.includes.users) || []) this.users.set(u.id, u);
    for (const t of (body.includes && body.includes.tweets) || []) this.tweets.set(t.id, t);
    for (const t of body.data || []) {
      this.tweets.set(t.id, t);
      this.items.push({ tweet: t, source });
    }
  }

  handleOf(tweet) {
    const u = this.users.get(tweet.author_id);
    return (u && u.username) || '';
  }

  // X sometimes leaves a link unexpanded, or out of entities altogether.
  // Follow the redirect ourselves: no API cost, capped per run, and a failure
  // only loses that one link.
  async expand(link) {
    let raw = link.raw;
    const host = raw ? hostOf(normaliseUrl(raw) || '') : 't.co';
    if ((!raw || host === 't.co' || isShortener(host)) && this.tcoBudget > 0) {
      this.tcoBudget--;
      const from = raw || link.tco;
      try {
        const res = await this.fetchImpl(from, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
        const loc = res.headers && res.headers.get('location');
        if (loc) raw = new URL(loc, from).toString();
      } catch {
        /* keep what we had */
      }
    }
    return raw;
  }

  async linksOf(tweet) {
    const out = [];
    const links = [...entityLinks(tweet), ...strayTcoLinks(tweet).map((tco) => ({ tco, raw: null }))];
    for (const l of links) {
      const raw = await this.expand(l);
      const n = raw && normaliseUrl(raw);
      if (n && acceptableUrl(n) && !out.includes(n)) out.push(n);
    }
    return out;
  }

  offer(url, tweet, source, via, text) {
    if (this.known.has(url)) return;
    const handle = this.handleOf(tweet);
    const likes = (tweet.public_metrics && tweet.public_metrics.like_count) || 0;
    const { flags, score } = assess({ url, text, source, likes, via, knownHost: knownHostOf(url, this.known) });
    const prev = this.cands.get(url);
    // The same link from two posts in one run: keep the earliest post (the
    // announcement) and the better score.
    if (prev) {
      if (BigInt(tweet.id) < BigInt(prev.tweetId)) Object.assign(prev, { tweetId: tweet.id, handle, tweet, via, likes, text });
      if (score > prev.score) Object.assign(prev, { score, flags, source });
      return;
    }
    this.cands.set(url, { url, tweetId: tweet.id, handle, tweet, source, via, score, flags, likes, text });
  }

  async resolve() {
    for (const { tweet, source } of this.items) {
      const text = tweet.text || '';
      let found = 0;

      for (const url of await this.linksOf(tweet)) {
        this.offer(url, tweet, source, 'post', text);
        found++;
      }

      // A quote or a repost: the project is the other post's, so credit its
      // author and link its post.
      for (const type of ['quoted', 'retweeted']) {
        const refId = refOf(tweet, type);
        const ref = refId && this.tweets.get(refId);
        if (!ref) continue;
        for (const url of await this.linksOf(ref)) {
          this.offer(url, ref, source, type === 'quoted' ? 'quote' : 'repost', `${ref.text || ''} ${text}`);
          found++;
        }
      }
      if (found) continue;

      // "Link in bio": the author's profile link stands in for the post's.
      if (mentionsLinkInBio(text)) {
        const u = this.users.get(tweet.author_id);
        const bio = u && u.entities && u.entities.url && u.entities.url.urls && u.entities.url.urls[0];
        const n = bio && normaliseUrl(bio.expanded_url || bio.url);
        if (n && acceptableUrl(n)) {
          this.offer(n, tweet, source, 'bio', text);
          continue;
        }
      }

      // Nothing yet, but a thread root may carry its link in the first reply.
      if (tweet.conversation_id === tweet.id && !refOf(tweet, 'retweeted')) {
        this.threadRoots.set(tweet.id, { tweet, source });
      }
    }
  }

  // One recent search for every thread root at once: the authors' own
  // replies that carry a link. Announcement-looking posts go first.
  async followThreads(token) {
    const roots = [...this.threadRoots.values()]
      .sort((a, b) => Number(ANNOUNCE_RE.test(b.tweet.text || '')) - Number(ANNOUNCE_RE.test(a.tweet.text || '')))
      .slice(0, THREAD_MAX_CONVERSATIONS);
    if (!roots.length) return 0;
    const params = new URLSearchParams({
      query: `(${roots.map((r) => `conversation_id:${r.tweet.id}`).join(' OR ')}) is:reply has:links -is:retweet`,
      max_results: '25',
      'tweet.fields': TWEET_FIELDS,
      expansions: 'author_id',
      'user.fields': USER_FIELDS,
    });
    const body = await xGet(`/tweets/search/recent?${params}`, token, this.fetchImpl);
    for (const u of (body.includes && body.includes.users) || []) this.users.set(u.id, u);
    const byRoot = new Map(roots.map((r) => [r.tweet.id, r]));
    let n = 0;
    for (const reply of body.data || []) {
      const root = byRoot.get(reply.conversation_id);
      if (!root || reply.author_id !== root.tweet.author_id) continue;
      for (const url of await this.linksOf(reply)) {
        // Credit the root post: it is the announcement people see.
        this.offer(url, root.tweet, root.source, 'thread', `${root.tweet.text || ''} ${reply.text || ''}`);
        n++;
      }
    }
    return n;
  }

  commit(log) {
    const { kept, dropped } = pickCandidates([...this.cands.values()]);
    const today = new Date().toISOString().slice(0, 10);
    for (const c of kept) {
      const host = hostOf(c.url);
      const handle = c.handle;
      const source = c.via === 'post' ? c.source : `${c.source}+${c.via}`;
      this.data.projects.push({
        id: `${host}${new URL(c.url).pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase(),
        name: host,
        url: c.url,
        x: handle,
        post: handle ? `https://x.com/${handle}/status/${c.tweetId}` : `https://x.com/i/status/${c.tweetId}`,
        blurb: '',
        // A suggestion only, from name, url and post text; a human checks it
        // when approving. Kept as the real field so approval is one edit.
        category: suggestCategory({ name: host, url: c.url, tweetText: c.tweet.text || '', flags: c.flags }),
        status: 'pending',
        added: today,
        metrics: {
          likes: c.likes,
          reposts: (c.tweet.public_metrics && c.tweet.public_metrics.retweet_count) || 0,
        },
        // For review in the GitHub diff only; never rendered. Score and flags
        // rank and label, they never approve or reject anything.
        source,
        score: c.score,
        flags: c.flags,
        tweetText: stripDashes(c.tweet.text || '').slice(0, 200),
      });
      this.known.add(c.url);
      const entry = this.data.projects[this.data.projects.length - 1];
      log(`  + [${source}] ${c.url} @${handle} score ${c.score}${c.flags.length ? ` (${c.flags.join(', ')})` : ''}, suggested ${entry.category}`);
    }
    for (const c of dropped) log(`  - over the per-run or per-author cap, not added: ${c.url} @${c.handle} score ${c.score}`);
    return kept.length;
  }
}

async function searchSource(pool, token, { query, maxResults, sinceKey, source }) {
  const data = pool.data;
  const params = new URLSearchParams({
    query,
    max_results: String(maxResults),
    'tweet.fields': TWEET_FIELDS,
    expansions: TWEET_EXPANSIONS,
    'user.fields': USER_FIELDS,
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
  const body = await xGet(`/tweets/search/recent?${params}`, token, pool.fetchImpl);
  pool.addPage(body, source);
  // Advance the window even on a zero-find day, so tomorrow never re-reads
  // (and re-pays for) today's posts.
  if (body.meta && body.meta.newest_id) data.meta[sinceKey] = body.meta.newest_id;
  return (body.data || []).length;
}

export async function discover(data, token, fetchImpl = fetch, log = console.log, logErr = console.error) {
  const pool = new Pool(data, fetchImpl);
  const sources = [
    ['X search', () => searchSource(pool, token, { query: X_QUERY, maxResults: X_MAX_RESULTS, sinceKey: 'sinceId', source: 'search' })],
    [
      `X replies to @${X_REPLY_HANDLE}`,
      () =>
        searchSource(pool, token, { query: X_REPLY_QUERY, maxResults: X_REPLY_MAX_RESULTS, sinceKey: 'replySinceId', source: 'replies' }),
    ],
  ];
  // Each source survives the others' failure. A failed source leaves its
  // since-id where it was, so the next run re-reads the gap (search windows
  // reach back 7 days).
  for (const [label, read] of sources) {
    try {
      log(`✓ ${label}: ${await read()} post(s) read`);
    } catch (e) {
      logErr(`✗ ${label} failed, continuing: ${e.message}`);
    }
  }
  await pool.resolve();
  if (pool.threadRoots.size) {
    try {
      const n = await pool.followThreads(token);
      log(`✓ X threads: ${n} link(s) in self-replies under ${Math.min(pool.threadRoots.size, THREAD_MAX_CONVERSATIONS)} linkless post(s)`);
    } catch (e) {
      logErr(`✗ X thread follow-up failed, continuing: ${e.message}`);
    }
  }
  const added = pool.commit(log);
  log(`✓ X: ${added} new candidate(s) pending review (max ${MAX_NEW_PER_RUN} a run, ${MAX_NEW_PER_AUTHOR} per author)`);
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

// The paid slot line under the featured card. Price, the Credit alternative,
// the payment address and the DM link all come from data.featuredSlot, so a
// price change is a data edit, not a template edit. No featuredSlot, no line.
function renderSponsorLine(slot) {
  if (!slot) return null;
  const price = escapeHtml(stripDashes(slot.price));
  const per = escapeHtml(stripDashes(slot.per));
  const credit = escapeHtml(stripDashes(slot.credit));
  const address = escapeHtml(slot.address);
  const network = slot.network ? ` on ${escapeHtml(slot.network)}` : '';
  const dm = escapeHtml(slot.dm);
  const dmLabel = escapeHtml(stripDashes(slot.dmLabel));
  return [
    '      <li class="proj-sponsor" data-category="all">',
    `        <p>Feature your project here: ${price} a ${per} or ${credit} to <button type="button" class="proj-sponsor-address" data-copy="${address}" title="Copy ${address}${network}" data-event="creditcards_sponsor_copy">${address}</button><span class="proj-sponsor-sep" aria-hidden="true">&middot;</span><a href="${dm}" target="_blank" rel="noopener" data-event="creditcards_sponsor_click">${dmLabel} <span class="arrow">&rarr;</span></a></p>`,
    '      </li>',
  ].join('\n');
}

// The projects heading and its count. Visually hidden since the 30 Sep 2026
// tidy (the pills say the same on screen), but kept for screen readers: the
// filter script rewrites the count on every change ("X of N shown").
function renderHead(total) {
  const count = total ? `${total} ${total === 1 ? 'project' : 'projects'}` : '';
  return [
    '    <div class="projects-head">',
    '      <h2 id="projects">The projects</h2>',
    count
      ? `      <p><span data-filter-status aria-live="polite">${count}</span> &middot; Found daily on X</p>`
      : '      <p>Found daily on X</p>',
    '    </div>',
  ].join('\n');
}

// The category pills: All first, then Perks when there are any (straight
// after All, so on a phone it sits on the first screen of the sideways row
// rather than off the end), then CATEGORIES in their fixed order, each with
// its total in data-count (the filter script reads it). All and Perks show a
// number on screen, All the size of the index; the categories are bare
// labels, so the row reads as choices rather than a table of figures. Plain buttons with aria-pressed; they do nothing
// until the inline filter script wires them up, so with no JavaScript every
// card, and the perks list under the projects, simply stays on the page.
// While any perk is open the Perks pill carries the live dot (the Open
// badge's cyan square) and reads "Perks N open" instead of its total; with
// none open it is a plain pill with the total, like the rest.
function renderFilter(approved, perkCount, perksOpen = 0) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.slug, 0]));
  for (const p of approved) counts[p.category] += 1;
  const pills = [
    { slug: 'all', label: 'All', total: approved.length, n: approved.length, controls: 'project-list' },
    ...(perkCount
      ? [{ slug: 'perks', label: 'Perks', total: perkCount, n: perksOpen ? `${perksOpen} open` : perkCount, dot: perksOpen > 0, controls: 'perk-list' }]
      : []),
    ...CATEGORIES.map((c) => ({ ...c, total: counts[c.slug], controls: 'project-list' })),
  ];
  return [
    '    <div class="cc-filter" role="group" aria-label="Filter projects by category" data-scroller>',
    ...pills.map(
      (c) =>
        `      <button type="button" class="cc-filter-pill" data-filter="${c.slug}" aria-pressed="${c.slug === 'all'}" aria-controls="${c.controls}" data-count="${c.total}">${c.dot ? '<span class="cc-filter-dot" aria-hidden="true"></span>' : ''}${escapeHtml(c.label)}${c.n === undefined ? '' : ` <span class="cc-filter-n">${c.n}</span>`}</button>`,
    ),
    '    </div>',
  ].join('\n');
}

const PERK_TYPE_LABEL = Object.fromEntries(PERK_TYPES.map((t) => [t.slug, t.label]));
const PERK_STATUS_LABEL = { open: 'Open', ended: 'Ended', unknown: 'Status unknown' };

// The date on a perk card: its end when one is stated ("Ends" or "Ended"),
// otherwise the day it was announced.
function perkDate(p, status) {
  if (p.end) return `<time datetime="${p.end}">${status === 'ended' ? 'Ended' : 'Ends'} ${fmtDate(p.end)}</time>`;
  if (p.start) return `<time datetime="${p.start}">${fmtDate(p.start)}</time>`;
  return '<span></span>';
}

// The Perks view: every perk ever offered to Credits holders, ended ones
// included (muted, never removed). Same card anatomy as a project: the
// name opening the project, the handle opening the builder's post, the
// date on the right. Hidden by the filter script until the Perks pill is
// pressed; with no JavaScript it sits under the projects.
function renderPerks(perks, dm, today) {
  if (!perks || !perks.length) return null;
  const sorted = sortPerks(perks, today);
  // Where the paid-alert band goes in this view: straight after the perks
  // you can still claim (open, then unknown), before the ended ones. Empty in
  // the HTML; the band's script moves the one #subscribe band in here while
  // the Perks view is showing, so the form sits where the intent is.
  const firstEnded = sorted.findIndex((p) => perkStatus(p, today) === 'ended');
  const slotAt = firstEnded === -1 ? sorted.length : firstEnded;
  const slot = '        <li data-standing-slot></li>';
  const cards = sorted
    .map((p) => {
      const status = perkStatus(p, today);
      const name = escapeHtml(stripDashes(p.project));
      const reason = p.ended ? `<span class="perk-reason">${escapeHtml(stripDashes(p.ended))}</span>` : '';
      return [
        `      <li class="proj-card perk-card perk-card--${status}" data-perk="${escapeHtml(p.id)}" data-status="${status}">`,
        `        <p class="perk-tags"><span class="perk-status">${PERK_STATUS_LABEL[status]}</span><span class="perk-type">${escapeHtml(PERK_TYPE_LABEL[p.type])}</span>${reason}</p>`,
        `        <a class="proj-name" href="${escapeHtml(p.url)}" target="_blank" rel="noopener" data-event="creditcards_perk_click">${name}</a>`,
        `        <p class="proj-blurb">${escapeHtml(stripDashes(p.description))}</p>`,
        `        <p class="perk-for"><span class="perk-for-label">For</span> ${escapeHtml(stripDashes(p.eligibility))}</p>`,
        `        <p class="proj-by"><span class="proj-by-names"><a href="${escapeHtml(p.post)}" target="_blank" rel="noopener" data-event="creditcards_perk_post_click">@${escapeHtml(p.x)}</a></span>${perkDate(p, status)}</p>`,
        '      </li>',
      ]
        .map((line) => `  ${line}`)
        .join('\n');
    });
  const items = [...cards.slice(0, slotAt), slot, ...cards.slice(slotAt)].join('\n');
  // Just the ask: the cards and the band below explain the view themselves.
  const ask = dm
    ? `      <p class="perks-intro"><a href="${escapeHtml(dm)}" target="_blank" rel="noopener" data-event="creditcards_perk_submit">Know about a perk? DM @jesusdoteth <span class="arrow">&rarr;</span></a></p>`
    : null;
  return [
    '    <div class="perks-view" id="perk-list">',
    ...(ask ? [ask] : []),
    '      <ol class="projects perks">',
    items,
    '      </ol>',
    '    </div>',
  ].join('\n');
}

function renderProjects(projects, slot, perks = [], today = todayUtc()) {
  const approved = projects
    .filter((p) => p.status === 'approved')
    .sort((a, b) => (a.added === b.added ? a.name.localeCompare(b.name) : b.added.localeCompare(a.added)));

  if (!approved.length) {
    return `\n${renderHead(0)}\n    <p class="projects-empty">Nothing listed yet. The first finds land here once a human has looked at them.</p>\n    `;
  }

  // One featured slot at most: the first approved entry flagged
  // "featured": true in the data file. It leads the grid on a black base,
  // full width, so it never leaves a hole in the rows below it. Add
  // "sponsored": true to the same entry when the slot is paid for, and the
  // eyebrow reads Sponsored instead of Featured. It carries its own
  // data-category like any card, so it shows under All and under its
  // category; the paid-slot line is data-category="all", All only.
  const featured = approved.find((p) => p.featured);
  const ordered = featured ? [featured, ...approved.filter((p) => p !== featured)] : approved;

  const items = ordered
    .map((p) => {
      const isFeatured = p === featured;
      const name = escapeHtml(stripDashes(p.name));
      const blurb = escapeHtml(stripDashes(p.blurb));
      const handle = escapeHtml(p.x);
      const url = escapeHtml(p.url);
      // Co-builders from "with" follow the lead handle, each linking to their
      // own profile; the lead handle still opens the announcement post.
      const co = (p.with || [])
        .map((h) => ` &amp; <a href="https://x.com/${escapeHtml(h)}" target="_blank" rel="noopener" data-event="creditcards_builder_click">@${escapeHtml(h)}</a>`)
        .join('');
      const by = p.x
        ? `<span class="proj-by-names"><a href="${escapeHtml(p.post)}" target="_blank" rel="noopener" data-event="creditcards_post_click">@${handle}</a>${co}</span>`
        : '<span></span>';
      return [
        `      <li class="proj-card${isFeatured ? ' proj-card--featured' : ''}" data-category="${p.category}">`,
        isFeatured
          ? `        <p class="proj-flag"><span class="proj-flag-marks" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${p.sponsored ? 'Sponsored' : 'Featured'}</p>`
          : null,
        `        <a class="proj-name" href="${url}" target="_blank" rel="noopener" data-event="creditcards_project_click">${name}</a>`,
        blurb ? `        <p class="proj-blurb">${blurb}</p>` : null,
        isFeatured
          ? `        <p class="proj-cta"><a class="pill" href="${url}" target="_blank" rel="noopener" data-event="creditcards_featured_click">Open ${name} <span class="arrow">&rarr;</span></a></p>`
          : null,
        `        <p class="proj-by">${by}<span>${fmtDate(p.added)}</span></p>`,
        '      </li>',
        isFeatured ? renderSponsorLine(slot) : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const perksBlock = renderPerks(perks, slot && slot.dm, today);
  return `\n${renderHead(approved.length)}\n${renderFilter(approved, perks.length, perks.filter((p) => perkStatus(p, today) === 'open').length)}\n    <ol class="projects" id="project-list">\n${items}\n    </ol>\n${perksBlock ? `${perksBlock}\n` : ''}    `;
}

// --- top creditors -------------------------------------------------------------

// Jack made Credits; the board celebrates the people building on it, so his
// own entries never count towards it.
const CREDITOR_EXCLUDE = new Set(['jackbutcher']);
const CREDITOR_SLOTS = 3;

// Approved projects per builder X handle, top three. Ties go to whoever got
// there first: walk the approved list in the order it happened (added date,
// then data-file order) and remember the step at which each builder reached
// their final count. Handles compare case-insensitively; the spelling shown
// is the builder's most recent one. Pure function of the data file, so the
// bake stays byte-stable.
export function topCreditors(projects, slots = CREDITOR_SLOTS) {
  const timeline = projects
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.status === 'approved' && p.x && !CREDITOR_EXCLUDE.has(p.x.toLowerCase()))
    .sort((a, b) => (a.p.added === b.p.added ? a.i - b.i : a.p.added.localeCompare(b.p.added)));
  const byHandle = new Map();
  timeline.forEach(({ p }, step) => {
    const key = p.x.toLowerCase();
    const c = byHandle.get(key) || { handle: p.x, count: 0, reachedAt: 0 };
    c.handle = p.x;
    c.count += 1;
    c.reachedAt = step;
    byHandle.set(key, c);
  });
  return [...byHandle.values()]
    .sort((a, b) => b.count - a.count || a.reachedAt - b.reachedAt)
    .slice(0, slots);
}

// One list item per builder, inside the ol.creditors-list at the foot of the
// index. The avatar is a letter circle with the unavatar.io photo laid over
// it; if the photo fails (rate limit, blocked, offline) onerror drops it and
// the letter shows through, so the row never shows a broken image.
function renderCreditors(projects) {
  const top = topCreditors(projects);
  if (!top.length) return '\n        ';
  const items = top
    .map((c) => {
      const h = escapeHtml(c.handle);
      const initial = escapeHtml(c.handle.replace(/^[^a-z0-9]+/i, '').charAt(0).toUpperCase() || '@');
      return [
        `        <li><a class="creditor" href="https://x.com/${h}" target="_blank" rel="noopener" data-event="creditcards_leaderboard_click">`,
        `          <span class="creditor-av" aria-hidden="true">${initial}<img src="https://unavatar.io/x/${h}" width="22" height="22" loading="lazy" alt="" onerror="this.remove()"></span>`,
        `          <span class="creditor-handle">@${h}</span> <span class="creditor-n">${c.count} ${c.count === 1 ? 'project' : 'projects'}</span>`,
        '        </a></li>',
      ].join('\n');
    })
    .join('\n');
  return `\n${items}\n        `;
}

// The band's opening line, true for the day of the bake: how many of the
// perks listed have already ended. Grammar follows the counts, and with no
// perks (or none ended) it falls back to a line that claims nothing.
export function perksLine(perks, today = todayUtc()) {
  const total = (perks || []).length;
  const ended = (perks || []).filter((p) => perkStatus(p, today) === 'ended').length;
  if (!total || !ended) return "Don't miss the next perk for Credits holders.";
  return `You've missed ${ended} ${ended === 1 ? 'perk' : 'perks'} for Credits holders so far.`;
}

function bakeStat(html, key, value) {
  const re = new RegExp(`(<span data-stat="${key}">)([^<]*)(</span>)`);
  if (!re.test(html)) throw new Error(`no data-stat="${key}" span in ${PAGE_FILE}`);
  return html.replace(re, `$1${value}$3`);
}

function bake(html, data, today = todayUtc()) {
  const problems = [...categoryProblems(data.projects), ...perkProblems(data.perks)];
  if (problems.length) throw new Error(`${DATA_FILE}: ${problems.join('; ')}`);
  if (!MARKER_RE.test(html)) throw new Error(`creditcards:projects markers missing from ${PAGE_FILE}`);
  let next = html.replace(MARKER_RE, (_, open, __, close) => `${open}${renderProjects(data.projects, data.featuredSlot, data.perks || [], today)}${close}`);
  if (!CREDITORS_RE.test(next)) throw new Error(`creditcards:creditors markers missing from ${PAGE_FILE}`);
  next = next.replace(CREDITORS_RE, (_, open, __, close) => `${open}${renderCreditors(data.projects)}${close}`);
  const s = data.meta.stats;
  next = bakeStat(next, 'floorEth', fmtEth(s.floorEth));
  next = bakeStat(next, 'floorUsd', fmtInt(s.floorUsd));
  next = bakeStat(next, 'supply', fmtInt(s.supply));
  next = bakeStat(next, 'owners', fmtInt(s.owners));
  next = bakeStat(next, 'perksLine', escapeHtml(perksLine(data.perks, today)));
  return next;
}

// --- run -------------------------------------------------------------------------

export async function run({ xToken, fetchImpl = fetch, root = ROOT, dry = DRY, bakeOnly = BAKE_ONLY, today = todayUtc() } = {}) {
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
      await discover(data, xToken, fetchImpl);
    }
    try {
      const source = await refreshStats(data, fetchImpl);
      console.log(`✓ Stats via ${source}: floor ${fmtEth(data.meta.stats.floorEth)} ETH, supply ${fmtInt(data.meta.stats.supply)}`);
    } catch (e) {
      console.error(`✗ Stats refresh failed, keeping baked stats: ${e.message}`);
    }
    data.meta.lastRun = new Date().toISOString();
  }

  const nextHtml = bake(html, data, today);
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
