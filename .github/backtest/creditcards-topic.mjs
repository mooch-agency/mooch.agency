// TEMPORARY: one-off backtest of the community-phrasing search. Removed
// before merge. Reads X, writes nothing.
//
// Runs the real discover() over a copy of data/creditcards.json, with the
// main and reply searches answered empty (no reads, no cost) and the topic
// search widened to every post in the last 7 days. BACKTEST_QUERY, when
// set, replaces the query, to compare variants.
import { readFileSync } from 'node:fs';
import { discover } from '../../scripts/creditcards-update.mjs';

const token = process.env.X_BEARER_TOKEN;
if (!token) throw new Error('no X_BEARER_TOKEN');
const data = JSON.parse(readFileSync(new URL('../../data/creditcards.json', import.meta.url), 'utf8'));
const empty = () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [], meta: { result_count: 0 } }) });
const start = new Date(Date.now() - 7 * 86_400_000 + 120_000).toISOString();
let reads = 0;

const OVERRIDE = process.env.BACKTEST_QUERY || '';
const MAX_PAGES = 8;
const isTopic = (q) => !q.includes('jackbutcher') && !q.includes('to:jesusdoteth') && !q.includes('conversation_id:');

const fetchImpl = async (url, opts) => {
  if (!url.startsWith('https://api.x.com/2/tweets/search/recent')) return fetch(url, opts);
  const u = new URL(url);
  const q = u.searchParams.get('query');
  if (!isTopic(q)) {
    if (q.includes('conversation_id:')) {
      const res = await fetch(u, opts);
      const body = await res.json().catch(() => ({}));
      console.log(`(thread lookup: ${(body.data || []).length} repl(ies))`);
      return { ok: res.ok, status: res.status, headers: res.headers, json: async () => body };
    }
    return empty();
  }
  if (OVERRIDE) u.searchParams.set('query', OVERRIDE);
  u.searchParams.delete('since_id');
  u.searchParams.set('start_time', start);
  u.searchParams.set('max_results', '100');
  u.searchParams.set('sort_order', 'recency');
  // Every page in the window, merged into one body as discover() expects.
  const merged = { data: [], includes: { users: [], tweets: [] }, meta: {} };
  let res;
  let pages = 0;
  for (;;) {
    res = await fetch(u, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`page ${pages + 1} failed ${res.status}: ${JSON.stringify(body)}`);
      break;
    }
    pages++;
    merged.data.push(...(body.data || []));
    merged.includes.users.push(...((body.includes && body.includes.users) || []));
    merged.includes.tweets.push(...((body.includes && body.includes.tweets) || []));
    if (!merged.meta.newest_id && body.meta) merged.meta.newest_id = body.meta.newest_id;
    const next = body.meta && body.meta.next_token;
    if (!next || pages >= MAX_PAGES) {
      if (next) console.log(`stopped at ${MAX_PAGES} pages, more remain`);
      break;
    }
    u.searchParams.set('next_token', next);
  }
  const posts = merged.data;
  reads += posts.length;
  const users = new Map(merged.includes.users.map((x) => [x.id, x.username]));
  const linkOf = (t) => ((t.entities && t.entities.urls) || []).map((l) => l.unwound_url || l.expanded_url).filter((l) => l && !/x\.com|twitter\.com/.test(l));
  const oldest = posts.length ? posts[posts.length - 1].created_at : '-';
  console.log(`\n=== query: ${u.searchParams.get('query')}`);
  console.log(`=== ${posts.length} post(s) in ${pages} page(s), oldest ${oldest}, window from ${start}`);
  const bot = posts.filter((t) => users.get(t.author_id) === 'vvcredits').length;
  const union = posts.filter((t) => /credit union pooling/i.test(t.text || '')).length;
  const linked = posts.filter((t) => linkOf(t).length).length;
  console.log(`=== breakdown: @vvcredits bot ${bot}, Credit Union template ${union}, with an external link ${linked}, other ${posts.length - bot - union}`);
  for (const t of posts) {
    const links = linkOf(t);
    if (!links.length) continue;
    console.log(`--- ${t.created_at} @${users.get(t.author_id)} https://x.com/i/status/${t.id}`);
    console.log(`    ${(t.text || '').replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log(`    links: ${links.join(' ')}`);
  }
  console.log('');
  return { ok: true, status: 200, headers: res.headers, json: async () => merged };
};

await discover(data, token, fetchImpl, console.log, console.error);
console.log(`\nposts read: ${reads}, approx cost $${(reads * 0.005).toFixed(2)}. Nothing written.`);
