// Offline checks for Credit Cards discovery: node --test scripts/
// A fake X API replays posts shaped like the real ones from 25 to 27 Sep 2026,
// including finds the old keyword search and link rules missed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptableUrl, assess, knownHostOf, normaliseUrl, pickCandidates, strayTcoLinks } from './creditcards-discover.mjs';
import { discover } from './creditcards-update.mjs';
import { CATEGORY_SLUGS, categoryProblems, suggestCategory } from './creditcards-categories.mjs';

const users = [
  { id: '1', username: 'devonfigures' },
  { id: '2', username: 'BB88888888888BB' },
  { id: '3', username: 'dealer1943' },
  { id: '4', username: 'bitecong' },
  { id: '5', username: 'builder', url: 'https://t.co/bio', entities: { url: { urls: [{ url: 'https://t.co/bio', expanded_url: 'https://bio-project.xyz/' }] } } },
];
const link = (u) => ({ url: `https://t.co/${u.length}`, expanded_url: u, unwound_url: u });

const searchTweets = [
  // Credit scanner: a plain post with its link in entities.
  { id: '2103877289788227649', conversation_id: '2103877289788227649', author_id: '1', text: "credit scanner\n\nscan any credit with your phone camera\n\nget a splayed 3d model, jack's official score", entities: { urls: [link('https://creditscores.vercel.app/scan/'), link('https://x.com/devonfigures/status/2103877289788227649/video/1')] } },
  // An OpenSea collection link, which the old blocklist dropped.
  { id: '2103520141158093001', conversation_id: '2103519962082193703', author_id: '2', text: '@jackbutcher https://t.co/6C82HiRCJu', referenced_tweets: [{ type: 'replied_to', id: '2103519962082193703' }], entities: { urls: [link('https://opensea.io/collection/not-an-artist-888/overview')] } },
  // Pour: video only, the link sits in the author's first reply.
  { id: '2103691502870553059', conversation_id: '2103691502870553059', author_id: '3', text: "This is a fun way to reimagine @jackbutcher 's credits as an acrylic pour", entities: { urls: [link('https://x.com/dealer1943/status/2103691502870553059/video/1')] } },
  // A memecoin: still pending, but flagged and ranked low.
  { id: '2103703567219773668', conversation_id: '2103703567219773668', author_id: '4', text: '🤖 AI Signal (SOL) $CREDIT CA: CXpCREMe9NYtQzJikaPKuVmXD58ZeCnVdiUjKyuEAP7a', entities: { urls: [link('https://pump.fun/coin/CXpCREMe9NYtQzJikaPKuVmXD58ZeCnVdiUjKyuEAP7a')] } },
  // Link in bio, and a t.co X left out of entities.
  { id: '2103700000000000001', conversation_id: '2103700000000000001', author_id: '5', text: 'made a credits toy, link in bio' },
  { id: '2103700000000000002', conversation_id: '2103700000000000002', author_id: '5', text: 'and another https://t.co/stray1' },
  // The Credits collection itself is not a project.
  { id: '2103700000000000003', conversation_id: '2103700000000000003', author_id: '5', text: 'sweep', entities: { urls: [link('https://opensea.io/collection/credits')] } },
];

function fakeX(calls) {
  return async (url, opts = {}) => {
    calls.push(url);
    const json = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
    if (url === 'https://t.co/stray1' && opts.redirect === 'manual') {
      return { ok: false, status: 301, headers: new Headers({ location: 'https://stray-project.app/?utm_source=x' }) };
    }
    const u = new URL(url);
    if (u.pathname === '/2/tweets/search/recent') {
      const q = u.searchParams.get('query');
      const since = u.searchParams.get('since_id');
      if (q.includes('jackbutcher') && !q.includes('conversation_id:')) {
        const fresh = searchTweets.filter((t) => !since || BigInt(t.id) > BigInt(since));
        const newest = fresh.reduce((m, t) => (!m || BigInt(t.id) > BigInt(m) ? t.id : m), null);
        return json({ data: fresh, includes: { users }, meta: newest ? { newest_id: newest, result_count: fresh.length } : { result_count: 0 } });
      }
      if (q.includes('conversation_id:2103691502870553059')) {
        return json({ data: [{ id: '2103691506142085501', conversation_id: '2103691502870553059', author_id: '3', text: 'https://t.co/HsELRcK1tq', entities: { urls: [link('https://pour-eight.vercel.app/')] } }], includes: { users } });
      }
      return json({ data: [], meta: { result_count: 0 } });
    }
    throw new Error(`unexpected ${url}`);
  };
}

test('threads, bio, t.co and OpenSea find what the old rules missed', async () => {
  const data = { meta: { sinceId: '1', replySinceId: '1' }, projects: [] };
  const calls = [];
  const lines = [];
  const added = await discover(data, 'token', fakeX(calls), (l) => lines.push(l), (l) => lines.push(l));
  const byUrl = Object.fromEntries(data.projects.map((p) => [p.url, p]));

  assert.ok(byUrl['https://creditscores.vercel.app/scan'], 'credit scanner');
  assert.ok(byUrl['https://opensea.io/collection/not-an-artist-888'], 'opensea collection');
  assert.equal(byUrl['https://pour-eight.vercel.app'].post, 'https://x.com/dealer1943/status/2103691502870553059', 'thread link credited to root');
  assert.equal(byUrl['https://pour-eight.vercel.app'].source, 'search+thread');
  assert.ok(byUrl['https://bio-project.xyz'], 'link in bio');
  assert.ok(byUrl['https://stray-project.app'], 't.co outside entities');
  assert.ok(!byUrl['https://opensea.io/collection/credits'], 'the collection itself');
  const pump = byUrl['https://pump.fun/coin/CXpCREMe9NYtQzJikaPKuVmXD58ZeCnVdiUjKyuEAP7a'];
  assert.equal(pump.status, 'pending');
  assert.deepEqual(pump.flags, ['denylist', 'coin']);
  assert.ok(pump.score < byUrl['https://creditscores.vercel.app/scan'].score);
  assert.equal(added, data.projects.length);
  assert.ok(data.projects.every((p) => CATEGORY_SLUGS.includes(p.category)), 'every pending entry carries a suggested category');
  assert.equal(pump.category, 'markets', 'a coin post suggests markets');
  assert.equal(byUrl['https://opensea.io/collection/not-an-artist-888'].category, 'markets', 'an OpenSea collection suggests markets');
  assert.equal(data.meta.sinceId, '2103877289788227649');
  assert.ok(!calls.some((c) => c.includes('/lists/') || c.includes('_lists')), 'no X List reads');
});

test('a post at or below sinceId is not read again', async () => {
  const data = { meta: { sinceId: '2103877289788227649', replySinceId: '1' }, projects: [] };
  await discover(data, 'token', fakeX([]), () => {}, () => {});
  assert.equal(data.projects.length, 0);
  assert.equal(data.meta.sinceId, '2103877289788227649');
});

test('known urls, in any form, are never re-added', async () => {
  const data = {
    meta: { sinceId: '1', replySinceId: '1' },
    projects: [{ url: 'https://opensea.io/collection/not-an-artist-888', status: 'rejected' }],
  };
  await discover(data, 'token', fakeX([]), () => {}, () => {});
  assert.equal(data.projects.filter((p) => p.url.includes('not-an-artist')).length, 1);
});

test('a failing source leaves its since-id alone and the rest still run', async () => {
  const data = { meta: { sinceId: '5', replySinceId: '6' }, projects: [] };
  const base = fakeX([]);
  const fetchImpl = async (url, opts) =>
    url.includes('to%3Ajesusdoteth')
      ? { ok: false, status: 429, headers: new Headers({ 'x-rate-limit-reset': '1790000000' }), json: async () => ({ title: 'Too Many Requests' }) }
      : base(url, opts);
  const errs = [];
  await discover(data, 'token', fetchImpl, () => {}, (l) => errs.push(l));
  assert.equal(data.meta.replySinceId, '6');
  assert.equal(data.meta.sinceId, '2103877289788227649');
  assert.ok(data.projects.length > 0, 'the main search still ran');
  assert.match(errs.join('\n'), /429 \(Too Many Requests\), rate limited until/);
});

test('helpers', () => {
  assert.equal(normaliseUrl('https://www.OpenSea.io/collection/CreditCards/overview?ref=1'), 'https://opensea.io/collection/creditcards');
  assert.equal(acceptableUrl('https://opensea.io/item/ethereum/0x1/3'), false);
  assert.equal(acceptableUrl('https://opensea.io/collection/creditmon'), true);
  assert.deepEqual(assess({ url: 'https://catalogue.gallery/blog/jack-butcher-credits', text: 'Credits', source: 'search' }).flags, ['article']);
  assert.deepEqual(assess({ url: 'https://suno.com/song/1', text: 'Made a little $JACKOFF anthem', source: 'search' }).flags, ['denylist', 'coin']);
  assert.deepEqual(strayTcoLinks({ text: 'a https://t.co/abc b https://t.co/def', entities: { urls: [{ url: 'https://t.co/abc' }] } }), ['https://t.co/def']);
  const many = Array.from({ length: 20 }, (_, i) => ({ url: `u${i}`, handle: i < 5 ? 'spam' : `h${i}`, score: 1, likes: 0, tweetId: String(100 + i) }));
  const { kept } = pickCandidates(many);
  assert.equal(kept.length, 15);
  assert.equal(kept.filter((c) => c.handle === 'spam').length, 3);
});

test('sub pages of a listed site are flagged, not dropped', () => {
  const known = new Set(['https://creditscheck.xyz', 'https://opensea.io/collection/creditcards']);
  assert.equal(knownHostOf('https://creditscheck.xyz/life', known), true);
  assert.equal(knownHostOf('https://opensea.io/collection/creditmon', known), false);
  const a = assess({ url: 'https://creditscheck.xyz/life', text: 'Credits', source: 'search', knownHost: true });
  assert.deepEqual(a.flags, ['known-host']);
});

test('category suggestions and the approved-entry check', () => {
  assert.equal(suggestCategory({ name: 'x.app', tweetText: 'Build your Statement: pick the 80 Credits you will burn' }), 'statements');
  assert.equal(suggestCategory({ name: 'x.app', tweetText: 'made a little game with credits, play the daily puzzle' }), 'games');
  assert.equal(suggestCategory({ name: 'x.app', tweetText: 'rarity ranks and live sales for every credit' }), 'rarity');
  assert.equal(suggestCategory({ name: 'x.app', tweetText: 'turn your credit into a 3d voxel remix' }), 'art');
  assert.equal(suggestCategory({ name: 'opensea.io', url: 'https://opensea.io/collection/foo', tweetText: 'gm' }), 'markets');
  assert.equal(suggestCategory({ name: 'x.app', tweetText: 'gm' }), 'art', 'no hit falls back to art');
  const ok = { id: 'a', name: 'A', status: 'approved', category: 'games' };
  assert.deepEqual(categoryProblems([ok, { id: 'p', name: 'P', status: 'pending' }]), []);
  assert.equal(categoryProblems([{ id: 'b', name: 'B', status: 'approved' }]).length, 1);
  assert.equal(categoryProblems([{ id: 'c', name: 'C', status: 'approved', category: 'misc' }]).length, 1);
});
