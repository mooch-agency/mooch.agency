// Multi-pass judging: turn the noise floor from a problem into an instrument.
//
// THE PROBLEM, measured. Running the same judge on the same bytes twice gives
// different answers: 14% of findings recur across n=5 on lisbon, 13% across n=4
// on r3p (benchmark/2026-07-30-baseline.md). The expensive case is not the noisy
// trivia, it is that r3p's BEST finding, "Nvidia's Jensen Huang called CTO when
// he is CEO" - a named factual error, checkable in ten seconds, exactly what
// makes a prospect pick up the phone - appeared in only 2 of 4 runs.
//
// THE IDEA. Recurrence across passes IS a confidence signal, and a measured one,
// unlike asking the judge to introspect about its own certainty. So: run the
// judge N times over the identical bundle, then use how often each finding
// recurred to decide what ships.
//
//   seen in >= 2 passes          -> corroborated, ships
//   seen once, high/critical     -> ships anyway (a wow-grade finding is worth
//                                   more than the FP risk; this is the whole
//                                   point of the exercise)
//   seen once, low/medium        -> judge log only, never the client
//
// That rule is deliberately asymmetric. Recall matters most exactly where the
// stakes are highest, and the near-zero-FP rule is best defended where the
// finding is marginal anyway. Union alone would inflate every thin report with
// one-off trivia; intersection alone would drop the Huang finding half the time.
//
// COST: N judge calls per audit, $0 marginal on the subscription engine, about
// +70s of wall clock per extra pass. Opt-in via AUDIT_JUDGE_PASSES so the
// default stays measured-and-unchanged until this is benchmarked.

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const rank = (s) => (s in SEVERITY_RANK ? SEVERITY_RANK[s] : 3);

// Same identity key as scripts/noise-floor.mjs, and for the same reason: the
// judge rewrites its `issue` prose every pass ("8 Session-a-Month should be
// plural" vs "the label drops the s"), so matching on issue text reports near-
// zero overlap even when two passes found the identical defect. The quote is
// copied verbatim off the page and is the only stable identity available.
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s€%]/g, '').trim();
export const findingKey = (f) => `${f.category}|${norm(f.quote).slice(0, 60)}`;

// A finding seen N times has N severities, which frequently disagree (the Huang
// error came back `medium` twice and `high` once). Take the MODE, breaking ties
// toward the more severe reading: if the judge saw it as high even once and
// nothing outvotes that, the client should hear the higher number.
function consensusSeverity(variants) {
  const counts = new Map();
  for (const v of variants) counts.set(v.severity, (counts.get(v.severity) || 0) + 1);
  let best = null;
  for (const [sevName, n] of counts) {
    if (!best || n > best.n || (n === best.n && rank(sevName) < rank(best.sevName))) {
      best = { sevName, n };
    }
  }
  return best ? best.sevName : 'low';
}

export function shipDecision({ passes, total, severity }) {
  if (total <= 1) return true; // single-pass runs behave exactly as before
  if (passes >= 2) return true;
  return rank(severity) <= rank('high'); // lone high/critical still ships
}

// passes: array of findings-arrays, one per judge pass, all over the SAME bundle.
// Returns { findings, dropped }: `findings` carry consensus severity plus
// `passes`/`pass_total`/`confidence`, `dropped` are the one-off low/medium calls
// that stay in the judge log.
export function mergePasses(passes) {
  const total = passes.length;
  const byKey = new Map();
  passes.forEach((findings, i) => {
    for (const f of findings || []) {
      const k = findingKey(f);
      if (!byKey.has(k)) byKey.set(k, { variants: [], seenIn: new Set() });
      const e = byKey.get(k);
      e.variants.push(f);
      e.seenIn.add(i);
    }
  });

  const findings = [];
  const dropped = [];
  for (const [, e] of byKey) {
    const n = e.seenIn.size;
    const severity = consensusSeverity(e.variants);
    // Keep the fullest-evidenced variant: a pass that supplied quote2/url2 gives
    // a reviewer more to check than one that did not.
    const best = [...e.variants].sort(
      (a, b) => (b.quote2 ? 1 : 0) - (a.quote2 ? 1 : 0) || (b.reasoning || '').length - (a.reasoning || '').length
    )[0];
    const merged = {
      ...best,
      severity,
      passes: n,
      pass_total: total,
      confidence: total <= 1 ? 'unmeasured' : n === total ? 'high' : n >= 2 ? 'medium' : 'low',
    };
    (shipDecision({ passes: n, total, severity }) ? findings : dropped).push(merged);
  }
  findings.sort((a, b) => rank(a.severity) - rank(b.severity) || b.passes - a.passes);
  return { findings, dropped };
}
