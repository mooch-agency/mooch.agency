// ---------------------------------------------------------------------------
// creditcards-perks.mjs: the Perks view on /creditcards.
//
// A perk is something a builder offers to Credits holders: an airdrop, an
// allowlist spot, a free mint, a discount, early access or a gated tool. The
// list lives in data/creditcards.json (perks[]) and is written by a human,
// never by discovery: every entry is checked against the builder's own post
// first. Ended perks stay listed on purpose, so the page shows how much a
// holder could have picked up by coming back.
//
// One module, shared by the bake (cards, the Perks pill and its count) and
// check-site (every perk needs the required fields), like
// creditcards-categories.mjs.
//
// Perk fields (perks[]):
//   id            stable slug, unique, seeds the card's grid mark
//   project       the project's real name, as its own post or page gives it
//   x             the builder's X handle, no @
//   type          one of PERK_TYPES below
//   eligibility   who can claim it, short ("Credits holders", "Top 2,000 holders")
//   description   one plain line for the card, no dashes
//   url           the project's site or mint page
//   post          the builder's post that states the perk (x.com/<handle>/status/<id>)
//   start, end    optional, YYYY-MM-DD (UTC)
//   ended         optional, a short reason ("Sold out") when a perk is over
//                 before, or without, a stated end date
//   checked       optional, YYYY-MM-DD the post was last read by a human
//
// Status is never stored: the bake works it out for the day it runs (UTC), so
// the twice-daily job flips a perk to Ended on its own once its end date
// passes. See perkStatus().
// ---------------------------------------------------------------------------

export const PERK_TYPES = [
  { slug: 'airdrop', label: 'Airdrop' },
  { slug: 'allowlist', label: 'Allowlist' },
  { slug: 'free-mint', label: 'Free mint' },
  { slug: 'discount', label: 'Discount' },
  { slug: 'early-access', label: 'Early access' },
  { slug: 'gated-tool', label: 'Gated tool' },
];

export const PERK_TYPE_SLUGS = PERK_TYPES.map((t) => t.slug);
export const PERK_STATUSES = ['open', 'ended', 'unknown'];
export const PERK_REQUIRED = ['id', 'project', 'x', 'type', 'eligibility', 'description', 'url', 'post'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POST_RE = /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const DASH_RE = /[—–]|\s-\s/;

const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// open: a stated end date that hasn't passed yet (and, if a start is given,
// it has started). ended: an "ended" reason, or an end date before today.
// unknown: anything else, which is most perks: builders rarely give an end.
export function perkStatus(perk, today = todayUtc()) {
  if (perk.ended) return 'ended';
  if (perk.end && perk.end < today) return 'ended';
  if (perk.end && (!perk.start || perk.start <= today)) return 'open';
  return 'unknown';
}

// Open first, then unknown, then ended; newest start first inside each; then
// by name. A pure function of the data and the day, so the bake stays stable.
export function sortPerks(perks, today = todayUtc()) {
  const rank = { open: 0, unknown: 1, ended: 2 };
  return perks
    .map((p) => ({ p, s: perkStatus(p, today) }))
    .sort((a, b) => rank[a.s] - rank[b.s] || (b.p.start || '').localeCompare(a.p.start || '') || a.p.project.localeCompare(b.p.project))
    .map(({ p }) => p);
}

// Problems with the perks list, as readable strings. Empty array means the
// data is good. A missing perks array is fine (the view just doesn't render).
export function perkProblems(perks) {
  if (perks === undefined) return [];
  if (!Array.isArray(perks)) return ['perks must be an array'];
  const out = [];
  const seen = new Set();
  perks.forEach((p, i) => {
    const who = `perk ${p && p.id ? `"${p.id}"` : `#${i + 1}`}`;
    if (!p || typeof p !== 'object') {
      out.push(`${who} is not an object`);
      return;
    }
    for (const f of PERK_REQUIRED) {
      if (typeof p[f] !== 'string' || !p[f].trim()) out.push(`${who} has no ${f}`);
    }
    if (p.id) {
      if (seen.has(p.id)) out.push(`${who} is listed twice`);
      seen.add(p.id);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id)) out.push(`${who}: id must be a lowercase slug`);
    }
    if (p.type && !PERK_TYPE_SLUGS.includes(p.type)) out.push(`${who} has type "${p.type}"; use one of ${PERK_TYPE_SLUGS.join(', ')}`);
    if (p.x && !HANDLE_RE.test(p.x)) out.push(`${who}: x must be a bare X handle, no @`);
    if (p.post && !POST_RE.test(p.post)) out.push(`${who}: post must be an https://x.com/<handle>/status/<id> link`);
    if (p.url && !/^https:\/\/[^\s]+$/.test(p.url)) out.push(`${who}: url must be an https link`);
    for (const f of ['start', 'end', 'checked']) {
      if (p[f] !== undefined && !(typeof p[f] === 'string' && validDate(p[f]))) out.push(`${who}: ${f} must be a YYYY-MM-DD date`);
    }
    if (p.start && p.end && validDate(p.start) && validDate(p.end) && p.end < p.start) out.push(`${who} ends before it starts`);
    if (p.ended !== undefined && (typeof p.ended !== 'string' || !p.ended.trim())) out.push(`${who}: ended must be a short reason, like "Sold out"`);
    if (p.status !== undefined) out.push(`${who} has a status field; status is worked out at bake time, remove it`);
    for (const f of ['project', 'eligibility', 'description', 'ended']) {
      if (typeof p[f] === 'string' && DASH_RE.test(p[f])) out.push(`${who}: ${f} has a dash (house style: no dashes)`);
    }
  });
  return out;
}
