#!/usr/bin/env node
// ---------------------------------------------------------------------------
// axbeat-data.mjs: bakes the AXBeat board data into axbeat.html.
//
// AXBeat publishes Cloudflare's agent-readiness level for the top 22 L2s, one
// website host and one docs host each. The scan itself lives in the private
// `ax-audit` repo; this script is the only bridge between the two, and it runs
// on a machine that has both, never in CI.
//
//   pnpm axbeat:build [../ax-audit]   read the scan, rebuild the baked block
//   pnpm axbeat:check                 verify what is baked (no scan needed)
//
// Why a sibling clone and not a token
// -----------------------------------
// The obvious alternative is a read-only GitHub token so CI can pull the scan
// itself. We do not, for the same reason `skills:sync` takes a path to a local
// clone: a token in CI turns every build into a live dependency on a private
// repo, and the data would then change under a deploy nobody reviewed. Baking
// the numbers into the page and committing them makes a scan update an explicit,
// reviewable diff, keeps production builds hermetic, and means no credential
// exists to leak. `--check` runs everywhere and fails on a malformed or
// internally inconsistent block, so CI still guards the data without reading it.
//
// What "holds publication" means
// ------------------------------
// Cloudflare answers a check with pass, fail, neutral or unableToCheck.
// `unableToCheck` is not a finding: it means the scan could not reach an answer,
// so that host's level is a floor rather than a result. A held row, or a host
// that failed to scan at all, stops the build. We ship a week-stale board over a
// row we cannot stand behind. This mirrors ax-audit's own gate (bin/gate.mjs);
// it is restated rather than imported because this repo must build without the
// other one present.
//
// What derives the levels
// -----------------------
// Nothing here scores anything. The level on every row is Cloudflare's, verbatim.
// The one thing we compute is what each level appears to REQUIRE, and it is
// derived from the scanned hosts: a level's gate is every check passed by 100%
// of hosts at or above it.
//
// Cloudflare's own `nextLevel.requirements` must never derive a score, a level
// or a gate. Its entries carry a `prompt` and a `skillUrl`, which makes it a
// list of suggested fixes for a coding agent rather than the gate, and on this
// data it is demonstrably not the gate: it names Link headers for INTMAX's 1/5,
// yet every host sitting at 1/5 fails Link headers. That reasoning is why the
// gates above are derived and it still stands.
//
// Quoting it is a different act and is allowed. The board prints Cloudflare's
// requirement descriptions verbatim on the next rung pip, attributed to them,
// as their advice about one host. Nothing reads those strings back into a
// level, a gate or an ordering.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'axbeat.html');
const OVERLAY = path.join(__dirname, 'axbeat-chains.json');

// The baked block sits between these, so the builder can replace the data
// without touching a line of the page around it.
const OPEN = '<script type="application/json" id="scan">';
const CLOSE = '</script>';

// The no-JavaScript rendering of the board, generated from the same data and
// written between these markers. See the comment above them in axbeat.html.
const STATIC_OPEN = '<!-- @AXBEAT-STATIC@ -->';
const STATIC_CLOSE = '<!-- @/AXBEAT-STATIC@ -->';

// Cloudflare runs these but never scores them, so they are excluded from gate
// derivation. They stay in the baked data: the method notes count them, and
// counting them from the data is what stops that sentence going stale.
const COMMERCE = new Set(['x402', 'mpp', 'ucp', 'acp', 'ap2']);

// The builders the board names, and the whole test for being on this list: the
// tool has a documented, default mechanism for the checks Cloudflare scores, so
// its presence can move a score with nobody configuring anything. GitBook is the
// clearest case on the current scan: all five GitBook hosts pass both Content
// Signals and Markdown negotiation, and all five sit on exactly 3/5.
//
// A framework that merely builds the pages (Next.js, Gatsby, Nuxt, Sanity,
// Contentful) is deliberately absent: it publishes none of these files on its
// own, so naming it would suggest a cause that is not operating. Those rows read
// "Custom", which is the honest answer: somebody's own setup.
//
// Order matters only as a tiebreak if a host somehow reports two builders; the
// first match wins.
const BUILDERS = [
  'Docusaurus', 'GitBook', 'MkDocs', 'Mintlify', 'VitePress',
  'Nextra', 'Docsify', 'Sphinx', 'Read the Docs', 'Redocly', 'Framer Sites',
];

// Hosting and CDN names, used for one thing only: showing that Cloudflare being
// detected on a host does not mean Cloudflare serves it. See the platform note.
const HOSTS = ['Vercel', 'Netlify', 'Amazon Web Services', 'Firebase', 'Google Cloud'];

const ARGV = process.argv.slice(2);
const CHECK = ARGV.includes('--check');
const scanArg = ARGV.find((a) => !a.startsWith('-'));

const die = (msg) => { console.error(`axbeat-data: ${msg}`); process.exit(1); };

// ---------------------------------------------------------------------------
// Reading the scan
// ---------------------------------------------------------------------------

// Accepts either the ax-audit checkout or the results file itself, so the common
// call is `pnpm axbeat:build ../ax-audit`.
function resolveScan(arg) {
  const given = arg ? path.resolve(ROOT, arg) : path.resolve(ROOT, '..', 'ax-audit');
  if (!existsSync(given)) return null;
  if (given.endsWith('.json')) return given;
  const latest = path.join(given, 'results', 'l2-top22-latest.json');
  return existsSync(latest) ? latest : null;
}

// The scan records the targets file it ran against; that file is the authority
// on which host belongs to which brand and in what rank order. Resolved relative
// to the ax-audit checkout (results/ sits one level under it).
function readTargets(scanPath, scan) {
  const auditRoot = path.resolve(path.dirname(scanPath), '..');
  const rel = scan.targetsFile || 'targets/l2-top22.json';
  const file = path.join(auditRoot, rel);
  if (!existsSync(file)) die(`scan names ${rel} but it is not at ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Cloudflare's checks arrive nested by category; the board addresses them by
// key (every key is unique across categories), but keeps the category too, so
// the page can group by Cloudflare's own taxonomy instead of inventing one.
// Flattened to four fields: status, message, the address actually requested,
// and the category key.
function flattenChecks(agentReadiness) {
  const out = {};
  for (const [category, byKey] of Object.entries(agentReadiness.checks || {})) {
    for (const [key, check] of Object.entries(byKey || {})) {
      // The first evidence entry is what the scanner did first: a fetch carries
      // the URL it asked for, a parse carries only its own label ("Extract
      // Sitemap directives from robots.txt"). Either way it is the honest answer
      // to "where did you look", which is what the row shows.
      const first = (check.evidence || [])[0] || {};
      out[key] = {
        s: check.status,
        m: check.message,
        a: first.request?.url || first.label || null,
        c: category,
      };
    }
  }
  return out;
}

// The publication gate, mirroring ax-audit/bin/gate.mjs. See the header note.
function heldReason(row) {
  if (row.error) return `scan failed: ${row.error}`;
  const unable = [];
  for (const [category, byKey] of Object.entries(row.agentReadiness?.checks || {})) {
    for (const [key, check] of Object.entries(byKey || {})) {
      if (check?.status === 'unableToCheck') unable.push(`${category}.${key}`);
    }
  }
  if (unable.length) return `unableToCheck on ${unable.join(', ')}`;
  if (!row.agentReadiness) return 'no agentReadiness block';
  return null;
}

// Cloudflare's `platform` is Wappalyzer's flat list of everything it recognised
// on the host, analytics tags and all: 13 entries for one site is normal. The
// board needs two things out of it, and neither is "the list".
//
//   builder   the tool that builds the pages, when it is one that ships these
//             files by default (see BUILDERS). Otherwise null, shown as "Custom".
//   cloudflare / otherHost
//             whether Cloudflare was detected, and whether another hosting
//             provider was detected alongside it. Both are facts about the
//             detection, never a claim about who serves the host: on this scan
//             Cloudflare is detected on 25 of the 44 hosts and 15 of those also
//             report Vercel, Netlify, AWS, Firebase or Google Cloud. That is why
//             the board has no host column and the method note says so.
//
// `detected` keeps Cloudflare's full string, so nothing is lost and any future
// reading of it starts from the original.
function platformFrom(raw) {
  const apps = String(raw || '').split(', ').map((a) => a.trim()).filter(Boolean);
  return {
    builder: BUILDERS.find((b) => apps.includes(b)) || null,
    cloudflare: apps.includes('Cloudflare'),
    otherHost: apps.some((a) => HOSTS.includes(a)),
    detected: raw || '',
  };
}

function hostFrom(row) {
  const ar = row.agentReadiness;
  return {
    // The host as a reader types it, not as the scanner submitted it.
    url: row.url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    level: ar.level,
    levelName: ar.levelName,
    platform: platformFrom(row.platform),
    scannedAt: row.scannedAt,
    reportUrl: row.reportUrl,
    checks: flattenChecks(ar),
    next: nextFrom(ar),
  };
}

// Cloudflare's own guidance for the one rung above this host, quoted not derived.
// Only the target, its name and which checks it names are kept per host: the
// descriptions themselves go in a single lookup (see reqTextFrom), because they
// are constant per check across all 44 hosts and repeating them 83 times cost
// 8.1KB against 0.6KB for the table. `prompt` and `shortPrompt` are deliberately
// left behind: `prompt` alone added 20KB of multi line shell and config examples
// that no reader can use inside a pip, and `skillUrl` is an instruction to an
// agent rather than something to show a person.
// A host at 5/5 has no nextLevel, and gets null rather than an invented one.
function nextFrom(ar) {
  const nl = ar.nextLevel;
  if (!nl) return null;
  return { t: nl.target, n: nl.name, r: nl.requirements.map((q) => q.check) };
}

// One description per check, proven rather than assumed: if Cloudflare ever
// words the same requirement differently for two hosts, the lookup would show
// one host another host's text, so the build stops instead.
function reqTextFrom(results) {
  const out = {};
  for (const row of results) {
    const reqs = row.agentReadiness?.nextLevel?.requirements ?? [];
    for (const q of reqs) {
      if (out[q.check] !== undefined && out[q.check] !== q.description) {
        die(`Cloudflare words the ${q.check} requirement differently on different hosts, so it cannot be baked once. Bake it per host instead.`);
      }
      out[q.check] = q.description;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derived gates. See the header note on why Cloudflare's nextLevel is not used.
// ---------------------------------------------------------------------------
function deriveGates(hosts) {
  const keys = [...new Set(hosts.flatMap((h) => Object.keys(h.checks)))].filter((k) => !COMMERCE.has(k));
  const gates = {};
  for (let lv = 1; lv <= 5; lv++) {
    const atOrAbove = hosts.filter((h) => h.level >= lv);
    // No host reached this level, so the data cannot say what it takes. Null,
    // not an empty list: "unknown" and "nothing required" are different claims.
    gates[lv] = atOrAbove.length
      ? keys.filter((k) => atOrAbove.every((h) => h.checks[k]?.s === 'pass'))
      : null;
  }
  return gates;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
function build(scanPath) {
  const scan = JSON.parse(readFileSync(scanPath, 'utf8'));
  const targets = readTargets(scanPath, scan);
  const overlay = JSON.parse(readFileSync(OVERLAY, 'utf8')).chains;

  if (!Array.isArray(scan.results) || !scan.results.length) die('scan has no results');
  if (scan.results.length !== targets.targets.length) {
    die(`scan has ${scan.results.length} rows but the targets file lists ${targets.targets.length}`);
  }

  // Hold the whole run on any row we cannot stand behind, and say which.
  const held = scan.results
    .map((row, i) => ({ label: row.label || targets.targets[i]?.label, why: heldReason(row) }))
    .filter((r) => r.why);
  if (held.length) {
    console.error(`axbeat-data: publication held, ${held.length} row(s) are not high confidence:`);
    for (const h of held) console.error(`  ${h.label}: ${h.why}`);
    console.error('Re-scan in ax-audit (bin/rescan.sh) and build again. The board stays as it is.');
    process.exit(2);
  }

  // Pair the two hosts of each brand by rank, in the targets file's own order,
  // which is L2Beat's value-secured ranking.
  const byBrand = new Map();
  scan.results.forEach((row, i) => {
    const t = targets.targets[i];
    if (!t) die(`scan row ${i} (${row.label}) has no matching target`);
    if (row.url !== t.url) die(`scan row ${i} is ${row.url} but the targets file expects ${t.url}`);
    const entry = byBrand.get(t.brand) || { brand: t.brand, tvs: t.rank };
    entry[t.role === 'apex' ? 'site' : 'docs'] = hostFrom(row);
    byBrand.set(t.brand, entry);
  });

  const rows = [...byBrand.values()]
    .sort((a, b) => a.tvs - b.tvs)
    .map((e) => {
      if (!e.site || !e.docs) die(`${e.brand} is missing its ${e.site ? 'docs' : 'apex'} host`);
      const ed = overlay[e.brand] || {};
      return {
        name: ed.name || e.brand,
        domain: e.site.url,
        tvs: e.tvs,
        note: ed.note || null,
        site: e.site,
        docs: e.docs,
      };
    });

  // A note left behind by an upstream rename would silently stop showing.
  const unknown = Object.keys(overlay).filter((b) => !byBrand.has(b));
  if (unknown.length) die(`scripts/axbeat-chains.json names brands not in the scan: ${unknown.join(', ')}`);

  const data = {
    scannedAt: scan.scannedAt,
    source: 'Cloudflare URL Scanner, agent readiness scan',
    gates: deriveGates(rows.flatMap((r) => [r.site, r.docs])),
    reqText: reqTextFrom(scan.results),
    rows,
  };
  return data;
}

// ---------------------------------------------------------------------------
// The static board: what a reader, a crawler or an agent gets with no
// JavaScript. Every score is present, so the page's own claim (that what you
// publish should be readable without ceremony) holds for the page itself.
//
// It reuses the interactive board's classes so it inherits the same type and
// rules rather than carrying a second stylesheet, and it is deliberately plain:
// no toggle, no disclosure, no form. Both scores sit on one row here, because
// without the Website/Docs switch there is nowhere else to put the second one.
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Fallback only. Every scanned host carries Cloudflare's own levelName and that
// is what renders; this fills a level nothing on the board reached.
const LEVEL_NAME = ['Not Ready', 'Basic Web Presence', 'Bot-Aware', 'Agent-Readable', 'Agent-Integrated', 'Agent-Native'];

function staticBoard(data) {
  // Pinned to UTC, because this string is baked into the file and then compared
  // byte for byte by --check. Without it the date follows the machine's zone, so
  // a scan landing after about 23:00 UTC would render one day here and a
  // different one in CI, and the check would fail on a page nobody had touched.
  const when = new Date(data.scannedAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  // Ranked the way the board opens: website score, ties broken on value secured.
  const list = [...data.rows].sort((a, b) => (b.site.level - a.site.level) || (a.tvs - b.tvs));

  return `<div class="pad">
<div>
<p class="eyebrowrow"><span class="eyebrow">AXBeat</span><span class="scanline"><span class="dot"></span>Scanned ${esc(when)}</span></p>
<h1 class="display">How <em>agent friendly</em> is your Layer 2?</h1>
<p class="lede">${data.rows.length} rollups, ranked on how well agents can read their website and docs.</p>
<p class="caveat">AX, agent experience, is how easily an AI agent can find and read what you publish. It is not a test of whether an agent can complete an onchain transaction. A chain can be excellent to build on and still be unreadable at the front door.</p>
<p class="caveat">Scores are <a href="https://blog.cloudflare.com/agent-readiness/" rel="noopener">Cloudflare’s agent-readiness</a> levels, republished unaltered, re-scanned weekly. Equal scores are ordered by value secured, per L2Beat.</p>
</div>
<div class="tablewrap"><table class="board">
<caption class="sr">The top ${data.rows.length} Layer 2 rollups by value secured, with their Cloudflare agent-readiness level out of 5 for their website and their docs, scanned ${esc(when)}.</caption>
<thead><tr><th scope="col">#</th><th scope="col">Chain</th><th scope="col">Website score</th><th scope="col">Docs score</th></tr></thead>
<tbody>
${list.map((r, i) => `<tr><td class="rank">${i + 1}</td>` +
  `<td><span class="brand">${esc(r.name)}</span><span class="brandurl">${esc(r.site.url)}</span></td>` +
  `<td><span class="snum">${r.site.level}/5</span> ${esc(r.site.levelName || LEVEL_NAME[r.site.level])}</td>` +
  `<td><span class="snum">${r.docs.level}/5</span> ${esc(r.docs.levelName || LEVEL_NAME[r.docs.level])}</td></tr>`).join('\n')}
</tbody></table></div>
</div>`;
}

// ---------------------------------------------------------------------------
// Checking what is already baked. Runs with no scan present, which is the point:
// CI has this repo and nothing else.
// ---------------------------------------------------------------------------
function readBaked() {
  if (!existsSync(PAGE)) die('axbeat.html does not exist');
  const html = readFileSync(PAGE, 'utf8');
  const start = html.indexOf(OPEN);
  if (start === -1) die('axbeat.html has no baked scan block');
  const from = start + OPEN.length;
  const end = html.indexOf(CLOSE, from);
  if (end === -1) die('the baked scan block is not closed');
  try {
    return { html, data: JSON.parse(html.slice(from, end)) };
  } catch (e) {
    return die(`the baked scan block is not valid JSON: ${e.message}`);
  }
}

function check() {
  const { html, data } = readBaked();
  const problems = [];
  const want = (cond, msg) => { if (!cond) problems.push(msg); };

  // The static board has to still be the board. Regenerating it from the baked
  // data and comparing is the only check that catches the failure that matters:
  // a page whose visible-without-JS scores no longer match the scores it ships.
  const sFrom = html.indexOf(STATIC_OPEN);
  const sTo = html.indexOf(STATIC_CLOSE);
  if (sFrom === -1 || sTo === -1) {
    problems.push('the static-board markers are missing');
  } else if (Array.isArray(data.rows) && data.rows.length && data.rows.every((r) => r.site && r.docs)) {
    const have = html.slice(sFrom + STATIC_OPEN.length, sTo).trim();
    if (have !== staticBoard(data).trim()) {
      problems.push('the no-JavaScript board does not match the baked data: rebuild with pnpm axbeat:build');
    }
  }

  want(typeof data.scannedAt === 'string' && !Number.isNaN(Date.parse(data.scannedAt)),
    'scannedAt is missing or not a date');
  want(Array.isArray(data.rows) && data.rows.length > 0, 'no rows');

  for (const r of data.rows || []) {
    for (const view of ['site', 'docs']) {
      const h = r[view];
      if (!h) { problems.push(`${r.name}: no ${view} host`); continue; }
      want(Number.isInteger(h.level) && h.level >= 0 && h.level <= 5,
        `${r.name} ${view}: level ${h.level} is outside 0-5`);
      want(h.checks && Object.keys(h.checks).length > 0, `${r.name} ${view}: no checks`);
      // A held row must never have reached the page. This is the same gate as
      // the build, asserted against what actually shipped.
      const unable = Object.entries(h.checks || {}).filter(([, c]) => c.s === 'unableToCheck');
      want(unable.length === 0,
        `${r.name} ${view}: shipped with unableToCheck on ${unable.map(([k]) => k).join(', ')}`);
      want(typeof h.url === 'string' && h.url.length > 0, `${r.name} ${view}: no host`);
    }
  }

  // The gates must still be the ones this data implies. This catches a hand-edit
  // of either half, and a build that wrote rows without rewriting gates.
  if (Array.isArray(data.rows) && data.rows.length && data.rows.every((r) => r.site && r.docs)) {
    const expect = deriveGates(data.rows.flatMap((r) => [r.site, r.docs]));
    if (JSON.stringify(expect) !== JSON.stringify(data.gates || null)) {
      problems.push('gates do not match the levels in the baked rows: rebuild with pnpm axbeat:build');
    }
  }

  // Every count in the body derives from the data, but the meta description and
  // the share card are hand-written and cannot. The description at least says a
  // number out loud, so check it still matches. A re-scan that changes the field
  // size should not leave the search result claiming the old one.
  const desc = /<meta name="description" content="([^"]*)"/.exec(html);
  const claimed = desc && /\btop (\d+)\b/i.exec(desc[1]);
  if (claimed && Array.isArray(data.rows) && Number(claimed[1]) !== data.rows.length) {
    problems.push(
      `the meta description says "top ${claimed[1]}" but the board has ${data.rows.length} chains ` +
      '(update the description, the og:description, the twitter:description and the share card)'
    );
  }

  if (problems.length) {
    console.error(`axbeat-data --check: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`axbeat-data --check: ${data.rows.length} chains, scanned ${data.scannedAt.slice(0, 10)}, gates consistent. PASS`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
if (CHECK) {
  check();
} else {
  const scanPath = resolveScan(scanArg);
  if (!scanPath) {
    die(
      'no scan found. Pass the ax-audit checkout, e.g. pnpm axbeat:build ../ax-audit\n' +
      '  (clone github.com/mooch-agency/ax-audit next to this repo, and `git pull` it first:\n' +
      '   the weekly scan commits straight to main, so a stale clone rebuilds a stale board)'
    );
  }
  const data = build(scanPath);
  const { html } = readBaked();

  // The static board first, so the offsets of the data block are still valid
  // when we splice it. Both are written in one pass: a page carrying a new scan
  // with last week's static table would be worse than either alone.
  const sFrom = html.indexOf(STATIC_OPEN);
  const sTo = html.indexOf(STATIC_CLOSE);
  if (sFrom === -1 || sTo === -1) die('axbeat.html has no static-board markers');
  const withStatic =
    html.slice(0, sFrom + STATIC_OPEN.length) + '\n' + staticBoard(data) + '\n' + html.slice(sTo);

  const start = withStatic.indexOf(OPEN) + OPEN.length;
  const end = withStatic.indexOf(CLOSE, start);
  writeFileSync(PAGE, withStatic.slice(0, start) + JSON.stringify(data) + withStatic.slice(end));
  const levels = data.rows.flatMap((r) => [r.site.level, r.docs.level]);
  console.log(
    `axbeat-data: baked ${data.rows.length} chains (${levels.length} hosts) from ${path.relative(ROOT, scanPath)}\n` +
    `  scanned ${data.scannedAt.slice(0, 10)}, levels ${Math.min(...levels)}-${Math.max(...levels)}, ` +
    `gates derived for ${Object.values(data.gates).filter(Boolean).length} of 5 levels`
  );
}
