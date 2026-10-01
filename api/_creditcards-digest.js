// The Credit Cards daily digest, minus its transport. Everything here is
// either pure (selection, subject, email HTML and text, idempotency key, state
// merge) or takes its side effects as arguments (runDigest), so the tests in
// scripts/creditcards-digest.test.mjs cover it with no keys and no network.
// api/creditcards-digest.js wires in the real Stripe, Resend and Blob calls.
//
// Ported from monitoring-the-situation's src/notify.ts: silent unless
// something is new, escapeHtml on every interpolated value, and a Resend
// Idempotency-Key derived from the recipient plus the sorted item ids.

const crypto = require("node:crypto");
const { INDEX_URL } = require("./_creditcards");

// Mirrors CATEGORIES in scripts/creditcards-categories.mjs. Duplicated rather
// than imported because that file is ESM and this one is a CommonJS function;
// the digest test asserts the two lists match, so they cannot drift silently.
const CATEGORY_LABELS = {
  rarity: "Rarity & data",
  art: "Art & remixes",
  statements: "Build your Statement",
  games: "Games",
  markets: "Mints, tokens & markets",
};

// Email can't read tokens.css, so these mirror its values by hand:
// paper, ink, black, muted, muted-small, hairline, and the four --credit-*
// process colours. The ground is a light grey so the white card reads.
const C = {
  ground: "#ececea",
  paper: "#ffffff",
  ink: "#1d1d1f",
  black: "#000000",
  muted: "#6e6e73",
  mutedSmall: "#5a5a5f",
  hairline: "#d2d2d7",
  foot: "#8e8e93",
  pips: ["#00aeef", "#ec008c", "#fff200", "#1a1a1a"],
};
// Instrument Serif won't load in most mail clients, so the display face falls
// back to the classic email-safe serif stack.
const SERIF = "Georgia, 'Times New Roman', Times, serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only http(s) links reach an href. The data file is human-approved, but a
// javascript: or data: URL slipping through review would otherwise ship in
// every subscriber's inbox.
function safeUrl(u, fallback = INDEX_URL) {
  return /^https?:\/\//i.test(String(u || "")) ? String(u) : fallback;
}

// "1 October 2026", in UK time because the send is "7am UK".
function formatDate(now) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(now);
}

// --- Selection ---------------------------------------------------------------------

/**
 * What a digest lists: approved projects whose id has not been sent before.
 * Pending and rejected finds never reach a paying inbox (they haven't been
 * vetted). Oldest first, then by name, so the order is stable between runs.
 * v1 sends no deadlines: data/creditcards.json carries none to send.
 */
function selectNew(projects, sentIds) {
  const sent = new Set(sentIds || []);
  return (projects || [])
    .filter((p) => p && p.status === "approved" && p.id && !sent.has(p.id))
    .sort((a, b) => String(a.added || "").localeCompare(String(b.added || "")) || String(a.name).localeCompare(String(b.name)));
}

/** "1 new Credits project" / "3 new Credits projects". Never called with 0. */
function buildSubject(items) {
  const n = items.length;
  return `${n} new Credits ${n === 1 ? "project" : "projects"}`;
}

/** "@a", "@a & @b", "@a, @b & @c": the builder plus any co-builders. */
function byline(p) {
  const handles = [p.x, ...(Array.isArray(p.with) ? p.with : [])].filter(Boolean).map((h) => `@${h}`);
  if (handles.length <= 1) return handles.join("");
  return `${handles.slice(0, -1).join(", ")} & ${handles[handles.length - 1]}`;
}

/** Same recipient + same items = same key, so a retried or overlapping send
 * is deduplicated by Resend (24h window), while a different digest is not. */
function idempotencyKey(to, items) {
  const ids = items.map((p) => p.id).sort().join(",");
  return crypto.createHash("sha256").update(`creditcards\n${to}\n${ids}`).digest("hex").slice(0, 40);
}

// --- Email ---------------------------------------------------------------------------

const monoStyle = (size, color, extra = "") =>
  `font-family:${MONO};font-size:${size}px;line-height:1.5;text-transform:uppercase;letter-spacing:0.12em;color:${color};${extra}`;

function renderPips() {
  return C.pips
    .map((c) => `<span style="display:inline-block;width:7px;height:7px;background:${c};margin-right:2px;vertical-align:middle;font-size:0;line-height:0;">&nbsp;</span>`)
    .join("");
}

function renderItem(p, last) {
  const label = CATEGORY_LABELS[p.category];
  const chip = label
    ? ` <span style="${monoStyle(10, C.mutedSmall, `border:1px solid ${C.hairline};border-radius:6px;padding:2px 7px;white-space:nowrap;vertical-align:middle;`)}">${escapeHtml(label)}</span>`
    : "";
  const by = byline(p);
  const post = p.post ? `<a href="${escapeHtml(safeUrl(p.post))}" style="color:${C.muted};">The announcement &rarr;</a>` : "";
  const byLine = [by ? `By ${escapeHtml(by)}` : "", post].filter(Boolean).join(" &middot; ");
  return `<tr><td style="padding:20px 0;${last ? "" : `border-bottom:1px solid ${C.hairline};`}">
<p style="margin:0 0 8px;line-height:1.3;"><span aria-hidden="true">${renderPips()}</span> <a href="${escapeHtml(safeUrl(p.url))}" style="font-family:${SERIF};font-size:22px;color:${C.black};text-decoration:none;vertical-align:middle;">${escapeHtml(p.name)}</a>${chip}</p>
${p.blurb ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink};">${escapeHtml(p.blurb)}</p>` : ""}
${byLine ? `<p style="margin:0;${monoStyle(10, C.muted)}">${byLine}</p>` : ""}
</td></tr>`;
}

/**
 * The digest email: self-contained, table-based HTML so it holds up in Gmail,
 * Apple Mail and Outlook, readable on a phone (one 600px column that shrinks).
 * `manageUrl` is this recipient's signed portal link: Manage and Unsubscribe
 * both go there, because cancelling IS unsubscribing (Stripe is the list).
 */
function buildEmailHtml(items, { now = new Date(), manageUrl, indexUrl = INDEX_URL } = {}) {
  const n = items.length;
  const noun = n === 1 ? "project" : "projects";
  const manage = escapeHtml(manageUrl || indexUrl);
  const index = escapeHtml(indexUrl);
  const preheader = escapeHtml(items.map((p) => p.name).join(", "));
  const link = `color:${C.muted};`;
  const rows = items.map((p, i) => renderItem(p, i === n - 1)).join("\n");

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(buildSubject(items))}</title>
</head>
<body style="margin:0;padding:0;background:${C.ground};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ground};">
<tr><td align="center" style="padding:32px 12px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${C.paper};border:1px solid #e2e2e0;border-radius:10px;">
<tr><td style="padding:32px 28px 26px;font-family:${SANS};color:${C.ink};">
<p style="margin:0;${monoStyle(10, C.muted, "letter-spacing:0.14em;")}">Credit Cards &middot; Daily scan &middot; ${escapeHtml(formatDate(now))}</p>
<h1 style="margin:16px 0 6px;font-family:${SERIF};font-weight:400;font-size:34px;line-height:1.05;letter-spacing:-0.01em;color:${C.black};">${n} new <em style="font-style:italic;">${noun}.</em></h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${C.mutedSmall};">Added to the index since the last scan. <a href="${index}" style="color:${C.ink};">Open Credit Cards &rarr;</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.hairline};border-bottom:1px solid ${C.hairline};">
${rows}
</table>
<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:${C.muted};">You pay for this, so we keep it honest: no sponsors in the email, ever. Reply and a human answers.</p>
<p style="margin:10px 0 0;${monoStyle(10, C.muted)}"><a href="${index}" style="${link}">Open the index</a> &middot; <a href="${manage}" style="${link}">Manage</a> &middot; <a href="${manage}" style="${link}">Unsubscribe</a></p>
</td></tr>
</table>
<p style="margin:20px 0 0;text-align:center;${monoStyle(10, C.foot, "letter-spacing:0.14em;")}">Mooch &middot; Unofficial fan index, not affiliated with Jack Butcher</p>
</td></tr>
</table>
</body>
</html>`;
}

/** Plain-text part. Mail clients that block HTML, and spam filters, both
 * read this, so it carries the same items and the same links. */
function buildEmailText(items, { now = new Date(), manageUrl, indexUrl = INDEX_URL } = {}) {
  const lines = [`CREDIT CARDS · DAILY SCAN · ${formatDate(now)}`, "", buildSubject(items) + ".", ""];
  for (const p of items) {
    lines.push(`${p.name}${CATEGORY_LABELS[p.category] ? ` (${CATEGORY_LABELS[p.category]})` : ""}`);
    if (p.blurb) lines.push(p.blurb);
    lines.push(safeUrl(p.url));
    const by = byline(p);
    if (by || p.post) lines.push([by ? `By ${by}` : "", p.post ? `The announcement: ${safeUrl(p.post)}` : ""].filter(Boolean).join(" · "));
    lines.push("");
  }
  lines.push("You pay for this, so we keep it honest: no sponsors in the email, ever. Reply and a human answers.", "");
  lines.push(`Open the index: ${indexUrl}`, `Manage or unsubscribe: ${manageUrl || indexUrl}`);
  return lines.join("\n");
}

// --- State ---------------------------------------------------------------------------

/** Union of what is stored now and what this run sent. Merging at write time
 * (MTS's mergeJsonObject pattern) means two overlapping runs can't erase
 * each other's ids: last writer no longer wins, both do. */
function mergeState(current, sentIds, now) {
  const ids = new Set([...((current && current.sentIds) || []), ...sentIds]);
  return { sentIds: [...ids].sort(), updatedAt: now.toISOString() };
}

// --- The run -----------------------------------------------------------------------

/**
 * One digest run, side effects injected:
 *   loadProjects()        -> the projects array (data/creditcards.json)
 *   loadState()           -> { sentIds } or null when nothing is stored yet
 *   saveState(merge)      -> persists merge(currentStoredState)
 *   listRecipients()      -> [{ email, customerId }], active + trialing
 *   manageUrlFor(r)       -> the recipient's signed portal link
 *   send(message)         -> { ok, id?, error?, perRecipient? }, never throws.
 *                            perRecipient: true marks a failure that is about
 *                            this one address (Resend 4xx), not the pipe
 *                            (5xx, 429 quota, timeout, network).
 *
 * Rules, in order:
 *   - No stored state at all: this is the first run. Record every approved id
 *     as sent and email nobody, or launch day would mail the whole index (33
 *     projects) to the first subscriber.
 *   - Nothing new: skip silently. Most days land here.
 *   - New items but no subscribers: record them as sent, so the first
 *     subscriber doesn't receive a backlog in their first email.
 *   - Otherwise send one email per recipient, then record the ids unless the
 *     run hit an infrastructure failure: every send failed, or any send
 *     failed for a non-per-recipient reason. (A failed recipient fetch or
 *     Blob write throws before or during saveState, so it withholds too.)
 *     Withheld state is safe to re-run within 24h: Resend drops the sends
 *     that already went out by their idempotency key.
 *
 * Trade-off, accepted 1 Oct 2026: when only some recipients fail, and only
 * for per-recipient reasons, state still advances, so those people miss that
 * day's items for good. The alternative was worse: one address that fails
 * every day would hold state forever, and every other subscriber would get
 * the same growing digest again each morning. The count is in the run
 * summary (failedRecipients) so it shows in the cron log.
 */
async function runDigest({ now = new Date(), loadProjects, loadState, saveState, listRecipients, manageUrlFor, send }) {
  const projects = await loadProjects();
  const state = await loadState();

  if (!state) {
    const ids = selectNew(projects, []).map((p) => p.id);
    await saveState((current) => mergeState(current, ids, now));
    return { ok: true, skipped: true, reason: "first run: seeded state, sent nothing", seeded: ids.length };
  }

  const items = selectNew(projects, state.sentIds);
  if (items.length === 0) return { ok: true, skipped: true, reason: "nothing new", newCount: 0 };
  const ids = items.map((p) => p.id);

  const recipients = await listRecipients();
  if (recipients.length === 0) {
    await saveState((current) => mergeState(current, ids, now));
    return { ok: true, skipped: true, reason: "no recipients", newCount: items.length };
  }

  const subject = buildSubject(items);
  let sent = 0;
  let failedRecipients = 0; // per-recipient failures: state still advances
  const errors = [];
  for (const r of recipients) {
    const manageUrl = manageUrlFor(r);
    const result = await send({
      to: r.email,
      subject,
      html: buildEmailHtml(items, { now, manageUrl }),
      text: buildEmailText(items, { now, manageUrl }),
      manageUrl,
      idempotencyKey: idempotencyKey(r.email, items),
    });
    if (result && result.ok) sent++;
    else {
      if (result && result.perRecipient) failedRecipients++;
      errors.push((result && result.error) || "unknown send error");
    }
  }

  const infraFailures = errors.length - failedRecipients;
  const save = sent > 0 && infraFailures === 0;
  if (save) await saveState((current) => mergeState(current, ids, now));
  return {
    // ok means state advanced. A run with failedRecipients > 0 is still ok
    // (see the trade-off above); the handler logs it all the same.
    ok: save,
    newCount: items.length,
    recipients: recipients.length,
    sent,
    failed: errors.length,
    failedRecipients,
    // First few only: enough to diagnose from the cron log, never a list of
    // addresses (send errors carry Resend's status text, not the recipient).
    errors: errors.slice(0, 3),
  };
}

module.exports = {
  CATEGORY_LABELS,
  escapeHtml,
  safeUrl,
  formatDate,
  selectNew,
  buildSubject,
  byline,
  idempotencyKey,
  buildEmailHtml,
  buildEmailText,
  mergeState,
  runDigest,
};
