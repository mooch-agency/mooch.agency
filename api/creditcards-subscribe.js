// Vercel serverless function: start a Credit Cards perk-alert subscription.
//
//   POST { email }  ->  { url }   (a Stripe Checkout URL; the page redirects)
//
//   POST { email }  ->  { already: true, message }  when that address already
//                       has a live standing order (no Checkout opened)
//
// Checkout runs in subscription mode on STRIPE_PRICE_ID ($8 a month, the
// launch price), charged up front: no free trial (dropped 1 Oct 2026).
// Stripe creates the customer from customer_email, and that customer's
// subscription IS the subscriber record: there is no database
// (api/creditcards-digest.js reads the list straight back from Stripe).
//
// Two callers, one endpoint:
//   - The band's script posts JSON and gets JSON back.
//   - With JavaScript off, the same <form> posts form-encoded here and gets a
//     303 straight to Checkout, or a short plain page on error. That is the
//     progressive enhancement: the band works with no script at all.
//
// Guards, in order: method, Origin (required, as api/axbeat-lead.js), per-IP
// rate limit, email syntax, then the already-subscribed check. Stripe itself
// is the real gate: nothing is owed until someone enters a card on Stripe's
// page.
//
// Env (Vercel `mooch.agency` project, none committed):
//   STRIPE_SECRET_KEY   sk_test_... while testing, sk_live_... at launch
//   STRIPE_PRICE_ID     the recurring $8/month price (price_...)
// Either missing -> 503, so the band can be shipped before Stripe is set up.

const { INDEX_URL, normaliseEmail, getStripe, originAllowed, clientIp, makeRateLimiter } = require("./_creditcards");
const { escapeHtml } = require("./_creditcards-digest");

const ALREADY_MESSAGE = "That address already has a standing order. Manage it from the link in any scan email.";

/**
 * Where Stripe sends people back: production, unless the (already validated)
 * Origin is a dev server or a Vercel preview, in which case that deployment,
 * so a preview can be tested end to end instead of landing on the live page.
 * Stripe only redirects to the URL it was given, so this is decided here.
 */
function returnIndexUrl(origin) {
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h.endsWith(".vercel.app")) return `${u.origin}/creditcards`;
  } catch {}
  return INDEX_URL;
}

/** The Checkout session we open. Pulled out so the test can pin its shape,
 * in particular that no trial creeps back in. The two return states are the
 * ones the band knows how to render: ?subscribed=1, or the plain page. */
function checkoutParams(email, price, indexUrl = INDEX_URL) {
  return {
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    customer_email: email,
    success_url: `${indexUrl}?subscribed=1`,
    cancel_url: indexUrl,
  };
}

/**
 * Does this address already have a live (active or trialing) subscription on
 * our price? Checkout with customer_email makes a NEW customer every time, so
 * without this a second sign-up would bill the same person twice, and the
 * digest's one Manage link would only ever reach one of the two.
 *
 * Stripe's customers.list email filter is case-sensitive, so this tries the
 * address as typed and fully lowercased. Someone who first signed up as
 * "Jo@x.com" and now types "JO@x.com" still slips through; good enough here.
 *
 * Accepted trade-off (Tahi, 1 Oct 2026): this answer differs by address, so
 * anyone can learn whether an email has a standing order. The stakes are an
 * $8 newsletter, and the per-IP rate limit above caps how fast anyone can ask.
 */
async function hasStandingOrder(stripe, email, price) {
  for (const address of [...new Set([email, email.toLowerCase()])]) {
    const customers = await stripe.customers.list({ email: address, limit: 10 });
    for (const c of customers.data || []) {
      const subs = await stripe.subscriptions.list({ customer: c.id, price, limit: 10 });
      if ((subs.data || []).some((s) => s.status === "active" || s.status === "trialing")) return true;
    }
  }
  return false;
}

// Opening Checkout costs nothing, but a loop could still fill the Stripe
// dashboard with abandoned sessions. Generous for a person, tight for a script.
const limited = makeRateLimiter({ perMin: 5, perDay: 20 });

function wantsForm(req) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  return type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data");
}

// One failure shape for both callers. The no-JS page is deliberately bare:
// it only has to say what went wrong and point back at the band.
function page(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const safe = escapeHtml(message);
  return res.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Credit Cards</title><p>${safe}</p><p><a href="/creditcards#subscribe">Back to Credit Cards</a></p></html>`,
  );
}

function fail(res, asForm, status, error, message) {
  if (asForm) return page(res, status, message);
  return res.status(status).json({ ok: false, error, message });
}

module.exports = async (req, res) => {
  const asForm = wantsForm(req);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, asForm, 405, "method", "Use the form on the Credit Cards page.");
  }

  // Required, not just checked when present: every browser sends Origin on a
  // POST, so a missing one is a script, which is the caller to turn away.
  const origin = req.headers.origin || "";
  if (!origin || !originAllowed(origin, req.headers.host)) {
    return fail(res, asForm, 403, "origin", "Use the form on the Credit Cards page.");
  }

  if (limited(clientIp(req))) {
    return fail(res, asForm, 429, "rate", "That's a lot of tries. Wait a minute, then try again.");
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const email = normaliseEmail(body && body.email);
  if (!email) {
    return fail(res, asForm, 400, "email", "That email address doesn't look right. Check it and try again.");
  }

  const stripe = getStripe();
  const price = process.env.STRIPE_PRICE_ID;
  if (!stripe || !price) {
    console.error("creditcards-subscribe: STRIPE_SECRET_KEY or STRIPE_PRICE_ID is not set");
    return fail(res, asForm, 503, "unavailable", "Subscriptions aren't open yet. Email hey@mooch.agency and we'll let you know when they are.");
  }

  let session;
  try {
    if (await hasStandingOrder(stripe, email, price)) {
      if (asForm) return page(res, 200, ALREADY_MESSAGE);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ already: true, message: ALREADY_MESSAGE });
    }
    session = await stripe.checkout.sessions.create(checkoutParams(email, price, returnIndexUrl(origin)));
  } catch (e) {
    // Type and code only: Stripe's message can echo request details, and
    // nothing here should ever print a key or a customer's address.
    console.error("creditcards-subscribe: Stripe checkout failed", e && e.type, e && e.code);
    return fail(res, asForm, 502, "checkout", "Checkout didn't open. Give it a minute and try again.");
  }

  if (asForm) {
    res.statusCode = 303;
    res.setHeader("Location", session.url);
    res.setHeader("Cache-Control", "no-store");
    return res.end();
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ url: session.url });
};

// Exported for tests only.
module.exports.__testables = { checkoutParams, returnIndexUrl, hasStandingOrder, ALREADY_MESSAGE };
