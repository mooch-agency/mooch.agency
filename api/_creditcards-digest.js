// The Credit Cards perk alert, minus its transport. Everything here is either
// pure (selection, subject, email HTML and text, idempotency key, state
// merge) or takes its side effects as arguments (runDigest), so the tests in
// scripts/creditcards-digest.test.mjs cover it with no keys and no network.
// api/creditcards-digest.js wires in the real Stripe, Resend and Blob calls.
//
// What it sends: new perks for Credits holders (data/creditcards.json,
// perks[]), not new projects. Holders pay to hear about the thing they can
// claim, and most perks close within days. Changed from projects 1 Oct 2026.
//
// Items arrive decorated by the caller: each perk carries `status` (open,
// ended or unknown, from perkStatus in scripts/creditcards-perks.mjs for the
// day of the run) and `typeLabel` ("Free mint"). Status logic lives in that
// one ESM module, so this file never copies it.
//
// Ported from monitoring-the-situation's src/notify.ts: silent unless
// something is new, escapeHtml on every interpolated value, and a Resend
// Idempotency-Key derived from the recipient plus the sorted item ids.

const crypto = require("node:crypto");
const { INDEX_URL } = require("./_creditcards");

// The Perks view of the index: the filter script opens it from this hash.
const PERKS_URL = `${INDEX_URL}#perks`;

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

// Only http(s) links reach an href. The data file is human-written, but a
// javascript: or data: URL slipping through review would otherwise ship in
// every subscriber's inbox.
function safeUrl(u, fallback = PERKS_URL) {
  return /^https?:\/\//i.test(String(u || "")) ? String(u) : fallback;
}

// "1 October 2026", in UK time, for the email's header.
function formatDate(now) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(now);
}

// "26 Sept", for a perk's own dates (YYYY-MM-DD, UTC, as perks[] stores them).
function shortDate(iso) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

// --- Selection ---------------------------------------------------------------------

/**
 * What an alert lists: perks not sent before that haven't ended. A perk that
 * was over before anyone could hear about it is never worth an email. Open
 * first, then status unknown (no end date given, or not started yet), then by
 * start date and name, so the order is stable between runs.
 */
function selectNew(perks, sentIds) {
  const sent = new Set(sentIds || []);
  const rank = { open: 0, unknown: 1 };
  return (perks || [])
    .filter((p) => p && p.id && p.status !== "ended" && !sent.has(p.id))
    .sort(
      (a, b) =>
        (rank[a.status] ?? 2) - (rank[b.status] ?? 2) ||
        String(a.start || "").localeCompare(String(b.start || "")) ||
        String(a.project).localeCompare(String(b.project)),
    );
}

/** "1 new perk for Credits holders" / "3 new perks ...". Never called with 0. */
function buildSubject(items) {
  const n = items.length;
  return `${n} new ${n === 1 ? "perk" : "perks"} for Credits holders`;
}

/** "Until 26 Sept" while a stated end is ahead, "From 3 Oct" before a start. */
function when(p, now) {
  const today = now.toISOString().slice(0, 10);
  if (p.end && p.end >= today) return `Until ${shortDate(p.end)}`;
  if (p.start && p.start > today) return `From ${shortDate(p.start)}`;
  return "";
}

/** Same recipient + same items = same key, so a retried or overlapping send
 * is deduplicated by Resend (24h window), while a different alert is not. */
function idempotencyKey(to, items) {
  const ids = items.map((p) => p.id).sort().join(",");
  return crypto.createHash("sha256").update(`creditcards-perks\n${to}\n${ids}`).digest("hex").slice(0, 40);
}

// --- Email ---------------------------------------------------------------------------

const monoStyle = (size, color, extra = "") =>
  `font-family:${MONO};font-size:${size}px;line-height:1.5;text-transform:uppercase;letter-spacing:0.12em;color:${color};${extra}`;

function renderPips() {
  return C.pips
    .map((c) => `<span style="display:inline-block;width:7px;height:7px;background:${c};margin-right:2px;vertical-align:middle;font-size:0;line-height:0;">&nbsp;</span>`)
    .join("");
}

function renderItem(p, last, now) {
  const chip = p.typeLabel
    ? ` <span style="${monoStyle(10, C.paper, `background:${C.black};border-radius:980px;padding:3px 8px;white-space:nowrap;vertical-align:middle;`)}">${escapeHtml(p.typeLabel)}</span>`
    : "";
  const post = p.post ? `<a href="${escapeHtml(safeUrl(p.post))}" style="color:${C.muted};">The announcement &rarr;</a>` : "";
  const meta = [when(p, now), p.x ? `By @${escapeHtml(p.x)}` : "", post].filter(Boolean).join(" &middot; ");
  return `<tr><td style="padding:20px 0;${last ? "" : `border-bottom:1px solid ${C.hairline};`}">
<p style="margin:0 0 8px;line-height:1.3;"><span aria-hidden="true">${renderPips()}</span> <a href="${escapeHtml(safeUrl(p.url))}" style="font-family:${SERIF};font-size:22px;color:${C.black};text-decoration:none;vertical-align:middle;">${escapeHtml(p.project)}</a>${chip}</p>
${p.description ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink};">${escapeHtml(p.description)}</p>` : ""}
${p.eligibility ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:14px;line-height:1.45;color:${C.ink};"><span style="${monoStyle(10, C.mutedSmall, "margin-right:6px;")}">For</span>${escapeHtml(p.eligibility)}</p>` : ""}
${meta ? `<p style="margin:0;${monoStyle(10, C.muted)}">${meta}</p>` : ""}
</td></tr>`;
}

/**
 * The frame every Credit Cards email shares (the perk alert and the welcome):
 * self-contained, table-based HTML so it holds up in Gmail, Apple Mail and
 * Outlook, readable on a phone (one 600px column that shrinks). `body` is the
 * already-escaped content of the white card; the frame adds the head, the
 * preheader, the All perks / Manage / Unsubscribe row and the footer.
 * `manageUrl` is the recipient's signed portal link: Manage and Unsubscribe
 * both go there, because cancelling IS unsubscribing (Stripe is the list).
 */
function renderShell({ title, preheader, body, manageUrl, indexUrl = PERKS_URL }) {
  const manage = escapeHtml(manageUrl || indexUrl);
  const index = escapeHtml(indexUrl);
  const link = `color:${C.muted};`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.ground};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ground};">
<tr><td align="center" style="padding:32px 12px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${C.paper};border:1px solid #e2e2e0;border-radius:10px;">
<tr><td style="padding:32px 28px 26px;font-family:${SANS};color:${C.ink};">
${body}
<p style="margin:10px 0 0;${monoStyle(10, C.muted)}"><a href="${index}" style="${link}">All perks</a> &middot; <a href="${manage}" style="${link}">Manage</a> &middot; <a href="${manage}" style="${link}">Unsubscribe</a></p>
</td></tr>
</table>
<p style="margin:20px 0 0;text-align:center;${monoStyle(10, C.foot, "letter-spacing:0.14em;")}">Mooch &middot; Unofficial fan index, not affiliated with Jack Butcher</p>
</td></tr>
</table>
</body>
</html>`;
}

/** The perk alert: the new perks, in the shared frame. */
function buildEmailHtml(items, { now = new Date(), manageUrl, indexUrl = PERKS_URL } = {}) {
  const n = items.length;
  const noun = n === 1 ? "perk" : "perks";
  const index = escapeHtml(indexUrl);
  const rows = items.map((p, i) => renderItem(p, i === n - 1, now)).join("\n");
  const body = `<p style="margin:0;${monoStyle(10, C.muted, "letter-spacing:0.14em;")}">Credit Cards &middot; Perk alert &middot; ${escapeHtml(formatDate(now))}</p>
<h1 style="margin:16px 0 6px;font-family:${SERIF};font-weight:400;font-size:34px;line-height:1.05;letter-spacing:-0.01em;color:${C.black};">${n} new <em style="font-style:italic;">${noun}.</em></h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${C.mutedSmall};">For Credits holders, found since the last scan. <a href="${index}" style="color:${C.ink};">See every perk &rarr;</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.hairline};border-bottom:1px solid ${C.hairline};">
${rows}
</table>
<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:${C.muted};">Check the builder's own post before you connect a wallet. You pay for this, so we keep it honest: no sponsors in the email, ever. Reply and a human answers.</p>`;
  return renderShell({ title: buildSubject(items), preheader: items.map((p) => p.project).join(", "), body, manageUrl, indexUrl });
}

/** Plain-text part. Mail clients that block HTML, and spam filters, both
 * read this, so it carries the same items and the same links. */
function buildEmailText(items, { now = new Date(), manageUrl, indexUrl = PERKS_URL } = {}) {
  const lines = [`CREDIT CARDS · PERK ALERT · ${formatDate(now)}`, "", buildSubject(items) + ".", ""];
  for (const p of items) {
    lines.push(`${p.project}${p.typeLabel ? ` (${p.typeLabel})` : ""}`);
    if (p.description) lines.push(p.description);
    if (p.eligibility) lines.push(`For: ${p.eligibility}`);
    lines.push(safeUrl(p.url));
    const meta = [when(p, now), p.x ? `By @${p.x}` : "", p.post ? `The announcement: ${safeUrl(p.post)}` : ""].filter(Boolean);
    if (meta.length) lines.push(meta.join(" · "));
    lines.push("");
  }
  lines.push("Check the builder's own post before you connect a wallet. You pay for this, so we keep it honest: no sponsors in the email, ever. Reply and a human answers.", "");
  lines.push(`All perks: ${indexUrl}`, `Manage or unsubscribe: ${manageUrl || indexUrl}`);
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
 * One alert run, side effects injected:
 *   loadPerks()           -> perks[], each decorated with status + typeLabel
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
 *   - No stored state at all: this is the first run. Record every perk id as
 *     sent and email nobody, or launch day would mail perks that are already
 *     on the page to the first subscriber.
 *   - Nothing new: skip silently. Most days land here.
 *   - New perks but no subscribers: record them as sent, so the first
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
 * perk for good. The alternative was worse: one address that fails every day
 * would hold state forever, and every other subscriber would get the same
 * growing alert again each morning. The count is in the run summary
 * (failedRecipients) so it shows in the cron log.
 */
async function runDigest({ now = new Date(), loadPerks, loadState, saveState, listRecipients, manageUrlFor, send }) {
  const perks = await loadPerks();
  const state = await loadState();

  if (!state) {
    const ids = perks.filter((p) => p && p.id).map((p) => p.id);
    await saveState((current) => mergeState(current, ids, now));
    return { ok: true, skipped: true, reason: "first run: seeded state, sent nothing", seeded: ids.length };
  }

  const items = selectNew(perks, state.sentIds);
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
  PERKS_URL,
  C,
  SERIF,
  monoStyle,
  renderItem,
  renderShell,
  escapeHtml,
  safeUrl,
  formatDate,
  selectNew,
  buildSubject,
  when,
  idempotencyKey,
  buildEmailHtml,
  buildEmailText,
  mergeState,
  runDigest,
};
