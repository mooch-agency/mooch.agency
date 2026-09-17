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
// Nothing. The level on every row is Cloudflare's, verbatim, and the opened row
// simply lists which scored checks passed and which did not, straight off the
// baked block. Two earlier designs died here and stay dead:
//
// A derived gate per level (every check passed by 100% of hosts at or above it)
// was retired 16 Sep: nothing scored 2/5, so gates 2 and 3 came out identical,
// and five scored checks landed in no gate at all. A derivation with holes that
// size looked more certain than it was.
//
// Quoting Cloudflare's `nextLevel.requirements` on a next-rung pip went with the
// pip ladder itself, so the field is no longer baked at all. The ban on it stays
// for any future revival: it is a list of suggested fixes for a coding agent,
// demonstrably not the gate on this data, and must never derive a score, a
// level or an ordering.
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

// What the board names in its "Built with" column, in two tiers, because the
// column now runs on both views and a website has no docs tool to name.
//
// DOC_TOOLS come first and win a tie. The test for being here is unchanged: the
// tool has a documented, default mechanism for the checks Cloudflare scores, so
// its presence can move a score with nobody configuring anything. GitBook is the
// clearest case on the current scan: all five GitBook hosts pass both Content
// Signals and Markdown negotiation, and all five sit on exactly 3/5.
//
// SITE_FRAMEWORKS were deliberately absent while this was a docs-only column,
// on the grounds that naming one would suggest a cause that is not operating.
// That reasoning still holds and the fix is in the copy, not the list: the
// column describes a stack, it never explains a score, and the method note
// says so with the numbers. Without them the website view reads "Custom" on 12
// of 22 rows, which tells a reader nothing at all.
//
// Order matters only as a tiebreak when a host reports two; the first match
// wins, which is why a Docusaurus site on Next.js still reads Docusaurus.
const DOC_TOOLS = [
  'Docusaurus', 'GitBook', 'MkDocs', 'Mintlify', 'VitePress',
  'Nextra', 'Docsify', 'Sphinx', 'Read the Docs', 'Redocly',
];
const SITE_FRAMEWORKS = [
  'Framer Sites', 'Next.js', 'Nuxt.js', 'Astro', 'SvelteKit', 'Remix',
  'Gatsby', 'Hugo', 'Jekyll', 'Eleventy', 'WordPress', 'Webflow', 'Squarespace',
  'Wix', 'Sanity', 'Contentful', 'Vue.js', 'React',
];
const BUILDERS = [...DOC_TOOLS, ...SITE_FRAMEWORKS];

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
// Flattened to five fields: status, message, the address actually requested,
// the category key, and the panel's own status value (see checkValueFrom).
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
        v: checkValueFrom(key, check),
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Panel status value: the short "200" / "absent" / "html only" shown beside
// each check name in the opened row's Found/Missing columns. Two families,
// matching how each check actually reaches its verdict:
//
//   HTTP_STATUS_KEYS  the verdict IS a fetch's response code, the resource is
//                      there or it isn't, so the panel shows that code
//                      straight off the scan's own evidence. Never invented:
//                      if a check named here carries no fetch evidence, the
//                      build dies rather than making one up.
//   WORD_RULES         the verdict comes from parsing what was fetched (or,
//                      for dnsAid, from a DNS-over-HTTPS lookup that always
//                      answers 200 whatever it finds, which would actively
//                      mislead as a "status"). These map Cloudflare's own
//                      message to one of a fixed, exhaustively-listed words,
//                      the same pattern as policyFromMessage above: a
//                      reworded message dies the build instead of a guess.
//
// Checks in neither family (the payment checks, and webBotAuth's neutral
// informational check) carry no panel value; scoredChecks() never shows them.
// ---------------------------------------------------------------------------
const HTTP_STATUS_KEYS = new Set([
  'robotsTxt', 'sitemap', 'apiCatalog', 'authMd', 'mcpServerCard',
  'a2aAgentCard', 'agentSkills', 'oauthDiscovery', 'oauthProtectedResource', 'ard',
]);

// Which path each check is actually asking for. A check's evidence is not
// only its own target: several of them fetch a page as context too, and the
// order is not stable across hosts. oauthProtectedResource is the clearest
// case on this scan: base.org and optimism.io record the context GET first
// and the well-known path second, while mantle.xyz and docs.arbitrum.io
// record them the other way round. Taking the first fetch, or the last one,
// therefore reports 200 for a check that 404d on some hosts and not others.
// Matching the path instead is the only reading that holds for all 44.
//
// Every key in HTTP_STATUS_KEYS has an entry, and the paths are the ones this
// scan actually requests. A check whose target path never appears in its own
// evidence stops the build rather than falling back to a fetch that answers a
// different question.
const TARGET_PATHS = {
  robotsTxt: /\/robots\.txt/i,
  sitemap: /sitemap/i,
  apiCatalog: /\/\.well-known\/api-catalog/i,
  authMd: /\/auth\.md/i,
  mcpServerCard: /\/\.well-known\/mcp/i,
  a2aAgentCard: /\/\.well-known\/agent-card/i,
  agentSkills: /\/\.well-known\/(agent-)?skills/i,
  oauthDiscovery: /openid-configuration|oauth-authorization-server/i,
  oauthProtectedResource: /\/\.well-known\/oauth-protected-resource/i,
  ard: /ai-catalog/i,
};

// The status shown is the one the check's own target answered with. Two things
// are filtered out before anything is chosen: DNS-over-HTTPS lookups, which
// answer 200 from the resolver whatever they find, and any fetch whose path is
// not what this check is looking for (see TARGET_PATHS).
// On a pass, a multi-candidate check (three MCP paths, two OAuth discovery
// paths) may not win on its first try, so the first 2xx is preferred. On a
// fail every candidate failed, so the first is as true as any and is the
// canonical location the check tried first.
function httpStatusFrom(key, check) {
  const wanted = TARGET_PATHS[key];
  const fetches = (check.evidence || []).filter((e) =>
    e.response && typeof e.response.status === 'number' &&
    !String(e.request?.url || '').includes('cloudflare-dns.com') &&
    (!wanted || wanted.test(String(e.request?.url || ''))));
  if (!fetches.length) return null;
  if (check.status === 'pass') {
    const ok = fetches.find((e) => e.response.status >= 200 && e.response.status < 300);
    if (ok) return String(ok.response.status);
  }
  return String(fetches[0].response.status);
}

// One array of [pattern, word] per WORD_RULES check, tested in order. Every
// message this scan is known to produce for that check is listed; anything
// else is unrecognised (see checkValueFrom) rather than defaulted.
const WORD_RULES = {
  robotsTxtAiRules: [
    [/^Found rules for AI bots/i, 'named'],
    [/^No AI-specific bot rules; wildcard rules apply/i, 'blanket'],
    [/^No AI-specific bot rules and no wildcard rules/i, 'absent'],
    [/^Cannot check AI rules without robots\.txt/i, 'absent'],
  ],
  contentSignals: [
    [/^Content Signals found in robots\.txt/i, 'present'],
    [/^No Content Signals found in robots\.txt/i, 'absent'],
    [/^Cannot check Content Signals without robots\.txt/i, 'n/a'],
  ],
  markdownNegotiation: [
    [/^Site supports Markdown for Agents/i, 'md'],
    [/^Site does not support Markdown for Agents/i, 'html only'],
  ],
  linkHeaders: [
    [/^Found agent-useful Link relations:/i, 'found'],
    [/^No Link headers found on target page/i, 'absent'],
    [/^Link headers present but no agent-useful relation types found/i, 'unhelpful'],
    [/^Target page returned status \d+/i, 'blocked'],
  ],
  dnsAid: [
    [/^DNS for AI Discovery \(DNS-AID\) discovery record found at/i, 'named'],
    [/^DNS for AI Discovery \(DNS-AID\) well-known entrypoint records not found/i, 'absent'],
    [/^DNS for AI Discovery \(DNS-AID\) records found, but DNSSEC was not validated/i, 'unverified'],
  ],
  webMcp: [
    [/^Found \d+ WebMCP tools/i, 'found'],
    [/^No WebMCP tools detected/i, 'absent'],
  ],
};

// Returns null on a message none of the rules for this key recognise, so the
// two callers (the build, and --check re-verifying the bake) can each react
// in their own way rather than carrying their own copy of the patterns.
function wordFrom(key, message) {
  for (const [re, word] of WORD_RULES[key] || []) {
    if (typeof message === 'string' && re.test(message)) return word;
  }
  return null;
}

// A failed check whose own target answered 2xx. The code is then not the
// reason it failed, and printing it in the Missing column reads as a pass:
// "robots.txt not found" beside a green-looking 200 is the exact opposite of
// what happened. Three sites here (Ink, Morph, Ethscriptions) answer 200 to
// every path, so on those every Missing row would have read 200.
// The failure itself is the value instead, in the message's own terms.
const FAIL_2XX_RULES = [
  [/returned HTML instead of/i, 'html'],
  [/^No .*(found|metadata)/i, 'absent'],
  [/not found/i, 'absent'],
  [/exists but/i, 'invalid'],
  [/appears invalid/i, 'invalid'],
];
function fail2xxWord(message) {
  for (const [re, word] of FAIL_2XX_RULES) {
    if (typeof message === 'string' && re.test(message)) return word;
  }
  return null;
}

function checkValueFrom(key, check) {
  if (HTTP_STATUS_KEYS.has(key)) {
    const v = httpStatusFrom(key, check);
    if (v === null) die(`${key}: no fetch of its own target path to read a status from`);
    if (check.status !== 'pass' && /^2/.test(v)) {
      const word = fail2xxWord(check.message);
      if (word === null) {
        die(`${key} failed with HTTP ${v}, and its message is not one the panel knows how to ` +
          `word, so it would print a passing-looking code under Missing: "${check.message}"`);
      }
      return word;
    }
    return v;
  }
  if (WORD_RULES[key]) {
    const v = wordFrom(key, check.message);
    if (v === null) die(`unrecognised ${key} message, so its panel value cannot be read: "${check.message}"`);
    return v;
  }
  return null;
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
    ai: aiPolicyFrom(ar.checks?.botAccessControl?.robotsTxtAiRules),
  };
}

// ---------------------------------------------------------------------------
// AI access policy: what a site's robots.txt says to AI crawlers specifically.
//
// Read off Cloudflare's robotsTxtAiRules check rather than parsed here, and
// derived at build time rather than in the page, so the page never has to
// match on a scanner's prose at runtime. The known message forms are listed
// exhaustively and an unrecognised one stops the build: a reworded message
// that silently fell through to "missing" would misreport a site as having no
// robots.txt at all.
//
//   explicit  robots.txt names AI crawlers (GPTBot, ClaudeBot and friends)
//   generic   robots.txt exists, but one blanket rule covers every crawler
//   missing   no robots.txt, or no rule that reaches a crawler at all
//
// The policy says which crawlers are addressed, never whether they are allowed:
// naming a bot to block it and naming it to welcome it both read as explicit,
// because that is as far as this check looks.
// ---------------------------------------------------------------------------
const AI_POLICIES = ['explicit', 'generic', 'missing'];

// The one mapping, shared by the build and by --check. Returns null on a message
// it does not know, so each caller can react in its own way rather than both
// carrying their own copy of these patterns: an earlier version had --check
// falling through to 'missing' on a message the build would have died on, which
// is the exact drift this file exists to catch.
function policyFromMessage(m) {
  if (typeof m !== 'string') return null;
  if (/^Found rules for AI bots/i.test(m)) return 'explicit';
  if (/^No AI-specific bot rules; wildcard rules apply/i.test(m)) return 'generic';
  if (/^No AI-specific bot rules and no wildcard rules/i.test(m)) return 'missing';
  if (/^Cannot check AI rules without robots\.txt/i.test(m)) return 'missing';
  return null;
}

function aiPolicyFrom(check) {
  // No check at all is a scan that never ran it, which is genuinely "missing".
  if (!check) return 'missing';
  const policy = policyFromMessage(check.message);
  if (policy) return policy;
  return die(`unrecognised robotsTxtAiRules message, so the AI access policy cannot be read: "${check.message}"`);
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
      if (!ed.logo) die(`${e.brand} has no logo in scripts/axbeat-chains.json`);
      return {
        name: ed.name || e.brand,
        domain: e.site.url,
        tvs: e.tvs,
        note: ed.note || null,
        logo: ed.logo,
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

// Mirrors scoredChecks()/score() in axbeat.html: the same payment-family
// exclusion and neutral filter, so the no-JS score text ("x/16") agrees with
// the interactive board's bar and the opened panel's "Found x/16" for every
// host, not just an approximation of them. Kept as a second copy rather than
// imported, the same as the held-publication check above: this file has to
// build standing alone, with nothing shared at runtime with the page it bakes.
const PAYMENT_KEYS = ['x402', 'mpp', 'ucp', 'acp', 'ap2'];
function scoredCount(view) {
  let found = 0;
  let total = 0;
  for (const [key, check] of Object.entries(view.checks || {})) {
    if (PAYMENT_KEYS.includes(key)) continue;
    if (check.s === 'neutral') continue;
    total += 1;
    if (check.s === 'pass') found += 1;
  }
  return { found, total };
}

function staticBoard(data) {
  // Pinned to UTC, because this string is baked into the file and then compared
  // byte for byte by --check. Without it the date follows the machine's zone, so
  // a scan landing after about 23:00 UTC would render one day here and a
  // different one in CI, and the check would fail on a page nobody had touched.
  const when = new Date(data.scannedAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  // Ranked the way the board opens: checks found on the website view, not
  // Cloudflare's level (see scoredCount above and axbeat.html's own sorted()):
  // the row shows a checks-found count, so it has to sort on that count or a
  // 4/16 could sit under a 3/16 with nothing on the page explaining why. Ties
  // broken on value secured.
  const list = [...data.rows].sort((a, b) => (scoredCount(b.site).found - scoredCount(a.site).found) || (a.tvs - b.tvs));

  // Kept in sync by hand with hero()'s own frontloaded copy in axbeat.html
  // (there is no JS here to share it with): eyebrow text, the lede, and the
  // one "how it works" fact (what the scan checks, and that onchain AX is a
  // separate, unshipped measure). hero() tucks that fact behind "How it
  // works"; a disclosure with no JS to open it would just be permanently
  // missing copy, so the no-JS page states it plainly and stops.
  return `<div class="pad pad-hero">
<div>
<p class="eyebrowrow"><span class="eyebrow">Agent Experience</span><span class="scanline"><span class="dot"></span>Scanned ${esc(when)}</span></p>
<h1 class="display">How <em>agent friendly</em> is your Layer 2?</h1>
<p class="lede">L2Beat ranks security. AXBeat ranks AX, agent experience, how well agents can read a protocol’s website and docs.</p>
<p class="caveat">We run <a href="https://blog.cloudflare.com/agent-readiness/" rel="noopener">Cloudflare’s agent-readiness</a> scan against a protocol’s website and docs. It checks that agent signposts exist, not whether they’re correct. Onchain AX, how well an agent can take onchain actions, is TBD.</p>
</div>
<div class="tablewrap"><table class="board">
<caption class="sr">The top ${data.rows.length} Layer 2 rollups by value secured, with how many of Cloudflare's scored agent-readiness checks each passed for their website and their docs, scanned ${esc(when)}.</caption>
<thead><tr><th scope="col">#</th><th scope="col">Chain</th><th scope="col">Website score</th><th scope="col">Docs score</th></tr></thead>
<tbody>
${list.map((r, i) => {
  const site = scoredCount(r.site);
  const docs = scoredCount(r.docs);
  return `<tr><td class="rank">${i + 1}</td>` +
    `<td><span class="chainname"><img class="chainlogo" src="${esc(r.logo)}" alt="" width="20" height="20" loading="lazy">` +
    `<span class="brand">${esc(r.name)}</span></span><span class="brandurl">${esc(r.site.url)}</span></td>` +
    `<td><span class="snum">${site.found}/${site.total}</span> ${esc(r.site.levelName || LEVEL_NAME[r.site.level])}</td>` +
    `<td><span class="snum">${docs.found}/${docs.total}</span> ${esc(r.docs.levelName || LEVEL_NAME[r.docs.level])}</td></tr>`;
}).join('\n')}
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

  // The AI access policy is derived at build time from a check message, so it is
  // the one baked field that could silently go stale against its own row. Both
  // halves are asserted: the value is one the column can render, and it still
  // agrees with the check it was read from.
  for (const r of data.rows || []) {
    for (const view of ['site', 'docs']) {
      const h = r[view];
      if (!h) continue;
      want(AI_POLICIES.includes(h.ai),
        `${r.name} ${view}: AI access policy "${h.ai}" is not one of ${AI_POLICIES.join(', ')}`);
      const m = h.checks?.robotsTxtAiRules?.m;
      if (typeof m !== 'string') continue;
      const expect = policyFromMessage(m);
      // Same verdict the build would reach, including its refusal to guess: a
      // message neither of them recognises is a failure here, not a default.
      want(expect !== null,
        `${r.name} ${view}: robotsTxtAiRules message is one neither the build nor this check recognises, ` +
        `so the AI access policy cannot be verified: "${m}"`);
      if (expect !== null) {
        want(h.ai === expect,
          `${r.name} ${view}: AI access policy is "${h.ai}" but the check message reads "${expect}"`);
      }
    }
  }

  // The panel's status value (checks[key].v) is derived the same way the AI
  // policy is, so it gets the same two-part check: it is a shape the panel can
  // print, and it still agrees with the message it was read from. The fetch
  // evidence itself is never baked, so an HTTP_STATUS_KEYS value cannot be
  // re-derived from the block; what can be asserted is the invariant that
  // matters, which is that a code never appears against a failed check. A
  // failed check carries the word its message implies instead, so that half
  // is re-derived in full.
  for (const r of data.rows || []) {
    for (const view of ['site', 'docs']) {
      const h = r[view];
      if (!h) continue;
      for (const [key, c] of Object.entries(h.checks || {})) {
        if (HTTP_STATUS_KEYS.has(key)) {
          if (c.s === 'pass') {
            want(/^2\d\d$/.test(c.v || ''),
              `${r.name} ${view} ${key}: check passed but its panel value "${c.v}" is not a 2xx status`);
          } else {
            // A failed check shows either the code that failed it, or, when
            // its own target answered 2xx, the word its message implies. It
            // must never show a 2xx code: that reads as a pass.
            const word = fail2xxWord(c.m);
            want(!/^2\d\d$/.test(c.v || ''),
              `${r.name} ${view} ${key}: check failed but its panel value "${c.v}" is a 2xx status, ` +
              'which reads as a pass under Missing');
            want(/^\d{3}$/.test(c.v || '') || (word !== null && c.v === word),
              `${r.name} ${view} ${key}: panel value "${c.v}" is neither a status code nor the word ` +
              `its message implies ("${word}"): "${c.m}"`);
          }
        } else if (WORD_RULES[key]) {
          const expect = wordFrom(key, c.m);
          want(expect !== null,
            `${r.name} ${view} ${key}: message is one neither the build nor this check recognises, ` +
            `so its panel value cannot be verified: "${c.m}"`);
          if (expect !== null) {
            want(c.v === expect,
              `${r.name} ${view} ${key}: panel value is "${c.v}" but the check message reads "${expect}"`);
          }
        }
      }
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
  console.log(`axbeat-data --check: ${data.rows.length} chains, scanned ${data.scannedAt.slice(0, 10)}, AI policies consistent. PASS`);
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
    `AI access policy read on ${data.rows.flatMap((r) => [r.site, r.docs]).filter((h) => h.ai).length} hosts`
  );
}
