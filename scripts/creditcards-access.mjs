// ---------------------------------------------------------------------------
// creditcards-access.mjs: what it takes to try a project on /creditcards.
//
// The question a holder asks straight after "is this for me?": can I just
// open it, or do I need a wallet, or money? One field per project,
// `access`, shown as the Access column in the list view and sortable there.
// One list, in "easiest first" order, shared by the bake (labels, sort
// order), check-site (every approved project needs a valid value) and
// discovery (a suggested value on each new pending entry, so approving one
// stays a single status flip).
// ---------------------------------------------------------------------------

export const ACCESS = [
  { slug: 'none', label: 'No wallet needed' },
  { slug: 'optional', label: 'Wallet optional' },
  { slug: 'wallet', label: 'Wallet needed' },
  { slug: 'paid', label: 'Costs money' },
];

export const ACCESS_SLUGS = ACCESS.map((a) => a.slug);

// Approved entries without a valid access value, as readable problems. Empty
// array means the data is good. Pending and rejected entries are not checked:
// a suggestion is only a suggestion until a human approves it.
export function accessProblems(projects) {
  return projects
    .filter((p) => p.status === 'approved' && !ACCESS_SLUGS.includes(p.access))
    .map(
      (p) =>
        `"${p.name}" (${p.id}) is approved but has ${p.access === undefined ? 'no access' : `access "${p.access}"`}; use one of ${ACCESS_SLUGS.join(', ')}`,
    );
}

// --- suggestion ------------------------------------------------------------------
//
// A keyword guess from the blurb and post text. The strongest signal wins, in
// this order: money mentioned, then a wallet required, then a wallet
// optional, else nothing to connect. It only saves a step at review time; a
// human still checks it when approving.
const PAID_RE = /\b\d*\.?\d+\s?eth\b|\$\d|\bpaid\b|\breal money\b|\bprice[ds]?\b|\bbuy\b|\bpresale\b/i;
const WALLET_RE = /\bwallet (needed|connected|required)\b|\bconnect (your )?wallet\b|\bwallet to mint\b|\bmint\b|\bclaim\b|\bholders? only\b/i;
const OPTIONAL_RE = /\bwallet optional\b|\boptional wallet\b/i;
const NONE_RE = /\bno wallet\b|\bnothing to connect\b|\bfree\b/i;

export function suggestAccess({ blurb = '', tweetText = '', url = '' } = {}) {
  const text = `${blurb} ${tweetText}`;
  if (OPTIONAL_RE.test(text)) return 'optional';
  if (NONE_RE.test(blurb)) return 'none';
  if (PAID_RE.test(text)) return 'paid';
  if (WALLET_RE.test(text) || /^https:\/\/opensea\.io\/collection\//.test(url)) return 'wallet';
  return 'none';
}
