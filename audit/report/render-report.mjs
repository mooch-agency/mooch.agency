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

// Default skip wording: the soft-404 case, where the site's own status codes lie.
const SOFT_404_NOTE =
  "We couldn't check your links. This site returns a not-found status for pages that load fine, so the status codes aren't reliable enough to report on.";

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
  const linkCheck = record.link_check || {};
  const broken = linkCheck.broken || [];
  // A verified broken link defeats the good-shape variant on its own. It is the
  // most objectively checkable finding the pipeline produces, and before this it
  // was the most suppressed: the apexvolumetrics record carried a dead hero CTA,
  // rendered thin: true, dropped the URL from the HTML entirely, and shipped
  // "found nothing material to fix" (recall-gap ticket, item 1).
  const thin = !hasSevere && weight < THIN_FLOOR_WEIGHT && broken.length === 0;
  const coverageNotes = (record.coverage && record.coverage.notes) || [];
  const linkCheckSkipped = Boolean(linkCheck.soft_404);
  // THE HONESTY GATE. "We found nothing" and "we couldn't look properly" are
  // different claims, and only the first is ours to make. A thin run whose
  // coverage was degraded (a page we could not read, a link check we could not
  // run) is INCONCLUSIVE, not clean.
  //
  // apexvolumetrics, 30 Jul: the homepage fetch was bot-blocked, so the audit
  // never saw the page carrying the hero, the pricing or the primary CTA, and
  // the report still said "found nothing material to fix. Your site's in good
  // shape." That is a clean bill of health issued over the most important page
  // on the site, and it is the exact failure this gate exists to prevent.
  //
  // Findings outrank coverage gaps: with something real to show, show it. The
  // gate stops a false all-clear, it does not bury findings behind a caveat.
  const inconclusive = thin && (coverageNotes.length > 0 || linkCheckSkipped);
  return {
    site: record.site,
    host: hostOf(record.site),
    date: dateStr,
    pages: (record.picker && record.picker.pages_used) || [],
    findings: sorted,
    weight,
    thin,
    inconclusive,
    broken,
    // An empty `broken` list means "we found none" OR "we never looked": on a
    // soft-404 origin the check is skipped because the status codes lie. The
    // report must not read those two states the same way.
    linkCheckSkipped,
    linkCheckSkipNote: linkCheck.skip_note || null,
    // A SCOPE note is not a COVERAGE GAP, and the difference decides whether a
    // clean site can be told it is clean. "We opened your links rather than
    // sweeping every status code" describes how thoroughly we looked; "we could
    // not read your homepage" describes something we failed to see. Only the
    // second may block a clean bill of health. Feeding scope notes into
    // coverageNotes would make every audit permanently inconclusive, and telling a
    // client with a healthy site that we "couldn't read your links" is false.
    scopeNotes: linkCheck.scope_note ? [linkCheck.scope_note] : [],
    coverageNotes,
  };
}

// What we could not read, in the client's words rather than the runner's. The
// coverage notes are written for us ("bot-block or empty", a URL, a hedge); the
// verdict has to name the gap in a way a reader can act on.
function unreadSummary(m) {
  const notes = m.coverageNotes || [];
  const homepage = notes.some((n) => /homepage/i.test(n));
  const parts = [];
  if (homepage) parts.push("your homepage");
  const others = notes.filter((n) => !/homepage/i.test(n)).length;
  if (others) parts.push(others === 1 ? "one other page" : `${others} other pages`);
  if (!parts.length && m.linkCheckSkipped) return "your links";
  if (!parts.length) return "some of your pages";
  return parts.join(" and ");
}

// The verdict is the only place the result is stated. Everything below it shows
// the evidence or the scope, so nothing repeats this line.
function verdictLine(m) {
  // Inconclusive is checked FIRST: it is a thin run too, and the good-shape
  // sentence below would otherwise certify a site we could not fully read.
  if (m.inconclusive) {
    return `We audited ${m.pages.length} key pages on <strong>${esc(
      m.host
    )}</strong> and didn't find anything material on them, but we couldn't read ${esc(
      unreadSummary(m)
    )}, so this isn't a clean bill of health.`;
  }
  if (m.thin) {
    // "your key pages", not "your site": we only read the pages listed under
    // Coverage, and the reader can check that claim against the list.
    return `We audited ${m.pages.length} key pages on <strong>${esc(
      m.host
    )}</strong> and found nothing material to fix. Your site's in good shape.`;
  }
  const n = m.findings.length + m.broken.length;
  // Only qualify the count when there's a severity to name. The old fallback
  // promised the lot was "all fixable in an afternoon", which we cannot know.
  const worst = m.findings.length
    ? `, led by a ${sev(m.findings[0]).label.toLowerCase()}-severity issue`
    : "";
  return `We found <strong>${n} content ${
    n === 1 ? "issue" : "issues"
  }</strong> across ${m.pages.length} key pages on <strong>${esc(
    m.host
  )}</strong>${worst}.`;
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
  // 'dead_domain' is an internal token; the client reads what it means.
  for (const b of m.broken.slice(0, Math.max(0, 6 - rows.length))) {
    const label = b.status === "dead_domain" ? "domain doesn't resolve" : String(b.status);
    rows.push(`<tr>
      <td><span class="chip chip-high">High</span></td>
      <td>Broken link (${esc(label)})</td>
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
  // An absence finding has nothing to quote: its claim is that the page renders
  // nothing, or renders the wrong thing. Presenting the observed state inside
  // quotation marks would tell the client we are quoting their page when we are
  // describing it, so it renders as a plain observation instead. The claim itself
  // is verified by the 404-control probe in absence-check.mjs, not by a quote.
  if (f.absence_claim) {
    return `<div class="finding-evidence">
          ${evidenceLabel(f.url)}
          <p class="muted">${esc(f.evidence_note || "This page does not render the content it should.")}</p>
        </div>`;
  }
  if (!f.quote2) {
    return `<div class="finding-evidence">
          ${evidenceLabel(f.url)}
          ${quoteMark(f.quote)}
        </div>`;
  }
  const url2 = f.url2 || f.url;
  // Compare at the same granularity the label actually displays. A raw-string
  // comparison disagreed with pathOf() whenever two quotes shared a page but
  // differed by query string or hash (?ref=x, #annual vs #monthly): "cross-page"
  // layout fired, and both sides rendered the identical label ("On /pricing",
  // "On /pricing") stacked as if they were different sources. Comparing pathnames
  // makes the layout decision agree with what the reader is shown.
  const samePage = pathOf(url2) === pathOf(f.url);
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
    .map((f, i) => {
      const s = sev(f);
      const issue = f.issue || CATEGORY_LABEL[f.category] || f.category || "Issue";
      return `<article class="finding">
        <div class="finding-head">
          <span class="finding-num">${i + 1}</span>
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
    <p class="block-lead">Every quote is copied verbatim from your live pages.</p>
    ${cards}
  </section>`;
}

function brokenLinksBlock(m) {
  if (!m.broken.length) return "";
  // 'dead_domain' is an internal token (link-check.mjs); the client reads what
  // it means, not what we call it.
  const statusLabel = (s) =>
    s === "dead_domain" ? "the domain doesn't resolve" : String(s);
  const rows = m.broken
    .map(
      (b) =>
        `<li><a href="${safeHref(b.url)}">${esc(
          b.url
        )}</a> <span class="muted">(${esc(statusLabel(b.status))})</span></li>`
    )
    .join("\n");
  return `<section class="block">
    <h2 class="block-title">Broken links</h2>
    <p class="block-lead">These didn't lead anywhere when we checked them.</p>
    <ul class="link-list">${rows}</ul>
  </section>`;
}

function coverageBlock(m) {
  const pages = m.pages
    .map((p) => `<li><a href="${safeHref(p)}">${esc(pathOf(p))}</a></li>`)
    .join("\n");
  // A skipped link check is a limit on this audit, so it belongs with the other
  // coverage notes rather than being swallowed. Without it, "no broken links"
  // and "we could not check the links" look identical to the reader.
  // The wording depends on WHY the check was skipped, and there is now more than
  // one reason. The soft-404 case is a property of the audited site; the websearch
  // method simply does not run a programmatic status sweep. Telling a client their
  // status codes are unreliable when they are fine would be a false statement about
  // their site, so the reason travels with the record.
  const allNotes = [
    ...(m.linkCheckSkipped ? [m.linkCheckSkipNote || SOFT_404_NOTE] : []),
    ...(m.coverageNotes || []),
    ...(m.scopeNotes || []),
  ];
  const notes = allNotes.length
    ? `<ul class="notes-list muted" style="margin-top:16px">${allNotes
         .map((n) => `<li>${esc(n)}</li>`)
         .join("\n")}</ul>`
    : "";
  return `<section class="block coverage">
    <h2 class="block-title">Coverage</h2>
    <p class="block-lead">Pages we read for this audit:</p>
    <ul class="link-list">${pages}</ul>
    ${notes}
    <p class="scope-note"><strong>This free audit only covers your key pages.</strong></p>
  </section>`;
}

// Deliberately just the coverage. The verdict line above already states the
// result, and the closer already makes the offer, so a block between them could
// only restate one or the other. It used to do both, and it also claimed "no
// broken links" on sites where we never checked them.
function goodShapeBody(m) {
  return coverageBlock(m);
}

function closerPage(m) {
  return `<section class="closer">
    <div class="closer-inner">
      <h2 class="closer-title">${
        // "these" has no referent on a good-shape report: that variant prints no
        // findings list. The body below has always branched here, the title had
        // not, so a clean report closed by asking to fix things it never showed.
        // The inconclusive variant asks for the one thing it actually needs,
        // which is also the most honest offer on the page: we hit something we
        // could not read from outside, and reading it properly is the service.
        m.inconclusive
          ? "Want us to read the pages we couldn't reach?"
          : m.thin
            ? "Want your whole site read the same way?"
            : "Want these fixed, or the whole site read?"
      }</h2>
      <p class="closer-body">${
        // Says what a paid engagement adds, nothing else. It used to restate the
        // verdict ("your key pages are clean"), restate the scope line in
        // Coverage, and repeat the two contact routes sitting right below it.
        m.inconclusive
          ? "A paid engagement covers every page, including the ones an outside crawl can't load."
          : m.thin
            ? "A paid engagement covers every page on the site."
            : "A paid engagement covers every page, and the fixes that follow."
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
  /* ONE measure for every run of prose. Set in px, not ch, on purpose: ch scales
     with font-size, so a shared ch measure would still wrap the 19px verdict,
     the 15px lead and the 14px quote at three different right edges. A reader
     sees the edges, not the character count. Structure (rules, tables) spans the
     full column; prose sits inside this. ~69ch at the 15px body size. */
  --measure:520px;
  /* The closer is a card inset from the column. Its prose subtracts that inset
     so its rag lands on the same absolute edge as everything above it. */
  --closer-pad:36px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);font-size:15px;line-height:1.55;color:var(--ink);background:var(--paper);-webkit-font-smoothing:antialiased}
.page{max-width:720px;margin:0 auto;padding:56px 40px}
a{color:inherit}
.report-head{border-bottom:1px solid var(--hairline);padding-bottom:24px;margin-bottom:32px}
.wordmark{font-family:var(--serif);font-size:34px;line-height:1}
.wordmark em{font-style:italic}
.eyebrow{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-top:14px}
.report-title{font-family:var(--serif);font-size:clamp(30px,5vw,44px);line-height:1.08;margin-top:10px;max-width:var(--measure);text-wrap:balance}
.report-title em{font-style:italic}
.report-meta{font-family:var(--mono);font-size:12px;color:var(--muted-small);margin-top:12px}
.verdict{font-size:19px;line-height:1.5;margin:28px 0 8px;max-width:var(--measure);text-wrap:pretty}
.block{margin-top:40px}
.block-title{font-family:var(--serif);font-size:26px;line-height:1.1;margin-bottom:6px;max-width:var(--measure);text-wrap:balance}
.block-lead{color:var(--muted-small);margin-bottom:18px;max-width:var(--measure);text-wrap:pretty}
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
.finding-num{font-family:var(--mono);font-size:11px;color:var(--muted);min-width:16px}
.finding-cat{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
/* Sans, not serif, and a size down from the 30 Jul original. The serif is now
   reserved for headlines (.block-title, .report-title): a finding statement is
   read fast, under stress (the client is here because something's wrong), and
   is closer to body copy than to editorial prose. */
/* text-wrap:balance is for headlines: 2-3 near-equal lines. On a 3-line finding
   statement it evens every line to ~80% of the measure instead of filling
   naturally, leaving visible slack on every line — the "strange break" the serif
   original never had. pretty avoids orphans without forcing that even-out. */
.finding-issue{font-family:var(--sans);font-size:18px;line-height:1.4;font-weight:400;color:var(--ink);margin-bottom:12px;max-width:var(--measure);text-wrap:pretty}
/* The measure sits on the evidence wrapper, not the quote: the quote is inset by
   its own rule, so capping the quote would push its right edge past every other
   block by exactly that inset. Capping the wrapper lands the rag on the measure. */
.finding-evidence{max-width:var(--measure)}
.finding-evidence-label{display:block;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:5px}
/* Monospace, bordered evidence block, not prose styling: a quote here is data
   lifted verbatim off a screen, not something anyone wrote as a sentence, and
   the mono face reads that way at a glance without literal quote-mark glyphs
   competing with the vs divider below. */
.finding-quote{font-family:var(--mono);font-size:12.5px;line-height:1.6;color:var(--muted-small);background:var(--surface);border:1px solid var(--hairline);border-radius:6px;padding:12px 14px;text-wrap:pretty}
/* Paired evidence (a finding + the line it contradicts): each box is already a
   self-contained bordered block, so the pair needs no extra shared rule down
   the side — that would double up against each box's own border. The "vs"
   divider alone carries the pairing. */
.finding-evidence-pair{display:flex;flex-direction:column;gap:2px}
.ev-vs{display:flex;align-items:center;gap:8px;margin:10px 0;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.ev-vs::after{content:"";flex:1;height:1px;background:var(--hairline)}
.link-list{list-style:none;font-family:var(--mono);font-size:13px;max-width:var(--measure)}
.link-list li{padding:6px 0;border-bottom:1px solid var(--hairline);word-break:break-all}
.muted{color:var(--muted)}.small{font-size:12px}
.coverage .link-list li{border:none;padding:3px 0}
/* Prose, not URLs: break-all is for URLs that have nowhere else to wrap. Applied
   to a sentence it snaps mid-word ("sweep-ing your links") wherever a line hits
   the container edge. Sentences get the sans font and ordinary word wrapping. */
.notes-list{list-style:none;font-family:var(--sans);font-size:13px;max-width:var(--measure)}
.notes-list li{padding:3px 0;overflow-wrap:break-word;word-break:normal}
/* Scope reminder, set apart from the coverage-gap list above it: nothing failed
   to load here, it is a boundary of the free audit, and it should read that way
   on a skim, not sit lost in a paragraph of small print. */
.scope-note{border-left:2px solid var(--ink);padding-left:14px;margin-top:20px;font-size:14px}
.closer{background:var(--surface);border-radius:20px;margin-top:48px;padding:44px var(--closer-pad)}
.closer-title{font-family:var(--serif);font-size:32px;line-height:1.1;margin:10px 0 12px;max-width:calc(var(--measure) - var(--closer-pad));text-wrap:balance}
.closer-body{color:var(--muted-small);max-width:calc(var(--measure) - var(--closer-pad));margin-bottom:24px;text-wrap:pretty}
.closer-actions{display:flex;flex-wrap:wrap;gap:12px}
.closer-contact{margin-top:14px;font-size:13px;color:var(--muted-small)}
.btn{display:inline-block;background:var(--black);color:var(--paper);padding:12px 20px;border-radius:980px;font-size:14px;font-weight:500;border:1px solid var(--black)}
.colophon{margin-top:26px;font-family:var(--mono);font-size:11px;color:var(--muted)}
@media print{
  body{font-size:12px}
  /* Match the on-screen column exactly (720 - 2x40 = 640). Without the side
     padding the PDF column is the full A4 text area (~688px), so the HTML report
     and the PDF of it broke their lines in different places. */
  .page{max-width:none;padding:0 24px}
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
    <div class="report-meta">${esc(m.date)}</div>
  </header>
  <p class="verdict">${verdictLine(m)}</p>
  ${body}
  ${closerPage(m)}
</main>
</body>
</html>`;

  return { html, thin: m.thin, inconclusive: m.inconclusive, findingCount: m.findings.length, weight: m.weight };
}
