// Lean HTML email that carries the audit result. The full branded report rides
// along as a PDF attachment (see send-report.mjs); this body teases the verdict
// and the worst few findings, then points at the reply / booking CTA (story 14).
//
// Email clients are hostile to webfonts and external CSS, so everything here is
// inline-styled with system fonts (Georgia for the serif echo). Kept separate
// from render-report.mjs, which targets the print/PDF surface.

const CONTACT_EMAIL = "hey@mooch.agency";
const BOOKING_URL = "https://cal.eu/mooch/discovery";
const SITE_URL = "https://mooch.agency";

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
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

function hostOf(u) {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
}

// record + date -> { subject, html }. thin mirrors render-report's floor so the
// email and PDF always agree on whether the site is "in good shape".
export function renderEmail(record, dateStr) {
  const host = hostOf(record.site);
  const passed = (record.findings || []).filter((f) => f.gate === "pass");
  passed.sort(
    (a, b) =>
      (SEV_RANK[(a.severity || "low").toLowerCase()] ?? 3) -
      (SEV_RANK[(b.severity || "low").toLowerCase()] ?? 3)
  );
  const broken = (record.link_check && record.link_check.broken) || [];
  const weight = passed.reduce((s, f) => {
    const r = SEV_RANK[(f.severity || "low").toLowerCase()] ?? 3;
    return s + (r === 0 ? 5 : r === 1 ? 3 : r === 2 ? 2 : 1);
  }, 0);
  const hasSevere = passed.some(
    (f) => (SEV_RANK[(f.severity || "low").toLowerCase()] ?? 3) <= 1
  );
  const thin = !hasSevere && weight < 3;
  const n = passed.length + broken.length;

  const subject = thin
    ? `Your ${host} content audit: all clear`
    : `Your ${host} content audit: ${n} ${n === 1 ? "issue" : "issues"} found`;

  const teaser = thin
    ? `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#1d1d1f">We read ${passed.length ? "your" : ""} key pages on <strong>${esc(
        host
      )}</strong> and found nothing material to fix. That is rarer than you would think. The full audit is attached.</p>`
    : `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#1d1d1f">We found <strong>${n} content ${
        n === 1 ? "issue" : "issues"
      }</strong> on <strong>${esc(
        host
      )}</strong>. The worst few are below; the full report is attached as a PDF.</p>`;

  const top = passed.slice(0, 3).map((f) => {
    const label = CATEGORY_LABEL[f.category] || f.category || "Issue";
    const issue = f.issue || label;
    return `<tr><td style="padding:14px 0;border-bottom:1px solid #d2d2d7">
      <div style="font:600 11px/1 -apple-system,Arial,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#6e6e73;margin-bottom:7px">${esc(
        label
      )}</div>
      <div style="font:400 18px/1.35 Georgia,'Times New Roman',serif;color:#1d1d1f;margin-bottom:9px">${esc(
        issue
      )}</div>
      <div style="font:400 13px/1.5 -apple-system,Arial,sans-serif;color:#6e6e73;padding-left:11px;border-left:2px solid #d2d2d7">${esc(
        f.quote
      )}</div>
    </td></tr>`;
  });
  const findingsTable =
    !thin && top.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px">${top.join(
          ""
        )}</table>`
      : "";

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
  <tr><td style="padding-bottom:20px;border-bottom:1px solid #d2d2d7">
    <div style="font:400 30px/1 Georgia,'Times New Roman',serif;font-style:italic;color:#1d1d1f">Mooch.</div>
    <div style="font:600 11px/1 -apple-system,Arial,sans-serif;text-transform:uppercase;letter-spacing:.12em;color:#6e6e73;margin-top:10px">Free content audit &middot; ${esc(
      dateStr
    )}</div>
  </td></tr>
  <tr><td style="padding-top:24px">
    ${teaser}
    ${findingsTable}
    <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#1d1d1f">Want these fixed, or your whole site read the same way? Just reply to this email, or grab a 20-minute call.</p>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="border-radius:980px;background:#000000"><a href="mailto:${CONTACT_EMAIL}" style="display:inline-block;padding:12px 22px;font:500 14px -apple-system,Arial,sans-serif;color:#ffffff;text-decoration:none">Reply to talk fixes</a></td>
      <td style="padding-left:10px"><a href="${BOOKING_URL}" style="display:inline-block;padding:12px 22px;font:500 14px -apple-system,Arial,sans-serif;color:#1d1d1f;text-decoration:none;border:1px solid #d2d2d7;border-radius:980px">Book a call</a></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding-top:28px">
    <div style="font:400 11px -apple-system,Arial,sans-serif;color:#6e6e73"><a href="${SITE_URL}" style="color:#6e6e73;text-decoration:none">mooch.agency</a> &middot; UX &amp; AI automation &middot; London &amp; Lisbon</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, html, thin };
}
