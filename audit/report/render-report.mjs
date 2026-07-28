// Renders a pipeline record (audit/scripts/run-pipeline.mjs output) into a
// self-contained, branded HTML report in the Mooch design system. The HTML is
// standalone (inline CSS, Google-font link) so puppeteer can PDF it and a cold
// forwarded reader needs no login (story 10).
//
// Report shape follows the base content-audit skill: one-line verdict, Worst
// Offenders table (worst first), findings grouped by severity with the VERBATIM
// quote as evidence (no Fix column), a Coverage appendix, and a warm closer page
// with a soft CTA to hey@ / the booking link (story 14). Only gate-passed findings
// are shown: the code gate already stripped anything not quotable verbatim.
//
// Thin-report floor (story 13): below a minimum finding weight, we render the
// "good shape" variant rather than padding a thin report.

const CONTACT_EMAIL = "hey@mooch.agency";
const BOOKING_URL = "https://cal.eu/mooch/discovery";
const SITE_URL = "https://mooch.agency";

// Severity weights drive both the worst-first sort and the thin-report floor.
const SEVERITY = {
  critical: { weight: 5, label: "Critical", rank: 0 },
  high: { weight: 3, label: "High", rank: 1 },
  medium: { weight: 2, label: "Medium", rank: 2 },
  low: { weight: 1, label: "Low", rank: 3 },
};
// Below this total weight, with no critical/high, send the good-shape variant.
const THIN_FLOOR_WEIGHT = 3;

// Human labels for the judge's category codes.
const CATEGORY_LABEL = {
  contradiction: "Cross-page contradiction",
  pricing: "Pricing inconsistency",
  naming: "Naming inconsistency",
  spelling: "Spelling / grammar",
  grammar: "Spelling / grammar",
  stale: "Stale content",
  formatting: "Formatting artifact",
  factual: "Factual error",
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Href allowlist. Report URLs come from the AUDITED (untrusted) site, and the
// report is cc'd to hey@, so a crafted `javascript:`/`data:` href would be a
// clickable XSS that esc() alone does not stop. Only http(s) and mailto survive;
// anything else collapses to "#". Returns an already-escaped, quote-safe value.
function safeHref(u) {
  const s = String(u == null ? "" : u).trim();
  return /^(https?:|mailto:)/i.test(s) ? esc(s) : "#";
}

function sev(f) {
  return SEVERITY[(f.severity || "low").toLowerCase()] || SEVERITY.low;
}

function hostOf(u) {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
}

function pathOf(u) {
  try {
    const p = new URL(u).pathname;
    return p === "/" ? "/ (homepage)" : p;
  } catch {
    return u;
  }
}

// UK-style long date, computed by the caller and passed in so this module stays
// deterministic (no Date.now() calls of its own).
function reportModel(record, dateStr) {
  const passed = (record.findings || []).filter((f) => f.gate === "pass");
  const sorted = [...passed].sort((a, b) => {
    const r = sev(a).rank - sev(b).rank;
    return r !== 0 ? r : (a.category || "").localeCompare(b.category || "");
  });
  const weight = passed.reduce((sum, f) => sum + sev(f).weight, 0);
  const hasSevere = passed.some(
    (f) => sev(f).rank <= SEVERITY.high.rank
  );
  const thin = !hasSevere && weight < THIN_FLOOR_WEIGHT;
  const broken = (record.link_check && record.link_check.broken) || [];
  return {
    site: record.site,
    host: hostOf(record.site),
    date: dateStr,
    pages: (record.picker && record.picker.pages_used) || [],
    findings: sorted,
    weight,
    thin,
    broken,
    coverageNotes: (record.coverage && record.coverage.notes) || [],
  };
}

function verdictLine(m) {
  if (m.thin) {
    return `We audited ${m.pages.length} key pages on <strong>${esc(
      m.host
    )}</strong> and found no material content issues. Your site is in good shape.`;
  }
  const n = m.findings.length + m.broken.length;
  const worst = m.findings.length ? sev(m.findings[0]).label.toLowerCase() : "";
  const lead = worst
    ? `led by a ${worst}-severity issue`
    : "all fixable in an afternoon";
  return `We found <strong>${n} content ${
    n === 1 ? "issue" : "issues"
  }</strong> across ${m.pages.length} key pages on <strong>${esc(
    m.host
  )}</strong>, ${lead}.`;
}

function worstOffendersRows(m) {
  const rows = [];
  for (const f of m.findings.slice(0, 6)) {
    rows.push(`<tr>
      <td><span class="chip chip-${esc((f.severity || "low").toLowerCase())}">${esc(
      sev(f).label
    )}</span></td>
      <td>${esc(CATEGORY_LABEL[f.category] || f.category || "Issue")}</td>
      <td><a href="${safeHref(f.url)}">${esc(pathOf(f.url))}</a></td>
    </tr>`);
  }
  // Broken links fill remaining rows (they are always worst-offender material).
  for (const b of m.broken.slice(0, Math.max(0, 6 - rows.length))) {
    rows.push(`<tr>
      <td><span class="chip chip-high">High</span></td>
      <td>Broken link (${esc(String(b.status))})</td>
      <td><a href="${safeHref(b.url)}">${esc(pathOf(b.url))}</a></td>
    </tr>`);
  }
  return rows.join("\n");
}

// The page a quote sits on, clickable so the reader lands on the page the quote
// was taken from (not a neighbouring finding's page).
function evidenceLabel(url) {
  return `<span class="finding-evidence-label">On <a href="${safeHref(url)}">${esc(
    pathOf(url)
  )}</a></span>`;
}

function quoteMark(quote) {
  return `<blockquote class="finding-quote">${esc(quote)}</blockquote>`;
}

// A contradiction is only legible when both sides sit together, so a finding
// carrying a counter-quote renders as one paired block: shared rule down the
// side, "vs" between the two, rather than two loose quotes the reader has to
// associate. Both lines on one page (the common case) get a single page label;
// a genuine cross-page contradiction labels each side.
function evidenceBlock(f) {
  if (!f.quote2) {
    return `<div class="finding-evidence">
          ${evidenceLabel(f.url)}
          ${quoteMark(f.quote)}
        </div>`;
  }
  const url2 = f.url2 || f.url;
  const samePage =
    String(url2).replace(/\/$/, "") === String(f.url).replace(/\/$/, "");
  if (samePage) {
    return `<div class="finding-evidence">
          ${evidenceLabel(f.url)}
          <div class="finding-evidence-pair">
            ${quoteMark(f.quote)}
            <div class="ev-vs"><span>vs</span></div>
            ${quoteMark(f.quote2)}
          </div>
        </div>`;
  }
  return `<div class="finding-evidence finding-evidence-pair">
          <div class="ev">${evidenceLabel(f.url)}${quoteMark(f.quote)}</div>
          <div class="ev-vs"><span>vs</span></div>
          <div class="ev">${evidenceLabel(url2)}${quoteMark(f.quote2)}</div>
        </div>`;
}

function findingCards(m) {
  if (!m.findings.length) return "";
  const cards = m.findings
    .map((f) => {
      const s = sev(f);
      const issue = f.issue || CATEGORY_LABEL[f.category] || f.category || "Issue";
      return `<article class="finding">
        <div class="finding-head">
          <span class="chip chip-${esc((f.severity || "low").toLowerCase())}">${esc(
        s.label
      )}</span>
          <span class="finding-cat">${esc(
            CATEGORY_LABEL[f.category] || f.category || "Issue"
          )}</span>
        </div>
        <p class="finding-issue">${esc(issue)}</p>
        ${evidenceBlock(f)}
      </article>`;
    })
    .join("\n");
  return `<section class="block">
    <h2 class="block-title">What we found</h2>
    <p class="block-lead">Worst first. Every quote is copied verbatim from your live pages as a signed-out visitor sees them, so each one is a find-and-fix. If you cannot see a quote while logged in, check the page signed out.</p>
    ${cards}
  </section>`;
}

function brokenLinksBlock(m) {
  if (!m.broken.length) return "";
  const rows = m.broken
    .map(
      (b) =>
        `<li><a href="${safeHref(b.url)}">${esc(
          b.url
        )}</a> <span class="muted">(${esc(String(b.status))})</span></li>`
    )
    .join("\n");
  return `<section class="block">
    <h2 class="block-title">Broken links</h2>
    <p class="block-lead">These returned a not-found status when we checked them.</p>
    <ul class="link-list">${rows}</ul>
  </section>`;
}

function coverageBlock(m) {
  const pages = m.pages
    .map((p) => `<li><a href="${safeHref(p)}">${esc(pathOf(p))}</a></li>`)
    .join("\n");
  const notes = (m.coverageNotes || []).length
    ? `<p class="block-lead" style="margin-top:16px">Notes on what we could read:</p>
       <ul class="link-list">${m.coverageNotes
         .map((n) => `<li class="muted">${esc(n)}</li>`)
         .join("\n")}</ul>`
    : "";
  return `<section class="block coverage">
    <h2 class="block-title">Coverage</h2>
    <p class="block-lead">Pages we read for this audit:</p>
    <ul class="link-list">${pages}</ul>
    ${notes}
    <p class="muted small">Free audits cover your key pages. A paid engagement audits the whole site.</p>
  </section>`;
}

function goodShapeBody(m) {
  return `<section class="block">
    <h2 class="block-title">Nothing material to fix</h2>
    <p class="block-lead">We read ${m.pages.length} of your key pages and did not find content issues worth flagging: no cross-page contradictions, no pricing mismatches, no broken links, no stale copy. That is rarer than you would think.</p>
    <p class="block-lead">This is the free key-page audit. If you want the whole site read the same way, that is where we can help.</p>
  </section>
  ${coverageBlock(m)}`;
}

function closerPage(m) {
  return `<section class="closer">
    <div class="closer-inner">
      <p class="closer-eyebrow">From Mooch</p>
      <h2 class="closer-title">Want these fixed, or the whole site read?</h2>
      <p class="closer-body">${
        m.thin
          ? "Your key pages are clean. The next step up is a whole-site audit and the fixes that follow."
          : `This is the free taster read. Email ${CONTACT_EMAIL} to talk through the fixes, or book a 20-minute call.`
      }</p>
      <div class="closer-actions">
        <a class="btn" href="${BOOKING_URL}">Book a 20-min call</a>
      </div>
      <p class="closer-contact">Prefer email? <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
      <p class="colophon"><a href="${SITE_URL}">mooch.agency</a> &middot; UX &amp; AI automation</p>
    </div>
  </section>`;
}

const STYLES = `
:root{
  --ink:#1d1d1f;--paper:#fff;--surface:#fbfbfd;--muted:#6e6e73;--muted-small:#5a5a5f;
  --hairline:#d2d2d7;--black:#000;
  --crit:#b00020;--crit-bg:#fbe9ec;--high:#b3480c;--high-bg:#fbeee6;
  --med:#8a6100;--med-bg:#faf3e0;--low:#5a5a5f;--low-bg:#f0f0f2;
  --serif:'Instrument Serif','Times New Roman',serif;
  --sans:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);font-size:15px;line-height:1.55;color:var(--ink);background:var(--paper);-webkit-font-smoothing:antialiased}
.page{max-width:720px;margin:0 auto;padding:56px 40px}
a{color:inherit}
.report-head{border-bottom:1px solid var(--hairline);padding-bottom:24px;margin-bottom:32px}
.wordmark{font-family:var(--serif);font-size:34px;line-height:1}
.wordmark em{font-style:italic}
.eyebrow{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-top:14px}
.report-title{font-family:var(--serif);font-size:clamp(30px,5vw,44px);line-height:1.08;margin-top:10px;text-wrap:balance}
.report-title em{font-style:italic}
.report-meta{font-family:var(--mono);font-size:12px;color:var(--muted-small);margin-top:12px}
.verdict{font-size:19px;line-height:1.5;margin:28px 0 8px;text-wrap:pretty}
.block{margin-top:40px}
.block-title{font-family:var(--serif);font-size:26px;line-height:1.1;margin-bottom:6px;text-wrap:balance}
.block-lead{color:var(--muted-small);margin-bottom:18px;max-width:56ch;text-wrap:pretty}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--hairline);vertical-align:top}
th{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:600}
.chip{display:inline-block;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:3px 8px;border-radius:980px;white-space:nowrap}
.chip-critical{background:var(--crit-bg);color:var(--crit)}
.chip-high{background:var(--high-bg);color:var(--high)}
.chip-medium{background:var(--med-bg);color:var(--med)}
.chip-low{background:var(--low-bg);color:var(--low)}
.finding{padding:20px 0;border-bottom:1px solid var(--hairline)}
.finding-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.finding-cat{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.finding-issue{font-family:var(--serif);font-size:22px;line-height:1.25;color:var(--ink);margin-bottom:12px;text-wrap:balance}
.finding-evidence-label{display:block;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:5px}
.finding-quote{font-size:14px;line-height:1.5;color:var(--muted-small);padding-left:14px;border-left:2px solid var(--hairline);text-wrap:pretty}
/* Paired evidence (a finding + the line it contradicts): one shared rule down
   the side so the two quotes read as a single comparison, "vs" between them. */
.finding-evidence-pair{border-left:2px solid var(--hairline);padding-left:14px}
.finding-evidence-pair .finding-quote{border-left:none;padding-left:0}
.ev-vs{display:flex;align-items:center;gap:8px;margin:10px 0;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.ev-vs::after{content:"";flex:1;height:1px;background:var(--hairline)}
.link-list{list-style:none;font-family:var(--mono);font-size:13px}
.link-list li{padding:6px 0;border-bottom:1px solid var(--hairline);word-break:break-all}
.muted{color:var(--muted)}.small{font-size:12px}
.coverage .link-list li{border:none;padding:3px 0}
.closer{background:var(--surface);border-radius:20px;margin-top:48px;padding:44px 36px}
.closer-eyebrow{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
.closer-title{font-family:var(--serif);font-size:32px;line-height:1.1;margin:10px 0 12px;text-wrap:balance}
.closer-body{color:var(--muted-small);max-width:52ch;margin-bottom:24px;text-wrap:pretty}
.closer-actions{display:flex;flex-wrap:wrap;gap:12px}
.closer-contact{margin-top:14px;font-size:13px;color:var(--muted-small)}
.btn{display:inline-block;background:var(--black);color:var(--paper);padding:12px 20px;border-radius:980px;font-size:14px;font-weight:500;border:1px solid var(--black)}
.colophon{margin-top:26px;font-family:var(--mono);font-size:11px;color:var(--muted)}
@media print{
  body{font-size:12px}
  .page{max-width:none;padding:0}
  .closer{background:var(--surface)!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;break-inside:avoid}
  .finding,.closer,tr,.finding-evidence-pair{break-inside:avoid}
  .chip{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;

// record: pipeline output; dateStr: pre-formatted report date (caller supplies).
// Returns { html, thin, findingCount, weight }.
export function renderReport(record, dateStr) {
  const m = reportModel(record, dateStr);
  const body = m.thin
    ? goodShapeBody(m)
    : `${
        m.findings.length || m.broken.length
          ? `<section class="block"><h2 class="block-title">Worst offenders</h2>
             <table><thead><tr><th>Severity</th><th>Type</th><th>Page</th></tr></thead>
             <tbody>${worstOffendersRows(m)}</tbody></table></section>`
          : ""
      }
      ${findingCards(m)}
      ${brokenLinksBlock(m)}
      ${coverageBlock(m)}`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Content audit &mdash; ${esc(m.host)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>${STYLES}</style>
</head>
<body>
<main class="page">
  <header class="report-head">
    <div class="wordmark"><em>Mooch.</em></div>
    <div class="eyebrow">Free content audit</div>
    <h1 class="report-title">${esc(m.host)}</h1>
    <div class="report-meta">${esc(m.date)} &middot; ${m.pages.length} key pages read</div>
  </header>
  <p class="verdict">${verdictLine(m)}</p>
  ${body}
  ${closerPage(m)}
</main>
</body>
</html>`;

  return { html, thin: m.thin, findingCount: m.findings.length, weight: m.weight };
}
