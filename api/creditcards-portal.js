// Vercel serverless function: manage or cancel a Credit Cards subscription.
//
//   GET ?c=<customer id>&s=<signature>  ->  302 to that customer's Stripe
//                                            billing portal session
//   GET anything else (?email= too)     ->  302 to Stripe's portal login
//                                            page, or a "check your email" page
//
// The Manage and Unsubscribe links in every digest, and its List-Unsubscribe
// header, point here with a signed customer id (see signCustomer in
// api/_creditcards.js). Cancelling in the portal ends the subscription, and
// a cancelled subscription drops off the digest's list the next morning, so
// that IS unsubscribing.
//
// No enumeration, by construction: this never looks anyone up by email, and
// never says whether an address subscribes. Without a valid signature the
// answer is the same for everyone: Stripe's own portal login (which emails a
// one-time code to the address, so only its owner gets in), prefilled with
// ?email= when one is given, or a polite page pointing at the digest's links.
//
// Env:
//   STRIPE_SECRET_KEY        creates portal sessions; also the link-signing key
//   STRIPE_PORTAL_LOGIN_URL  optional, the portal's login link
//                            (https://billing.stripe.com/p/login/...)
// Both come from the account's portal configuration, one per mode, created
// through the API on 1 Oct 2026 (ids and links in the Keystore). Session
// creation only fails when the customer was deleted or the key is missing;
// visitors then get the fallback below.

const { INDEX_URL, getStripe, normaliseEmail, verifyCustomer, clientIp, makeRateLimiter } = require("./_creditcards");

// Each valid hit creates a Stripe session; link scanners in mail clients can
// prefetch these links too, so a modest cap per IP.
const limited = makeRateLimiter({ perMin: 20, perDay: 200 });

function loginUrl(email) {
  const base = process.env.STRIPE_PORTAL_LOGIN_URL || "";
  if (!/^https:\/\/billing\.stripe\.com\//.test(base)) return null;
  if (!email) return base;
  const u = new URL(base);
  u.searchParams.set("prefilled_email", email);
  return u.toString();
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.setHeader("Cache-Control", "no-store");
  // A portal URL is a live session: keep it out of Referer headers.
  res.setHeader("Referrer-Policy", "no-referrer");
  return res.end();
}

// Same page whatever was asked, so it reveals nothing about any address.
function checkYourEmail(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Manage your Credit Cards subscription</title>
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/ui.css">
<style>
  body { margin: 0; font-family: var(--sans); background: var(--paper); color: var(--ink); line-height: 1.5; }
  main { max-width: var(--col); margin: 0 auto; padding: var(--rhythm) var(--pad-x); }
  h1 { font-family: var(--serif); font-weight: 400; font-size: clamp(36px, 5vw, 56px); line-height: 1; letter-spacing: -0.02em; color: var(--black); margin: 0 0 16px; }
  p { font-size: 17px; color: var(--muted-small); margin: 0 0 24px; max-width: 52ch; }
  a.text { color: var(--ink); border-bottom: 1px solid var(--hairline); text-decoration: none; }
</style>
</head>
<body>
<main>
  <h1>Check your email.</h1>
  <p>Every Credit Cards digest ends with a Manage link that opens your billing page, where you can change your card or cancel. Can't find one? Email <a class="text" href="mailto:hey@mooch.agency?subject=Credit%20Cards%20subscription">hey@mooch.agency</a> and a human sorts it.</p>
  <a class="ghost" href="${INDEX_URL}">Back to Credit Cards</a>
</main>
</body>
</html>`);
}

function fallback(res, email) {
  const login = loginUrl(email);
  return login ? redirect(res, login) : checkYourEmail(res);
}

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).end();
  }
  // Mail-client link checkers often HEAD a URL first: answer without
  // spending a Stripe session on them.
  if (req.method === "HEAD") return res.status(200).end();
  const q = req.query || {};
  const email = normaliseEmail(q.email);

  if (limited(clientIp(req))) return fallback(res, email);

  const secret = process.env.STRIPE_SECRET_KEY;
  const customer = typeof q.c === "string" ? q.c : "";
  if (!verifyCustomer(customer, typeof q.s === "string" ? q.s : "", secret)) return fallback(res, email);

  const stripe = getStripe();
  if (!stripe) return fallback(res, email);
  try {
    const session = await stripe.billingPortal.sessions.create({ customer, return_url: INDEX_URL });
    return redirect(res, session.url);
  } catch (e) {
    // A deleted customer, or the portal not yet configured in this mode.
    console.error("creditcards-portal: session failed", e && e.type, e && e.code);
    return fallback(res, email);
  }
};
