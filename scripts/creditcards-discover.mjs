// ---------------------------------------------------------------------------
// creditcards-discover.mjs: the X side of creditcards-update.mjs.
//
// Four sources feed one candidate pool; the three searches each keep their own
// since-id bookmark in data.meta so none ever skips another's posts:
//
//   search   the main keyword query                     meta.sinceId
//   replies  replies addressed to @jesusdoteth          meta.replySinceId
//   topic    community phrasing that never names Jack   meta.topicSinceId
//   thread   self-replies under a post that had no link (derived, no bookmark)
//
// What each post is mined for, in order:
//   1. its own links (entities, plus any t.co in the text that X left out of
//      entities, resolved by reading t.co's redirect, no API cost);
//   2. the links of a post it quotes or reposts, credited to that post's author;
//   3. "link in bio": the author's profile link, when the post says so;
//   4. otherwise, if it is a thread root, a later self-reply ("link in first
//      reply"), fetched in one batched search for the whole run.
//
// Every candidate gets a score and flags (coin, denylist, article, ...). They
// only rank and label: status is always "pending" and a human decides. The
// best MAX_NEW_PER_RUN by score are added, at most MAX_NEW_PER_AUTHOR each.
// ---------------------------------------------------------------------------

export const X_API = 'https://api.x.com/2';

// The collection's own surfaces, explorers, link shorteners and X itself.
// OpenSea is handled by path below: a derivative's collection page is a
// project, a single item or a profile is not.
export const HOST_BLOCKLIST = new Set([
  'x.com',
  'twitter.com',
  't.co',
  'jack.art',
  'etherscan.io',
  'blur.io',
  'magiceden.io',
  'foundation.app',
  'mooch.agency',
]);

// OpenSea collection slugs that are the real thing, not a community project.
const OPENSEA_OWN_SLUGS = new Set(['credits']);

// Hosts that are almost never a Credits project: memecoin launchpads and
// charts, chat invites, music and video uploads. Flagged and ranked low, never
// dropped, so a real project hiding behind one still reaches review.
export const DENY_HOSTS = new Set([
  'pump.fun',
  'dexscreener.com',
  'dextools.io',
  'birdeye.so',
  'gmgn.ai',
  'photon-sol.tinyastro.io',
  'bullx.io',
  'axiom.trade',
  'jup.ag',
  'raydium.io',
  'four.meme',
  'zora.co',
  't.me',
  'telegram.me',
  'discord.gg',
  'discord.com',
  'suno.com',
  'youtube.com',
  'youtu.be',
  'soundcloud.com',
  'open.spotify.com',
  'tiktok.com',
  'instagram.com',
]);

// Writing about Credits rather than something built on it.
const ARTICLE_HOSTS = ['medium.com', 'substack.com', 'mirror.xyz', 'paragraph.xyz', 'paragraph.com', 'hackmd.io'];
const ARTICLE_PATH_RE = /\/(blog|article|articles|news|post|posts|p)\//i;

// Link aggregators: the real link is one hop further, so worth a look but
// never the project itself.
const AGGREGATOR_HOSTS = new Set(['linktr.ee', 'bio.link', 'beacons.ai', 'lnk.bio']);

// Shorteners resolved before classifying (t.co is resolved separately).
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 'cutt.ly', 'rb.gy', 'is.gd', 'shorturl.at', 'ow.ly', 'buff.ly']);

// A hint only: cashtags, contract addresses and launch talk.
const COIN_RE =
  /(\$[A-Za-z][A-Za-z0-9]{1,9}\b|\bCA\s*:|\b0x[a-fA-F0-9]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|\bmcap\b|market ?cap|memecoin|\bpump(ing)?\b|presale|\b100x\b|\bape in\b|\bto the moon\b)/i;
const CREDITS_RE = /\bcredits?\b|jack ?butcher|@jackbutcher|\bstatements?\b/i;
const LINK_IN_BIO_RE = /link (is )?in (my |the )?(bio|profile)|\bbio link\b/i;
const TCO_RE = /https?:\/\/t\.co\/[A-Za-z0-9]+/g;

export const MAX_NEW_PER_RUN = 15;
export const MAX_NEW_PER_AUTHOR = 3;
export const THREAD_MAX_CONVERSATIONS = 8;
export const TCO_MAX_RESOLVE = 20;

const SOURCE_BASE_SCORE = { replies: 2, search: 1, topic: 1 };

// Hosts many unrelated projects share, where "same host" says nothing.
const SHARED_HOSTS = new Set(['opensea.io', 'github.com', 'gitlab.com']);

// A sub page of a site already in the index (a builder linking /life or
// /browse/all of their own tool) is usually not a new project, though now and
// then it is (Credit Scanner sits next to Creditizer), so it only costs a point.
export function knownHostOf(url, knownUrls) {
  const host = hostOf(url);
  if (!host || SHARED_HOSTS.has(host)) return false;
  for (const k of knownUrls) if (hostOf(k) === host) return true;
  return false;
}

// --- urls ----------------------------------------------------------------------

// Dedupe key: same project announced with and without a trailing slash, or
// with tracking query params bolted on, is still the same project. OpenSea
// collection tabs (/overview, /activity, ...) fold into the collection.
export function normaliseUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.search = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    if (u.hostname === 'opensea.io') {
      const m = u.pathname.match(/^\/collection\/([^/]+)/i);
      if (m) u.pathname = `/collection/${m[1].toLowerCase()}`;
    }
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

export function hostOf(normalised) {
  try {
    return new URL(normalised).hostname;
  } catch {
    return null;
  }
}

function hostIn(host, list) {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

// Is this URL something the index could ever list? Null when not.
export function acceptableUrl(normalised) {
  const host = hostOf(normalised);
  if (!host || HOST_BLOCKLIST.has(host)) return false;
  if (host === 'opensea.io') {
    const m = new URL(normalised).pathname.match(/^\/collection\/([^/]+)$/);
    return Boolean(m && !OPENSEA_OWN_SLUGS.has(m[1]));
  }
  return true;
}

export function isShortener(host) {
  return SHORTENERS.has(host);
}

// --- scoring -------------------------------------------------------------------

export function assess({ url, text = '', source, likes = 0, via, knownHost = false }) {
  const host = hostOf(url) || '';
  const flags = [];
  if (hostIn(host, [...DENY_HOSTS])) flags.push('denylist');
  if (hostIn(host, ARTICLE_HOSTS) || ARTICLE_PATH_RE.test(new URL(url).pathname)) flags.push('article');
  if (AGGREGATOR_HOSTS.has(host)) flags.push('aggregator');
  if (COIN_RE.test(text)) flags.push('coin');
  if (knownHost) flags.push('known-host');
  if (via && via !== 'post') flags.push(`via-${via}`);

  let score = SOURCE_BASE_SCORE[source] ?? 0;
  if (CREDITS_RE.test(text)) score += 1;
  if (flags.includes('denylist')) score -= 3;
  if (flags.includes('article')) score -= 2;
  if (flags.includes('coin')) score -= 2;
  if (flags.includes('aggregator')) score -= 1;
  if (knownHost) score -= 1;
  score += Math.min(2, Math.floor(Math.log10((likes || 0) + 1)));
  return { flags, score };
}

// --- tweets --------------------------------------------------------------------

// Links X parsed into entities, preferring the unwound (post-redirect) URL.
export function entityLinks(tweet) {
  return ((tweet.entities && tweet.entities.urls) || [])
    .map((u) => ({ tco: u.url, raw: u.unwound_url || u.expanded_url || null }))
    .filter((u) => u.raw || u.tco);
}

// t.co links in the text that entities does not account for.
export function strayTcoLinks(tweet) {
  const known = new Set(((tweet.entities && tweet.entities.urls) || []).map((u) => u.url));
  return [...new Set((tweet.text || '').match(TCO_RE) || [])].filter((t) => !known.has(t));
}

export function mentionsLinkInBio(text) {
  return LINK_IN_BIO_RE.test(text || '');
}

export function refOf(tweet, type) {
  const r = (tweet.referenced_tweets || []).find((x) => x.type === type);
  return r ? r.id : null;
}

// Keep the best candidates: highest score first, then most liked, then oldest
// post (the first announcement wins), capped per author and per run.
export function pickCandidates(cands, { maxRun = MAX_NEW_PER_RUN, maxAuthor = MAX_NEW_PER_AUTHOR } = {}) {
  const sorted = [...cands].sort(
    (a, b) => b.score - a.score || b.likes - a.likes || (BigInt(a.tweetId) < BigInt(b.tweetId) ? -1 : 1),
  );
  const perAuthor = new Map();
  const kept = [];
  const dropped = [];
  for (const c of sorted) {
    const key = (c.handle || '').toLowerCase();
    const n = perAuthor.get(key) || 0;
    if (kept.length >= maxRun || n >= maxAuthor) {
      dropped.push(c);
      continue;
    }
    perAuthor.set(key, n + 1);
    kept.push(c);
  }
  return { kept, dropped };
}
