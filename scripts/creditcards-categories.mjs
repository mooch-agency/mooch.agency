// ---------------------------------------------------------------------------
// creditcards-categories.mjs: the category filter on /creditcards.
//
// One list, in display order, shared by everything that touches it: the bake
// (pills, counts, data-category on each card), check-site (every approved
// project needs a valid category) and discovery (a suggested category on each
// new pending entry, so approving one is a single status flip).
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  { slug: 'rarity', label: 'Rarity & data' },
  { slug: 'art', label: 'Art & remixes' },
  { slug: 'statements', label: 'Build your Statement' },
  { slug: 'games', label: 'Games' },
  { slug: 'markets', label: 'Mints, tokens & markets' },
];

export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug);

// Approved entries without a valid category, as readable problems. Empty
// array means the data is good. Pending and rejected entries are not checked:
// a suggestion is only a suggestion until a human approves it.
export function categoryProblems(projects) {
  return projects
    .filter((p) => p.status === 'approved' && !CATEGORY_SLUGS.includes(p.category))
    .map(
      (p) =>
        `"${p.name}" (${p.id}) is approved but has ${p.category === undefined ? 'no category' : `category "${p.category}"`}; use one of ${CATEGORY_SLUGS.join(', ')}`,
    );
}

// --- suggestion ------------------------------------------------------------------
//
// A keyword guess for a new pending entry, from its name, url, blurb and post
// text. It only saves a step at review time: a human still reads the entry and
// can change the category before (or when) approving it. Weights are small
// integers; the highest total wins, ties go to the earlier rule below, and no
// hit at all falls back to "art", the broadest bucket.
const RULES = [
  ['statements', 3, /\bstatements?\b|\bburn(s|ed|ing)?\b|\bthe 80\b|\b80 (real )?credits\b|\byour 80\b/i],
  ['games', 3, /\bgames?\b|\bplay(able|ing)?\b|\bpuzzle\b|\bbreakout\b|\barcade\b|higher or lower|\bquiz\b|\bscramble\b|\bcube\b|\bdaily (8|eight|challenge)\b/i],
  ['markets', 2, /\bmint(s|ed|ing)?\b|\btokens?\b|\bmarket(s|place)?\b|\bprediction\b|\btrad(e|es|ing)\b|\bairdrop\b|\bpresale\b|\bcollection\b|\bsolana\b|\$[A-Za-z][A-Za-z0-9]{1,9}\b|\bstrategy\b/i],
  ['rarity', 2, /\brarity\b|\brarest\b|\brank(s|ed|ing|ings)?\b|\bratings?\b|\bscor(e|es|ed|ing)\b|\btraits?\b|\bmetadata\b|\bdashboard\b|\banalytics\b|\bstats\b|\bdata\b|\bholders?\b|\bsales\b|\blistings\b|\bchecker\b|\bscanner\b|\bmonitor\b|\blook ?up\b|\bexplorer\b/i],
  ['art', 2, /\bart(work)?\b|\bremix(es|ed)?\b|\b3d\b|\bvoxels?\b|\bmosaic\b|\bpaint(ing)?\b|\bcanvas\b|\bgenerat(e|or|ive)\b|\bcollage\b|\bfilm\b|\banimation\b|\bringtone\b|\bposter\b|\bprint\b|\bpng\b|\bsvg\b|\bwallpaper\b|\bimage\b|\brecolou?r(ed)?\b/i],
];

export function suggestCategory({ name = '', url = '', blurb = '', tweetText = '', flags = [] } = {}) {
  const text = `${name} ${blurb} ${tweetText}`;
  const score = Object.fromEntries(CATEGORY_SLUGS.map((s) => [s, 0]));
  for (const [slug, weight, re] of RULES) {
    const hits = text.match(new RegExp(re.source, 'gi'));
    if (hits) score[slug] += weight * Math.min(hits.length, 3);
  }
  // An OpenSea collection page or a coin-flagged post is almost always a mint
  // or a token, whatever the post says around it.
  if (/^https:\/\/opensea\.io\/collection\//.test(url)) score.markets += 3;
  if (flags.includes('coin')) score.markets += 2;
  let best = 'art';
  let top = 0;
  for (const [slug] of RULES) {
    if (score[slug] > top) {
      best = slug;
      top = score[slug];
    }
  }
  return best;
}
