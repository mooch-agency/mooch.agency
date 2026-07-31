// Build the head-to-head table: pipeline vs the websearch method, per site.
//
// Reads run records straight out of scripts/runs/ so the table can never drift
// from the runs it claims to describe. Weight and the thin-report floor are copied
// from report/render-report.mjs (5/3/2/1, floor 3) so a "REPORT vs good-shape"
// verdict here means the same thing it means in the product.
//
// Usage: node websearch-compare.mjs <pipeline-tag> <armA-tag> [armB-tag]
//   e.g. node websearch-compare.mjs goal A B

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUNS = fileURLToPath(new URL('./runs/', import.meta.url));

const SITES = [
  ['apexvolumetrics', 'apexvolumetrics.com'],
  ['lisbon', 'lisbon.amplify.eu'],
  ['sambleinnovations', 'sambleinnovations.com'],
  ['propstrata', 'propstrata.com'],
  ['r3p', 'r3p.xyz'],
  ['jackpotter', 'jackpotter.com'],
];

const WEIGHT = { critical: 5, high: 3, medium: 2, low: 1 };
const THIN_FLOOR = 3;

function load(name) {
  const p = `${RUNS}${name}`;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Pipeline tags are `<slug>_pipe_r<tag>` but the tag suffix varies per site
// (goal-apex, goal-amplify2, ...), so match on the prefix rather than guessing.
function findPipeline(slug, tag) {
  const hit = readdirSync(RUNS).filter(f =>
    f.startsWith(`${slug}_pipe_r${tag}`) && f.endsWith('.json'));
  if (!hit.length) return null;
  // Newest wins when a site was re-run under the same tag prefix.
  hit.sort();
  return load(hit[hit.length - 1]);
}

// Only gate-passed findings count, in both methods. A finding the gate dropped
// never reaches the client, so counting it would flatter whichever method
// hallucinates more.
function passed(rec) {
  const fs_ = rec.findings || [];
  return fs_.filter(f => (f.gate ? f.gate === 'pass' : true));
}

function score(rec) {
  if (!rec) return null;
  const kept = passed(rec);
  const weight = kept.reduce((n, f) => n + (WEIGHT[String(f.severity).toLowerCase()] || 1), 0);
  const severe = kept.some(f => ['critical', 'high'].includes(String(f.severity).toLowerCase()));
  const broken = kept.some(f => /broken|link|404/i.test(`${f.type || ''}${f.category || ''}`));
  // The honesty gate: a coverage failure means the run cannot claim a clean site.
  const unread = (rec.coverage?.notes || []).length > 0
    || /could not|couldn't|unreadable|failed to load|bot|challenge/i.test(rec.judge_log?.coverage || '');
  const verdict = severe || weight >= THIN_FLOOR || broken
    ? 'REPORT'
    : unread ? 'INCONCLUSIVE' : 'good-shape';
  const secs = rec.timing?.total_s ?? Math.round((rec.timing?.total_ms ?? 0) / 1000);
  return {
    n: kept.length,
    claimed: rec.n_claimed ?? (rec.findings || []).length,
    weight,
    verdict,
    gateFail: rec.gate_fail ?? 0,
    secs,
    pages: (rec.picker?.pages_used || rec.rendered_urls || []).length || null,
    severities: kept.map(f => String(f.severity).toLowerCase()),
  };
}

const [pipeTag = 'goal', aTag = 'A', bTag = 'B', cTag = 'C'] = process.argv.slice(2);

// Arm tag -> filename infix, set by websearch-audit.mjs: '' plain, 'r' render,
// 's' render + settle-aware reader + stability gate.
const ARMS = [
  ['Pipeline (picker+puppeteer+judge)', 'pipe'],
  ['A: WebFetch only', 'a'],
  ['B: +render pass', 'b'],
  ['C: +settled reader, stability gate', 'c'],
];

const rows = SITES.map(([slug, host]) => ({
  host,
  pipe: score(findPipeline(slug, pipeTag)),
  a: score(load(`${slug}_ws_r${aTag}.json`)),
  b: score(load(`${slug}_wsr_r${bTag}.json`)),
  c: score(load(`${slug}_wss_r${cTag}.json`)),
}));

const cell = (s) => s ? `${s.verdict} · ${s.n} (w${s.weight}) · ${s.secs}s` : '—';

const cols = ['Site', ...ARMS.map(([l]) => l)];
console.log(`| ${cols.join(' | ')} |`);
console.log(`|${cols.map(() => '---').join('|')}|`);
for (const r of rows) console.log(`| ${[r.host, ...ARMS.map(([, k]) => cell(r[k]))].join(' | ')} |`);

// Median runtime, not mean: one bot-blocked site that burns the full timeout would
// otherwise define the average and hide the typical run.
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
console.log('\n| Arm | Sites run | Findings shipped | Total weight | REPORT verdicts | Quotes dropped by gate | Median runtime |');
console.log('|---|---|---|---|---|---|---|');
for (const [label, key] of ARMS) {
  const ss = rows.map(r => r[key]).filter(Boolean);
  if (!ss.length) continue;
  console.log(`| ${label} | ${ss.length} | ${ss.reduce((n, s) => n + s.n, 0)} | ${ss.reduce((n, s) => n + s.weight, 0)} | ${ss.filter(s => s.verdict === 'REPORT').length} | ${ss.reduce((n, s) => n + s.gateFail, 0)} | ${median(ss.map(s => s.secs))}s |`);
}

console.log('\n<!-- per-site severities shipped -->');
for (const r of rows) {
  console.log(`${r.host}: ` + ARMS.map(([l, k]) => `${l.split(':')[0]}[${r[k] ? (r[k].severities.join(',') || 'none') : '—'}]`).join(' '));
}
