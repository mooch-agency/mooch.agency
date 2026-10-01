// Shared helpers for the Credit Cards paid perk alerts: the subscribe, digest
// and portal endpoints all use these. The leading underscore keeps Vercel
// from deploying this file as a function of its own (same as _langsmith.js).
//
// The pipeline in one breath: /creditcards posts an email to
// api/creditcards-subscribe.js, which opens a Stripe Checkout subscription
// (paid up front, no trial). Stripe is the subscriber list: there is no database.
// A daily cron, api/creditcards-digest.js, emails each new perk for Credits
// holders to every active or trialing subscription. Each email carries a signed link to
// api/creditcards-portal.js, which opens that customer's Stripe billing
// portal (manage, cancel). See "Credit Cards alerts" in CLAUDE.md.

const crypto = require("node:crypto");

const SITE = "https://mooch.agency";
const INDEX_URL = `${SITE}/creditcards`;
const PORTAL_PATH = "/api/creditcards-portal";

// --- Email syntax --------------------------------------------------------------
//
// Syntax only, deliberately: Stripe Checkout collects a card, so a junk
// address costs whoever typed it, not us. The local-part rule matches
// api/axbeat-lead.js. Returns the address with its domain lowercased, or null.
function normaliseEmail(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (s.length > 254) return null;
  // Split on the LAST "@", as axbeat-lead does: a local part is never meant
  // to carry one unescaped, and failing safe here is free.
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1).toLowerCase();
  const localOk =
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.\-]{1,64}$/.test(local) &&
    !local.startsWith(".") &&
    !local.endsWith(".") &&
    !local.includes("..");
  // Dotted labels and a letters-only TLD: rules out "a@b", "a@localhost" and
  // "a@1.2.3.4", none of which a real subscriber types.
  const domainOk = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
  return localOk && domainOk ? `${local}@${domain}` : null;
}

// --- Stripe ----------------------------------------------------------------------
//
// Required lazily so the pure digest code and its tests never load the SDK or
// need a key. The SDK pins its own API version (stripe@23 -> 2026-09-30), so a
// package bump is the only thing that moves it: do that deliberately.
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const Stripe = require("stripe");
  return new Stripe(key, { maxNetworkRetries: 1, timeout: 10_000 });
}

// --- Signed portal links -----------------------------------------------------------
//
// The manage and unsubscribe links in each email open that customer's Stripe
// billing portal, which can cancel the subscription and change the card. So
// the link must not be guessable from a customer id or an email address: it
// carries an HMAC of the customer id. The signing key is derived from
// STRIPE_SECRET_KEY rather than a sixth env var: anyone holding that key can
// already do everything the portal can, and rotating it simply retires old
// links (they fall back to Stripe's own email-code login, nothing breaks).
//
// Trade-off, stated plainly: the link is a long-lived bearer token, so a
// forwarded digest lets the recipient manage that subscription. That is the
// same bargain every "manage subscription" email link makes.
function signingKey(secret) {
  return crypto.createHmac("sha256", secret).update("creditcards-portal-link-v1").digest();
}

function signCustomer(customerId, secret) {
  return crypto.createHmac("sha256", signingKey(secret)).update(String(customerId)).digest("hex").slice(0, 32);
}

function verifyCustomer(customerId, sig, secret) {
  if (!secret || typeof customerId !== "string" || typeof sig !== "string") return false;
  if (!/^cus_[A-Za-z0-9]{6,64}$/.test(customerId) || !/^[0-9a-f]{32}$/.test(sig)) return false;
  const expected = Buffer.from(signCustomer(customerId, secret));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function portalUrl(customerId, secret) {
  const q = new URLSearchParams({ c: customerId, s: signCustomer(customerId, secret) });
  return `${SITE}${PORTAL_PATH}?${q}`;
}

// --- Request guards ----------------------------------------------------------------

const ALLOWED_HOSTS = ["mooch.agency", "www.mooch.agency", "localhost", "127.0.0.1"];

// Same rule as api/axbeat-lead.js: the Origin host must match the host the
// request came in on (production, every preview URL, localhost) or be one of
// ours. Browsers send Origin on fetch POSTs and on form POSTs alike, so the
// no-JS form path passes this too.
function originAllowed(origin, host) {
  let originHost;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const reqHost = String(host || "").split(":")[0].toLowerCase();
  if (reqHost && originHost === reqHost) return true;
  return ALLOWED_HOSTS.includes(originHost);
}

function clientIp(req) {
  return (
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    "unknown"
  );
}

// Per-instance sliding-window limiter, the same best-effort shape as
// api/axbeat-lead.js: each warm lambda keeps its own counters, so this stops
// casual loops and nothing more. Records with nothing left in either window
// are dropped, so a warm instance doesn't hold every IP it ever saw.
function makeRateLimiter({ perMin, perDay }) {
  const DAY = 86_400_000;
  const hits = new Map();
  return function limited(key) {
    const now = Date.now();
    const rec = hits.get(key) || { min: [], day: [] };
    rec.min = rec.min.filter((t) => now - t < 60_000);
    rec.day = rec.day.filter((t) => now - t < DAY);
    const over = rec.min.length >= perMin || rec.day.length >= perDay;
    if (!over) {
      rec.min.push(now);
      rec.day.push(now);
    }
    hits.set(key, rec);
    for (const [k, r] of hits) {
      if (!r.day.some((t) => now - t < DAY)) hits.delete(k);
    }
    return over;
  };
}

module.exports = {
  SITE,
  INDEX_URL,
  PORTAL_PATH,
  normaliseEmail,
  getStripe,
  signCustomer,
  verifyCustomer,
  portalUrl,
  originAllowed,
  clientIp,
  makeRateLimiter,
};
