// TEMPORARY: one-off backtest of the community-phrasing search. Removed
// before merge. Reads X, writes nothing.
//
// Runs the real discover() over a copy of data/creditcards.json, with the
// main and reply searches answered empty (no reads, no cost) and the topic
// search widened to the last 7 days at up to 100 posts.
import { readFileSync } from 'node:fs';
import { discover } from '../../scripts/creditcards-update.mjs';

const token = process.env.X_BEARER_TOKEN;
if (!token) throw new Error('no X_BEARER_TOKEN');
const data = JSON.parse(readFileSync(new URL('../../data/creditcards.json', import.meta.url), 'utf8'));
const empty = () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [], meta: { result_count: 0 } }) });
const start = new Date(Date.now() - 7 * 86_400_000 + 120_000).toISOString();
let reads = 0;

const fetchImpl = async (url, opts) => {
  if (!url.startsWith('https://api.x.com/2/tweets/search/recent')) return fetch(url, opts);
  const u = new URL(url);
  const q = u.searchParams.get('query');
  if (q.includes('jackbutcher') || q.includes('to:jesusdoteth')) return empty();
  if (q.includes('"80 credits"')) {
    u.searchParams.delete('since_id');
    u.searchParams.set('start_time', start);
    u.searchParams.set('max_results', '100');
    u.searchParams.set('sort_order', 'recency');
  }
  const res = await fetch(u, opts);
  const body = await res.json().catch(() => ({}));
  if (q.includes('"80 credits"')) {
    const users = new Map(((body.includes && body.includes.users) || []).map((x) => [x.id, x.username]));
    const posts = body.data || [];
    reads += posts.length;
    console.log(`\n=== topic search since ${start}: ${posts.length} post(s)${body.meta && body.meta.next_token ? ' (more than 100: truncated)' : ''}, status ${res.status}`);
    if (!res.ok) console.log(JSON.stringify(body));
    for (const t of posts) {
      const links = ((t.entities && t.entities.urls) || []).map((l) => l.unwound_url || l.expanded_url).filter((l) => l && !/x\.com|twitter\.com/.test(l));
      console.log(`--- ${t.created_at} @${users.get(t.author_id)} ♥${t.public_metrics ? t.public_metrics.like_count : 0} https://x.com/i/status/${t.id}`);
      console.log(`    ${(t.text || '').replace(/\s+/g, ' ').slice(0, 220)}`);
      if (links.length) console.log(`    links: ${links.join(' ')}`);
    }
    console.log('');
  } else {
    console.log(`(thread lookup: ${(body.data || []).length} repl(ies))`);
  }
  return { ok: res.ok, status: res.status, headers: res.headers, json: async () => body };
};

await discover(data, token, fetchImpl, console.log, console.error);
console.log(`\nposts read: ${reads}, approx cost $${(reads * 0.005).toFixed(2)}. Nothing written.`);
