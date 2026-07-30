// Link-status probing, extracted from run-pipeline.mjs so the error
// classification is unit-testable without the network (link-check.test.mjs).
//
// The rule (recall-gap ticket, item 3): ENOTFOUND is deterministic evidence the
// domain does not exist, so it is reportable, with one retry so a single
// resolver blip never becomes a client-facing claim. EAI_AGAIN, timeouts and
// every other failure stay a generic 'error': transient, logged in
// unreachable_not_reported, never shown. Before this split, the apexvolumetrics
// hero CTA (www.quiz.apexvolumetrics.com, NXDOMAIN) was caught as 'error' and
// silently filed as unreachable: the most certain broken link the pipeline can
// detect was the one class hard-coded invisible.

// What may appear in the client-facing broken-links list. Everything else is
// logged internally only. 403/429/5xx are often bot-blocks or blips; near-zero
// false positives is the rule.
export const REPORTABLE = new Set([404, 410, 'dead_domain']);

const dnsCode = (e) => e?.cause?.code === 'ENOTFOUND';

// fetchImpl is injectable for tests; production passes a fetch wrapper that
// carries the UA and timeout. Returns an HTTP status number, 'dead_domain'
// (ENOTFOUND twice), or 'error'. Memoised per URL, like the old inline version.
export function statusOfFactory(fetchImpl) {
  const cache = new Map();
  async function probe(u) {
    try {
      return (await fetchImpl(u)).status;
    } catch (e) {
      if (dnsCode(e)) {
        // Retry once: NXDOMAIN from a healthy resolver is stable, so a second
        // identical answer is confirmation, not coincidence.
        try {
          return (await fetchImpl(u)).status;
        } catch (e2) {
          return dnsCode(e2) ? 'dead_domain' : 'error';
        }
      }
      return 'error';
    }
  }
  return async function statusOf(u) {
    if (cache.has(u)) return cache.get(u);
    const s = await probe(u);
    cache.set(u, s);
    return s;
  };
}
