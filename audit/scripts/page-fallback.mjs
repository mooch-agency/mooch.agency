// Thin-text / bot-block fallback for the page-fetch stage.
//
// Extracted from run-pipeline.mjs so it can be unit-tested without launching a
// browser or hitting the network: every function here takes an injected
// `fetchOne(url) -> page` so tests can hand it scripted pages.
//
// The contract, in one line: a picked page that stays unreadable after a longer
// settle is swapped for the next-priority unused internal link, and every swap
// (or unswappable skip) is written to a coverage note so the report discloses
// exactly what was read.

// A page is unusable if it errored, returned near-empty text, or shows a bot
// challenge instead of real content. These are the cases the fallback rescues.
export const THIN_CHARS = 200;
export const CHALLENGE =
  /verify (you are|you're) human|checking your browser|enable javascript to|access denied|are you a robot|captcha|cf-browser-verification|attention required/i;

// Always returns a boolean (p.error is a string, so coerce) since callers treat
// this as a predicate.
export function unusable(p) {
  return Boolean(!p || p.error || !p.text || p.text.length < THIN_CHARS || CHALLENGE.test(p.text.slice(0, 1500)));
}

// One retry with a longer settle: some pages are slow-hydrating SPAs or throw a
// transient interstitial that clears on a second, more patient load. If the retry
// is no better we keep the first result (it carries the original error text).
export async function fetchWithRetry(fetchOne, url, { settleMs = 2500 } = {}) {
  const first = await fetchOne(url);
  if (!unusable(first)) return first;
  await new Promise((r) => setTimeout(r, settleMs));
  const retry = await fetchOne(url);
  return unusable(retry) ? first : retry;
}

// Walk the fetched picks in order, swapping each unusable one for the next
// readable page in the fallback pool (already priority-ordered by the picker's
// link inventory). Sequential by design: only the rare unusable page pays the
// cost, the common case was fetched in parallel by the caller.
// Mutates `fallbackPool` (shift) so a swapped-in page is never reused.
export async function resolveWithSwaps({ initial, fallbackPool, fetchOne, settleMs }) {
  const good = [];
  const notes = [];
  for (const page of initial) {
    if (!unusable(page)) {
      good.push(page);
      continue;
    }
    let swapped = false;
    while (fallbackPool.length) {
      const alt = fallbackPool.shift();
      const altPage = await fetchWithRetry(fetchOne, alt, { settleMs });
      if (!unusable(altPage)) {
        good.push(altPage);
        notes.push(`${page.url} was unreadable (bot-block or empty); audited ${alt} instead`);
        swapped = true;
        break;
      }
    }
    if (!swapped) notes.push(`${page.url} was unreadable and no readable substitute was available`);
  }
  return { good, notes };
}
