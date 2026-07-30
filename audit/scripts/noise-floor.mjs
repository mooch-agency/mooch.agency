// Noise floor: how much does the judge vary run-to-run on IDENTICAL evidence?
//
// Why this exists. On 30 Jul the Section A prune (see
// benchmark/2026-07-30-baseline.md) moved the output on every site, which looked
// like proof the "pure duplicate" instructions mattered. It was not: re-running
// the SAME prompt against the SAME pinned pages moved the output just as much.
// A single run per arm cannot detect a prompt effect smaller than the run-to-run
// spread, so every prompt experiment needs this number first.
//
// Usage:
//   node scripts/noise-floor.mjs <tag-prefix> [n]
//   node scripts/noise-floor.mjs noise 5
//
// Reads scripts/runs/*_pipe_r<prefix>-<i>.json and reports which findings recur.
//
// The unit that matters is the STABLE SET: findings appearing in every run. That
// is what a prompt change should be measured against, not a single run's output.
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const RUNS = fileURLToPath(new URL('./runs/', import.meta.url));
const [prefix = 'noise', nArg] = process.argv.slice(2);

const files = readdirSync(RUNS)
  .filter(f => f.endsWith('.json') && /_pipe_r/.test(f))
  .filter(f => new RegExp(`_pipe_r${prefix}-\\d+\\.json$`).test(f))
  .sort((a, b) => (+a.match(/-(\d+)\.json$/)[1]) - (+b.match(/-(\d+)\.json$/)[1]));

if (!files.length) { console.error(`no runs matching *_pipe_r${prefix}-N.json in ${RUNS}`); process.exit(2); }
const n = nArg ? +nArg : files.length;

// Findings are matched on normalised (category + quote), NOT on `issue`. The
// judge rewrites its prose every run - "8 Session-a-Month should be plural" vs
// "the label drops the s" - so string-comparing `issue` reports 0% overlap even
// when the two runs found the identical defect. The quote is copied verbatim
// from the page and is stable; it is the only reliable identity key we have.
const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s€%]/g, '').trim();
const key = f => `${f.category}|${norm(f.quote).slice(0, 60)}`;

const runs = files.slice(0, n).map(f => {
  const d = JSON.parse(readFileSync(RUNS + f, 'utf8'));
  return {
    file: f,
    pages: d.picker?.pages_used?.length ?? 0,
    kept: d.gate_pass ?? 0,
    gated: d.gate_fail ?? 0,
    findings: (d.findings || []),
    rejected: (d.judge_log?.rejected || []),
  };
});

// Sanity: a noise floor over different page sets measures the picker, not the
// judge. Refuse to report a number that would be misread as judge variance.
const pageSets = new Set(runs.map(r => r.pages));
if (pageSets.size > 1) {
  console.error(`REFUSING: runs read different page counts (${[...pageSets].join(', ')}).`);
  console.error('Pin with AUDIT_PIN_PAGES so only the judge varies, then re-run.');
  process.exit(3);
}

const seen = new Map();
runs.forEach((r, i) => r.findings.forEach(f => {
  const k = key(f);
  if (!seen.has(k)) seen.set(k, { runs: new Set(), sev: new Set(), gate: new Set(), sample: f });
  const e = seen.get(k);
  e.runs.add(i); e.sev.add(f.severity); e.gate.add(f.gate);
}));

const rows = [...seen.entries()].sort((a, b) => b[1].runs.size - a[1].runs.size);
const stable = rows.filter(([, v]) => v.runs.size === runs.length);
const volatile_ = rows.filter(([, v]) => v.runs.size < runs.length);
const once = rows.filter(([, v]) => v.runs.size === 1);

console.log(`\nNOISE FLOOR  ${runs[0].file.split('_pipe_r')[0]}  n=${runs.length}  pages=${runs[0].pages} (pinned, identical)\n`);
console.log('per-run kept/gated:', runs.map(r => `${r.kept}/${r.gated}`).join('  '));
console.log(`distinct findings across all runs: ${rows.length}`);
console.log(`stable (in all ${runs.length}): ${stable.length}`);
console.log(`volatile: ${volatile_.length}   appeared exactly once: ${once.length}`);

console.log('\n%-4s %-9s %s'.replace(/%-(\d+)s/g, (_, w) => ''.padEnd(0)), '');
console.log(['runs'.padEnd(6), 'sev'.padEnd(10), 'category'.padEnd(13), 'quote'].join(''));
for (const [, v] of rows) {
  const sev = [...v.sev].join('/');
  const flag = v.gate.has('fail') ? ' [gated]' : '';
  console.log(
    `${v.runs.size}/${runs.length}`.padEnd(6) +
    sev.padEnd(10) +
    (v.sample.category + flag).padEnd(13) +
    norm(v.sample.quote).slice(0, 58)
  );
}

// A finding that is `low` in one run and `medium` in another is the same
// instability expressed on the severity axis, and it matters more than it looks:
// severity feeds the weight sum that THIN_FLOOR_WEIGHT gates the whole report on.
const sevSplit = rows.filter(([, v]) => v.sev.size > 1);
if (sevSplit.length) {
  console.log(`\nseverity disagreed across runs on ${sevSplit.length} finding(s):`);
  sevSplit.forEach(([, v]) => console.log(`  ${[...v.sev].join(' vs ')}  ${norm(v.sample.quote).slice(0, 50)}`));
}

// Cross-check: something REJECTED in one run and FLAGGED in another is the
// sharpest form of this bug, and the one the ticket was opened over.
const rejWords = runs.flatMap((r, i) => r.rejected.map(t => ({ i, t: norm(t) })));
const flip = rows.filter(([, v]) => {
  const q = norm(v.sample.quote).split(' ').filter(w => w.length > 4).slice(0, 3);
  return q.length && rejWords.some(r => q.some(w => r.t.includes(w)));
});
if (flip.length) {
  console.log(`\nflagged in one run, REJECTED in another (${flip.length}):`);
  flip.forEach(([, v]) => console.log(`  ${v.runs.size}/${runs.length}  ${norm(v.sample.quote).slice(0, 50)}`));
}

const pct = (stable.length / Math.max(1, rows.length) * 100).toFixed(0);
console.log(`\n=> STABLE SET = ${stable.length} of ${rows.length} distinct findings (${pct}%).`);
console.log(`   Measure prompt changes against the stable set, not a single run.`);
console.log(`   A prompt effect smaller than ${volatile_.length} findings is not detectable at n=${runs.length}.\n`);
