// The websearch method: one headless `claude -p` audit, then the code gate.
//
// Shape:  claude -p (Sonnet 5, WebSearch + WebFetch ONLY) -> parse -> code gate -> record
//
// vs run-pipeline.mjs, which is:
//   picker LLM -> parallel puppeteer innerText fetch -> programmatic hard-404 pass
//   -> N judge calls -> consensus merge -> code gate
//
// Deliberately absent here: the picker model, puppeteer on the reading path, the
// link crawler, multi-pass consensus, the thin-report floor. The auditor picks its
// own pages, reads them itself, and checks its own links. The only code left is the
// gate, because the gate is the one part that cannot be done by the thing being
// checked: it re-reads every cited page in a real browser and drops any quote that
// is not in the rendered text.
//
// Usage:
//   node websearch-audit.mjs <site_url> <tag>
//
// Env:
//   WSA_MODEL     model for the auditor        (default claude-sonnet-5)
//   WSA_PAGES     page budget                  (default 5)
//   WSA_ADVISOR   1 -> run in advisor mode     (default off)
//   WSA_TIMEOUT   ms before the run is killed  (default 900000)
//   CHROME_PATH   passed through to the gate

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from './websearch-prompt.mjs';

const OUT = fileURLToPath(new URL('./runs/', import.meta.url));
const GATE = fileURLToPath(new URL('./code-gate.mjs', import.meta.url));
const GATE_STABLE = fileURLToPath(new URL('./code-gate-stable.mjs', import.meta.url));
const READER = fileURLToPath(new URL('./read-url.mjs', import.meta.url));
const READER_SETTLE = fileURLToPath(new URL('./render-read.mjs', import.meta.url));
mkdirSync(OUT, { recursive: true });

const [site, runId = '1'] = process.argv.slice(2);
if (!site || !/^https?:\/\//.test(site)) {
  console.error('usage: node websearch-audit.mjs <site_url> <tag>');
  process.exit(2);
}

const MODEL = process.env.WSA_MODEL || 'claude-sonnet-5';
const PAGES = Number(process.env.WSA_PAGES || 5);
const ADVISOR = process.env.WSA_ADVISOR === '1';
const RENDER = process.env.WSA_RENDER === '1';
// Arm C: the render arm with both diagnosed bugs fixed — a reader that waits for
// the page to stop moving, and a gate that captures twice so an animating value
// cannot be quoted at a client. Implies RENDER.
const STABLE = process.env.WSA_STABLE === '1';
const TIMEOUT = Number(process.env.WSA_TIMEOUT || 900_000);

// The exact string the agent is told to run and the exact prefix the permission
// layer will allow. They are built from one constant so they cannot drift: if the
// allowlist prefix stops matching the documented command, every render call is
// denied and the arm silently degrades into arm A.
const READ_BIN = STABLE ? READER_SETTLE : READER;
const RENDER_CMD = `node ${READ_BIN}`;
const USE_RENDER = RENDER || STABLE;

const slug = site.replace(/https?:\/\/(www\.)?/, '').split(/[/.]/)[0];
const tag = `${slug}_ws${STABLE ? 's' : USE_RENDER ? 'r' : ''}_r${runId}`;
const t0 = Date.now();

// ---------------------------------------------------------------- the auditor

// --tools is the enforcement; --allowedTools is only the permission grant. The
// mooch-content-audit skill's rule, learned the hard way: "tool list is
// enforcement, prompt is suggestion". Handing this agent a Bash or a scraper
// would silently turn it back into the pipeline.
function runAuditor(prompt) {
  // Arm A gets no shell at all, so bypassPermissions is safe: there is nothing
  // dangerous in the tool set to bypass. Arm B needs Bash for the renderer, so it
  // runs on the default permission mode with a single allowlisted prefix — under
  // -p an un-allowlisted call is denied outright rather than prompting, which is
  // the enforcement. bypassPermissions here would hand the auditor a real shell.
  const args = USE_RENDER
    ? [
        '-p',
        '--model', MODEL,
        '--tools', 'WebSearch,WebFetch,Bash',
        // Both spellings. The repo path contains a space, so the agent may or may
        // not quote it, and Bash permissions match on the literal command prefix.
        // One spelling would let a legitimate render call be denied, and a denied
        // render is indistinguishable on the record from a page that would not load.
        '--allowedTools', 'WebSearch', 'WebFetch', `Bash(${RENDER_CMD}:*)`, `Bash(node "${READER}":*)`,
        '--output-format', 'json',
      ]
    : [
        '-p',
        '--model', MODEL,
        '--tools', 'WebSearch,WebFetch',
        '--allowedTools', 'WebSearch', 'WebFetch',
        '--permission-mode', 'bypassPermissions',
        '--output-format', 'json',
      ];
  // Advisor: https://code.claude.com/docs/en/advisor . Not a mode — it attaches a
  // stronger second model that the auditor consults at decision points, which for
  // an audit means "is this finding real" and "am I done". `--advisor` takes a
  // model and is deliberately absent from `claude --help`. A Sonnet 5 main accepts
  // Fable, Opus, or Sonnet 5; Opus is the useful escalation.
  //
  // Two things that will bite: it is Anthropic-API only, and through an LLM gateway
  // (ANTHROPIC_BASE_URL is set on this machine) it works only if the gateway
  // forwards the request intact. It also exits with an error rather than degrading
  // quietly, which is what we want — a silent non-advisor run recorded as an
  // advisor run would be worse than a failure.
  if (ADVISOR) args.push('--advisor', process.env.WSA_ADVISOR_MODEL || 'opus');

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(USE_RENDER ? { READER_LOG: readerLog } : {}) },
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout after ${TIMEOUT}ms`)); }, TIMEOUT);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${err.slice(0, 400)}`));
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error(`claude -p output not JSON: ${out.slice(0, 200)}`)); }
    });
    child.stdin.end(prompt);
  });
}

// --------------------------------------------------------------- parsing

// Last fenced block of a given tag. Last, not first: the model quotes the output
// contract's own example blocks back at itself often enough that taking the first
// match hands you the template instead of the findings.
function lastFence(text, tag) {
  const re = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'g');
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

function parseOutput(text) {
  const rawFindings = lastFence(text, 'json');
  const rawSummary = lastFence(text, 'summary');

  let findings = [];
  let parseError = null;
  if (rawFindings) {
    try {
      const obj = JSON.parse(rawFindings);
      findings = Array.isArray(obj.findings) ? obj.findings : [];
    } catch (e) { parseError = `findings block did not parse: ${e.message}`; }
  } else {
    // No block at all reads exactly like a clean site. It is not one.
    parseError = 'no findings block in output';
  }

  let judgeLog = null;
  if (rawSummary) {
    try { judgeLog = JSON.parse(rawSummary); }
    catch (e) { judgeLog = { summary: `summary block did not parse: ${e.message}`, raw: rawSummary }; }
  }

  // The report is everything before the first fenced block we consumed.
  const cut = text.search(/```(summary|json)\s*\n/);
  const report = (cut === -1 ? text : text.slice(0, cut)).trim();

  return { findings, judgeLog, report, parseError };
}

// --------------------------------------------------------------- the code gate

// Contradictions carry two quotes on two pages; both sides get checked, so a
// finding is only whole if both halves survive.
function gateEntries(findings) {
  const entries = [];
  findings.forEach((f, i) => {
    if (f.url && f.quote) entries.push({ url: f.url, quote: f.quote, label: `${i}:a` });
    if (f.url2 && f.quote2) entries.push({ url: f.url2, quote: f.quote2, label: `${i}:b` });
    else if (f.quote2 && f.url) entries.push({ url: f.url, quote: f.quote2, label: `${i}:b` });
  });
  return entries;
}

function runGate(entries) {
  if (!entries.length) return Promise.resolve({ verdicts: {}, stdout: '' });
  const tmp = `${OUT}${tag}.gate-in.json`;
  writeFileSync(tmp, JSON.stringify({ findings: entries }, null, 2));
  return new Promise((resolve, reject) => {
    const child = spawn('node', [STABLE ? GATE_STABLE : GATE, tmp], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.on('error', reject);
    child.on('exit', () => {
      try { unlinkSync(tmp); } catch {}
      const verdicts = {};
      for (const line of out.split('\n')) {
        const m = line.match(/^(PASS|FAIL|UNVERIFIABLE)\s+\[([^\]]+)\]/);
        if (m) verdicts[m[2]] = m[1];
      }
      resolve({ verdicts, stdout: out });
    });
  });
}

// ---------------------------------------------------------------- run

const prompt = buildPrompt({ site, pages: PAGES, render: USE_RENDER, renderCmd: RENDER_CMD });
console.error(`[wsa] ${site} -> ${tag}  model=${MODEL} pages=${PAGES}${USE_RENDER ? " render" : ''}${ADVISOR ? ' advisor' : ''}`);

// Ground truth for the render pass: read-url.mjs appends every URL it is asked for.
// Self-reported coverage in the summary block is the auditor marking its own
// homework; this file is the receipt. An empty log on a render run means the
// second pass never happened, whatever the summary claims.
const readerLog = `${OUT}${tag}.reader-log.txt`;
if (USE_RENDER) { try { writeFileSync(readerLog, ''); } catch {} }

const tAudit0 = Date.now();
const res = await runAuditor(prompt);
const auditMs = Date.now() - tAudit0;

const text = res.result || '';
writeFileSync(`${OUT}${tag}.audit-raw.txt`, text);

const { findings, judgeLog, report, parseError } = parseOutput(text);
if (parseError) console.error(`[wsa] WARN ${parseError}`);
console.error(`[wsa] audit ${(auditMs / 1000).toFixed(1)}s, ${findings.length} findings claimed, ${res.num_turns} turns`);

const tGate0 = Date.now();
const { verdicts, stdout: gateOut } = await runGate(gateEntries(findings));
const gateMs = Date.now() - tGate0;

// A finding ships only if every quote it carries passes. UNVERIFIABLE (the page
// would not load for the gate) is not a fail — the gate could not look — but it is
// not a pass either, so it is held out of the report and surfaced separately.
const scored = findings.map((f, i) => {
  const a = verdicts[`${i}:a`] || 'MISSING';
  const b = (f.quote2 ? verdicts[`${i}:b`] : null);
  const all = [a, ...(b ? [b] : [])];
  // UNSTABLE is its own outcome, not a fail: the quote was really on the page in
  // one capture. But the value moved between two loads seconds apart, so it is a
  // counter, a ticker or a rotator, and a client report cannot stand on it. Held
  // out of the report, kept on the record, because it is the single most useful
  // signal this experiment produced.
  const gate = all.includes('FAIL') ? 'fail'
    : all.includes('UNSTABLE') ? 'unstable'
    : all.includes('UNVERIFIABLE') || all.includes('MISSING') ? 'unverifiable'
    : 'pass';
  return { ...f, gate };
});

const kept = scored.filter(f => f.gate === 'pass');
const WEIGHT = { critical: 5, high: 3, medium: 2, low: 1 };
const weight = kept.reduce((n, f) => n + (WEIGHT[String(f.severity).toLowerCase()] || 1), 0);

let renderedUrls = [];
if (USE_RENDER) {
  try { renderedUrls = readFileSync(readerLog, 'utf8').split('\n').filter(Boolean); } catch {}
  if (!renderedUrls.length) console.error('[wsa] WARN render arm but the reader log is empty: the second pass did not run');
}

const record = {
  tag,
  site,
  method: STABLE ? "websearch+render+stable" : USE_RENDER ? 'websearch+render' : 'websearch',
  model: MODEL,
  advisor: ADVISOR,
  render_pass: USE_RENDER,
  stable_gate: STABLE,
  rendered_urls: renderedUrls,
  pages_budget: PAGES,
  timing: { audit_ms: auditMs, gate_ms: gateMs, total_ms: Date.now() - t0 },
  cost: { audit_usd: res.total_cost_usd ?? 0 },
  usage: res.usage || null,
  turns: res.num_turns ?? null,
  parse_error: parseError,
  findings: scored,
  n_claimed: findings.length,
  n: kept.length,
  weight,
  gate_pass: kept.length,
  gate_fail: scored.filter(f => f.gate === 'fail').length,
  gate_unstable: scored.filter(f => f.gate === 'unstable').length,
  gate_unverifiable: scored.filter(f => f.gate === 'unverifiable').length,
  judge_log: judgeLog,
  gate_stdout: gateOut,
  report_md: report,
};

writeFileSync(`${OUT}${tag}.json`, JSON.stringify(record, null, 2));
console.error(`[wsa] ${tag}: ${kept.length}/${findings.length} kept (weight ${weight}), gate fail ${record.gate_fail}, unver ${record.gate_unverifiable}, ${(record.timing.total_ms / 1000).toFixed(1)}s total`);
console.log(JSON.stringify({ tag, n: kept.length, weight, gate_fail: record.gate_fail, total_ms: record.timing.total_ms }));
