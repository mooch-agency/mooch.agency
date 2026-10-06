// The Credit Cards welcome email, minus its transport. Pure, or with its side
// effects injected (runWelcome), like _creditcards-digest.js, so
// scripts/creditcards-welcome.test.mjs covers it with no keys and no network.
// api/creditcards-welcome.js wires in the real Stripe and Resend calls.
//
// Why it exists (6 Oct 2026): Stripe only emails a receipt when it charges a
// card, so a sign-up on a 100% promotion code heard nothing at all, and the
// on-page confirmation is easy to miss or close. Every new standing order
// now gets one email from us saying it worked, with what is open right now.

const crypto = require("node:crypto");
const { normaliseEmail } = require("./_creditcards");
const { PERKS_URL, C, SERIF, monoStyle, escapeHtml, renderItem, renderShell, selectNew } = require("./_creditcards-digest");

const SUBJECT = "You're subscribed to Credit Cards perk alerts";
const LEAD = "We'll email you when a new perk for Credits holders goes up. No email means nothing new.";
const BILLING =
  "Billing runs through Stripe: change your card or cancel any time from the links below. Check the builder's own post before you connect a wallet. Reply and a human answers.";

// --- Who to welcome -----------------------------------------------------------------

/**
 * The person to welcome from a Stripe event, or `{ skip }` saying why not.
 * Only a completed subscription Checkout counts; everything else Stripe might
 * send to this endpoint is acknowledged and ignored. The email comes from
 * what the buyer typed into Checkout (customer_details), falling back to the
 * address the band passed in.
 */
function welcomeTarget(event) {
  if (!event || event.type !== "checkout.session.completed") return { skip: "not a completed checkout" };
  const s = event.data && event.data.object;
  if (!s || s.mode !== "subscription" || !s.subscription) return { skip: "not a subscription checkout" };
  // "paid" or "no_payment_required" (a 100% code). "unpaid" only happens with
  // delayed payment methods, which this Checkout doesn't offer.
  if (s.payment_status === "unpaid") return { skip: "payment not settled" };
  const email = normaliseEmail((s.customer_details && s.customer_details.email) || s.customer_email);
  const customerId = typeof s.customer === "string" ? s.customer : s.customer && s.customer.id;
  if (!email || !customerId) return { skip: "no email or customer" };
  const subscriptionId = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
  return { email, customerId, subscriptionId, sessionId: s.id };
}

/** Is this a live standing order on the perk-alert price? The Stripe account
 * bills for other things too, and their buyers must never get this email. */
function onOurPrice(sub, price) {
  if (!sub || !price || (sub.status !== "active" && sub.status !== "trialing")) return false;
  const items = (sub.items && sub.items.data) || [];
  return items.some((i) => i && i.price && (typeof i.price === "string" ? i.price : i.price.id) === price);
}

/** One key per Checkout session: Stripe retries a webhook it thinks failed,
 * and Resend drops a repeat send under the same key (24h window). */
function welcomeIdempotencyKey(sessionId) {
  return crypto.createHash("sha256").update(`creditcards-welcome\n${sessionId}`).digest("hex").slice(0, 40);
}

// --- Email ---------------------------------------------------------------------------

function pastLine(endedCount) {
  return endedCount > 0 ? `${endedCount} ${endedCount === 1 ? "perk has" : "perks have"} already come and gone.` : "";
}

/**
 * The welcome, in the same frame as the perk alert. `open` is every perk
 * that hasn't ended (selectNew with nothing sent), so a new subscriber sees
 * straight away what they can still claim; none open means no list at all.
 */
function buildWelcomeHtml({ open = [], endedCount = 0, manageUrl, now = new Date(), indexUrl = PERKS_URL } = {}) {
  const index = escapeHtml(indexUrl);
  const rows = open.map((p, i) => renderItem(p, i === open.length - 1, now)).join("\n");
  const list = open.length
    ? `<p style="margin:0 0 4px;${monoStyle(10, C.mutedSmall)}">Open right now</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.hairline};border-bottom:1px solid ${C.hairline};">
${rows}
</table>
`
    : "";
  const past = pastLine(endedCount);
  const body = `<p style="margin:0;${monoStyle(10, C.muted, "letter-spacing:0.14em;")}">Credit Cards &middot; Perk alerts</p>
<h1 style="margin:16px 0 6px;font-family:${SERIF};font-weight:400;font-size:34px;line-height:1.05;letter-spacing:-0.01em;color:${C.black};">You're <em style="font-style:italic;">in.</em></h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${C.mutedSmall};">${escapeHtml(LEAD)}</p>
${list}<p style="margin:18px 0 0;font-size:15px;line-height:1.5;color:${C.ink};">${past ? `${escapeHtml(past)} ` : ""}<a href="${index}" style="color:${C.ink};">See every perk so far &rarr;</a></p>
<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:${C.muted};">${escapeHtml(BILLING)}</p>`;
  return renderShell({ title: SUBJECT, preheader: LEAD, body, manageUrl, indexUrl });
}

/** Plain-text part: same words, same links. */
function buildWelcomeText({ open = [], endedCount = 0, manageUrl, indexUrl = PERKS_URL } = {}) {
  const lines = ["CREDIT CARDS · PERK ALERTS", "", "You're in.", "", LEAD, ""];
  if (open.length) {
    lines.push("Open right now:", "");
    for (const p of open) {
      lines.push(`${p.project}${p.typeLabel ? ` (${p.typeLabel})` : ""}`);
      if (p.description) lines.push(p.description);
      if (p.eligibility) lines.push(`For: ${p.eligibility}`);
      lines.push(/^https?:\/\//i.test(String(p.url || "")) ? p.url : indexUrl, "");
    }
  }
  const past = pastLine(endedCount);
  lines.push(`${past ? `${past} ` : ""}See every perk so far: ${indexUrl}`, "", BILLING, "");
  lines.push(`Manage or unsubscribe: ${manageUrl || indexUrl}`);
  return lines.join("\n");
}

// --- The run -----------------------------------------------------------------------

/**
 * One webhook delivery, side effects injected:
 *   retrieveSubscription(id) -> the Stripe subscription, items.price expanded
 *   loadPerks()              -> perks[], each decorated with status + typeLabel
 *   manageUrlFor(customerId) -> the signed portal link
 *   send(message)            -> { ok, deduped?, error?, perRecipient? }, never throws
 *
 * Returns { ok, ... }. ok: false with retry: true means the transport should
 * answer 5xx so Stripe tries again later (Resend down, quota, network); a
 * failure about this one address (a Resend 4xx) is final, so it answers 200
 * and only logs, or Stripe would retry for three days to no end.
 */
async function runWelcome({ event, price, now = new Date(), retrieveSubscription, loadPerks, manageUrlFor, send }) {
  const target = welcomeTarget(event);
  if (target.skip) return { ok: true, skipped: target.skip };

  const sub = await retrieveSubscription(target.subscriptionId);
  if (!onOurPrice(sub, price)) return { ok: true, skipped: "not a live perk-alert subscription" };

  const perks = await loadPerks();
  const open = selectNew(perks, []);
  const endedCount = perks.filter((p) => p && p.status === "ended").length;
  const manageUrl = manageUrlFor(target.customerId);

  const result = await send({
    to: target.email,
    subject: SUBJECT,
    html: buildWelcomeHtml({ open, endedCount, manageUrl, now }),
    text: buildWelcomeText({ open, endedCount, manageUrl }),
    manageUrl,
    idempotencyKey: welcomeIdempotencyKey(target.sessionId),
  });
  if (result && result.ok) return { ok: true, sent: true, deduped: Boolean(result.deduped), open: open.length };
  return { ok: false, retry: !(result && result.perRecipient), error: (result && result.error) || "send failed" };
}

module.exports = {
  SUBJECT,
  welcomeTarget,
  onOurPrice,
  welcomeIdempotencyKey,
  buildWelcomeHtml,
  buildWelcomeText,
  runWelcome,
};
