// Run the websearch method over a site list, one at a time, and never lose a run
// to one bad site.
//
// Sequential on purpose. The 31 Jul benchmark note: ten runs against apexvolumetrics
// in one night got us bot-blocked by that origin, and the resulting "homepage
// unreadable" was self-inflicted rather than evidence about the method. Concurrency
// buys wall clock and costs the thing the run exists to measure.
//
// Usage: node websearch-batch.mjs <tag-suffix> [site ...]
//        (no sites -> the benchmark + inbound set below)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./websearch-audit.mjs', import.meta.url));

// Benchmark set from benchmark/2026-07-30-baseline.md, plus jackpotter.com, the
// one row in the Notion Inbound Audit Leads DB that the baseline never covered.
const DEFAULT_SITES = [
  'https://apexvolumetrics.com/',
  'https://lisbon.amplify.eu/',
  'https://sambleinnovations.com/',
  'https://propstrata.com/',
  'https://r3p.xyz/',
  'https://jackpotter.com/',
];

const [suffix = 'batch', ...rest] = process.argv.slice(2);
const sites = rest.length ? rest : DEFAULT_SITES;

const results = [];
for (const site of sites) {
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const c = spawn('node', [RUNNER, site, suffix], { stdio: ['ignore', 'inherit', 'inherit'] });
    c.on('exit', resolve);
    c.on('error', () => resolve(-1));
  });
  results.push({ site, code, ms: Date.now() - t0 });
  if (code !== 0) console.error(`[batch] ${site} FAILED (exit ${code}) - continuing`);
}

console.error('\n[batch] done');
for (const r of results) console.error(`  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${(r.ms / 1000).toFixed(0)}s  ${r.site}`);
