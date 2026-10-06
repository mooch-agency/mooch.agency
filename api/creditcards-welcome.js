// Stripe webhook target: the Credit Cards welcome email.
//
//   POST, Stripe-Signature header  ->  200 { ok, ... } | 400 | 5xx (Stripe retries)
//
// Registered in Stripe (Developers > Webhooks) for checkout.session.completed
// only, pointing at https://mooch.agency/api/creditcards-welcome. When a
// perk-alert Checkout completes, this sends the subscriber one confirmation
// email through Resend. Without it, a sign-up on a 100% promotion code got no
// email at all: Stripe sends receipts only when it charges a card.
//
// This file is only the transport: read the raw body, verify Stripe's
// signature, then hand the event to runWelcome (api/_creditcards-welcome.js),
// which holds the rules and is unit-tested without Stripe or Resend.
//
// Retries: a 5xx makes Stripe redeliver (it backs off over three days). The
// Resend Idempotency-Key is the Checkout session id, so a redelivery within
// 24h of a send that did land is dropped by Resend rather than sent twice.
//
// Env (Vercel `mooch.agency` project, none committed):
//   STRIPE_WEBHOOK_SECRET  whsec_..., this endpoint's signing secret in Stripe
//   STRIPE_SECRET_KEY      reads the subscription, signs the portal link
//   STRIPE_PRICE_ID        only subscriptions on this price are welcomed
//   RESEND_API_KEY         sends as mb@mooch.agency

const { getStripe, portalUrl, makeSender, loadPerks } = require("./_creditcards");
const { runWelcome } = require("./_creditcards-welcome");

// A Checkout event is a few kilobytes; anything near this is not Stripe.
const MAX_BODY_BYTES = 512 * 1024;

/** The exact bytes Stripe signed. Read straight off the request stream and
 * never via req.body: Vercel parses that lazily on first access, and a
 * re-serialised JSON body no longer matches the signature. */
async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method" });
  }

  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const price = process.env.STRIPE_PRICE_ID;
  if (!stripe || !webhookSecret || !price) {
    // 503, not 200: Stripe keeps the event and redelivers once the env is fixed.
    console.error("creditcards-welcome: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET or STRIPE_PRICE_ID is not set");
    return res.status(503).json({ error: "unavailable" });
  }

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, String(req.headers["stripe-signature"] || ""), webhookSecret);
  } catch (e) {
    // A bad or missing signature is anyone but Stripe: refuse, log the type only.
    const status = (e && e.status) || 400;
    console.error("creditcards-welcome: rejected delivery", status, e && e.type);
    return res.status(status).json({ error: "signature" });
  }

  try {
    const result = await runWelcome({
      event,
      price,
      retrieveSubscription: (id) => stripe.subscriptions.retrieve(id),
      loadPerks: () => loadPerks(),
      manageUrlFor: (customerId) => portalUrl(customerId, process.env.STRIPE_SECRET_KEY),
      send: makeSender(process.env.RESEND_API_KEY),
    });
    if (!result.ok) {
      console.error("creditcards-welcome: send failed", result.retry ? "(will retry)" : "(final)", result.error);
      return res.status(result.retry ? 502 : 200).json({ ok: false, retry: result.retry });
    }
    return res.status(200).json(result);
  } catch (e) {
    // Stripe or the feed failed before any send: let Stripe redeliver.
    console.error("creditcards-welcome: run threw", e && (e.type || e.name));
    return res.status(500).json({ ok: false, retry: true });
  }
};

// Exported for tests only.
module.exports.__testables = { readRawBody };
