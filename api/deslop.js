// Vercel serverless function: /deslop as a paid endpoint for agents, over
// x402 (HTTP 402 Payment Required). POST { text }, pay ~$0.10 in USDC, get
// back { cleaned, changelog } — the same prompt the free page publishes, so
// the page stays the single source of truth (see loadSystemPrompt below).
//
// Flow (x402 v1, same wire contract as Coinbase's x402-express middleware):
//   1. No X-PAYMENT header  -> 402 JSON { x402Version, accepts: [...] }
//   2. X-PAYMENT present    -> facilitator /verify -> run the model ->
//                              facilitator /settle -> 200 + X-PAYMENT-RESPONSE
// Settlement happens after the model call succeeds, so a failed run never
// takes the money.
//
// Config (Vercel env):
//   X402_PAY_TO          receiving wallet address. UNSET => endpoint replies
//                        503 "not configured". This is the one manual step.
//   X402_NETWORK         "base-sepolia" (default, testnet) or "base" (mainnet).
//   X402_FACILITATOR_URL override the facilitator base URL. Default is
//                        network-dependent: x402.org's keyless testnet
//                        facilitator for base-sepolia, Coinbase CDP's
//                        facilitator for base (see CDP_API_KEY_ID below).
//   CDP_API_KEY_ID        \
//   CDP_API_KEY_SECRET     } CDP Secret API key (portal.cdp.coinbase.com ->
//                             API Keys -> Secret API Keys). Only read when
//                             NETWORK is "base" — CDP's facilitator requires
//                             authenticated requests, unlike the testnet one.
//   DESLOP_PRICE_USD     default "0.10".
//   DESLOP_MODEL         default "claude-sonnet-5".
//   DESLOP_KILL=1        kill switch, same convention as the other functions.
//
// Cost controls, same shape as api/say-less.js: word cap, conservative
// max_tokens, per-instance rate limit, kill switch. No origin check: agents
// are the audience and payment is the gate.

const fs = require("fs");
const path = require("path");
const { exact } = require("x402/schemes");
const { useFacilitator } = require("x402/verify");
const { processPriceToAtomicAmount, findMatchingPaymentRequirements, toJsonSafe } = require("x402/shared");
const { settleResponseHeader } = require("x402/types");
const { getAuthHeaders } = require("@coinbase/cdp-sdk/auth");

const MODEL = process.env.DESLOP_MODEL || "claude-sonnet-5";
const PRICE = process.env.DESLOP_PRICE_USD || "0.10";
const NETWORK = process.env.X402_NETWORK || "base-sepolia";

// x402.org's facilitator is keyless and testnet-only. CDP's facilitator
// needs authenticated requests (below), so mainnet gets a different default.
const DEFAULT_FACILITATOR_URL = NETWORK === "base"
  ? "https://api.cdp.coinbase.com/platform/v2/x402"
  : "https://x402.org/facilitator";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR_URL;
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

// CDP's facilitator authenticates each call with a short-lived JWT bound to
// the method + host + path being called, not a static bearer token — so
// this has to run per-request, per-operation, not once at module load.
async function createCdpAuthHeaders() {
  const url = new URL(FACILITATOR_URL);
  async function headersFor(operation, method) {
    return getAuthHeaders({
      apiKeyId: CDP_API_KEY_ID,
      apiKeySecret: CDP_API_KEY_SECRET,
      requestMethod: method,
      requestHost: url.host,
      requestPath: `${url.pathname}/${operation}`,
    });
  }
  return {
    verify: await headersFor("verify", "POST"),
    settle: await headersFor("settle", "POST"),
    supported: await headersFor("supported", "GET"),
  };
}
const MAX_TOKENS = 4000;
const WORD_CAP = 2000;            // a post, not a book
const RATE_PER_MIN = 10;          // paid calls, but still cap runaway loops
const X402_VERSION = 1;

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (rec.length >= RATE_PER_MIN) { hits.set(ip, rec); return true; }
  rec.push(now);
  hits.set(ip, rec);
  return false;
}

// verify() is a read-only check: it does not spend the payment's nonce, only
// settle() does, on-chain. Without this, the same signed X-PAYMENT header
// replayed across concurrent requests passes verify() every time and
// triggers a paid model call for each one, before settle() finally rejects
// all but the first as already spent. Track nonces we've already accepted
// for processing so a duplicate is rejected before it costs an LLM call.
// Same per-instance caveat as the rate limiter above: good enough to stop
// casual replay, not a substitute for settle() being the real source of truth.
const seenNonces = new Map(); // nonce -> "in-flight" | "settled"
const NONCE_TTL_MS = 10 * 60_000; // matches the ballpark of a payment's own validity window
function pruneNonces() {
  const now = Date.now();
  for (const [n, v] of seenNonces) if (now - v.at > NONCE_TTL_MS) seenNonces.delete(n);
}
function claimNonce(nonce) {
  pruneNonces();
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, { at: Date.now() });
  return true;
}
function releaseNonce(nonce) {
  seenNonces.delete(nonce);
}

// Same shape as api/rewrite.js and api/feedback.js: Vercel's Node runtime
// usually pre-parses JSON into req.body, but only when the request arrives
// with an exact application/json content-type. A caller that sends valid
// JSON without that header gets a raw string here, not an object, so parse
// it ourselves rather than silently treating it as an empty body.
function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return {};
}

// The published prompt on /prompts/deslop is canonical. Read it out of the
// page rather than duplicating it here, so a prompt edit ships to both the
// page and the API in one change. (vercel.json includeFiles bundles the page.)
let systemPrompt = null;
function loadSystemPrompt() {
  if (systemPrompt) return systemPrompt;
  const page = fs.readFileSync(path.join(process.cwd(), "prompts", "deslop.html"), "utf8");
  const m = page.match(/<pre id="prompt-text">([\s\S]*?)<\/pre>/);
  if (!m) throw new Error("prompt-text block not found in prompts/deslop.html");
  systemPrompt = m[1]
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return systemPrompt;
}

function totalWords(text) {
  return String(text || "").split(/\s+/).filter((w) => /[0-9A-Za-z]/.test(w)).length;
}

function buildPaymentRequirements(req) {
  const priced = processPriceToAtomicAmount(PRICE, NETWORK);
  if ("error" in priced) throw new Error(priced.error);
  const { maxAmountRequired, asset } = priced;
  const host = req.headers["x-forwarded-host"] || req.headers.host || "mooch.agency";
  return [{
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired,
    resource: `https://${host}/api/deslop`,
    description: "Remove the red flags of AI writing. POST { text }, get back { cleaned, changelog }. By Mooch (mooch.agency).",
    mimeType: "application/json",
    payTo: process.env.X402_PAY_TO,
    maxTimeoutSeconds: 120,
    asset: asset.address,
    outputSchema: {
      input: {
        type: "http",
        method: "POST",
        discoverable: true,
        bodyType: "json",
        bodyFields: { text: "string, the draft to deslop, up to 2000 words" },
      },
      output: { cleaned: "string", changelog: "string" },
    },
    extra: asset.eip712,
  }];
}

function reply402(res, accepts, error) {
  res.status(402).json({ x402Version: X402_VERSION, error, accepts: toJsonSafe(accepts) });
}

async function runDeslop(text) {
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: loadSystemPrompt(),
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("anthropic error", upstream.status, detail.slice(0, 500));
    throw new Error("model_error");
  }
  const data = await upstream.json();
  const full = (data.content || []).map((b) => b.text || "").join("");
  // The prompt's output format is "**Cleaned draft** ... **Changelog** ...".
  // Try the exact heading first, then a looser match (different emphasis,
  // a colon, a markdown heading) so a minor model formatting drift doesn't
  // silently ship an empty changelog on a call the caller paid for. If
  // nothing matches, ship the whole thing as cleaned rather than failing.
  let split = full.split(/\*\*Changelog\*\*/i);
  if (split.length === 1) split = full.split(/#{1,3}\s*changelog:?/i);
  return {
    cleaned: split[0].replace(/^\s*\*\*Cleaned draft\*\*\s*/i, "").replace(/^#{1,3}\s*Cleaned draft:?\s*/i, "").trim(),
    changelog: (split[1] || "").trim(),
  };
}

module.exports = async (req, res) => {
  // Meant for the open agent ecosystem, not just same-origin callers: allow
  // any origin, and let a browser-based agent client past the preflight its
  // fetch triggers for the custom X-PAYMENT header.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "POST only. Body: { \"text\": \"...\" }" });
  }
  if (process.env.DESLOP_KILL === "1") {
    return res.status(503).json({ error: "Endpoint paused." });
  }
  if (!process.env.X402_PAY_TO) {
    return res.status(503).json({ error: "Payments not configured yet. Try again soon." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set");
    return res.status(503).json({ error: "Endpoint misconfigured. Try again soon." });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "Slow down. 10 calls a minute." });

  let accepts;
  try { accepts = buildPaymentRequirements(req); }
  catch (e) { console.error(e); return res.status(500).json({ error: "Pricing failed." }); }

  const paymentHeader = req.headers["x-payment"];
  if (!paymentHeader) return reply402(res, accepts, "X-PAYMENT header is required");

  let decoded;
  try {
    decoded = exact.evm.decodePayment(paymentHeader);
    decoded.x402Version = X402_VERSION;
  } catch (e) {
    return reply402(res, accepts, "Invalid or malformed payment header");
  }
  const selected = findMatchingPaymentRequirements(accepts, decoded);
  if (!selected) return reply402(res, accepts, "Unable to find matching payment requirements");

  // Claim the nonce before doing any paid work. verify() alone doesn't spend
  // it, so without this a replayed X-PAYMENT header across concurrent
  // requests would trigger a paid model call per request before settle()
  // finally rejects all but one as already spent.
  const nonce = decoded.payload && decoded.payload.authorization && decoded.payload.authorization.nonce;
  if (nonce && !claimNonce(nonce)) {
    return reply402(res, accepts, "Payment already used or in progress");
  }
  const releaseOnFailure = () => { if (nonce) releaseNonce(nonce); };

  const useCdpAuth = NETWORK === "base" && CDP_API_KEY_ID && CDP_API_KEY_SECRET;
  const { verify, settle } = useFacilitator({
    url: FACILITATOR_URL,
    ...(useCdpAuth ? { createAuthHeaders: createCdpAuthHeaders } : {}),
  });
  try {
    const v = await verify(decoded, selected);
    if (!v.isValid) { releaseOnFailure(); return reply402(res, accepts, v.invalidReason || "Payment invalid"); }
  } catch (e) {
    console.error("verify error", e);
    releaseOnFailure();
    return reply402(res, accepts, "Payment verification failed");
  }

  // Payment verified. Do the work BEFORE settling, so a model failure costs
  // the caller nothing.
  const text = String(parseBody(req).text || "");
  const words = totalWords(text);
  if (!words) { releaseOnFailure(); return res.status(400).json({ error: "Body must be JSON: { \"text\": \"...\" }" }); }
  if (words > WORD_CAP) {
    releaseOnFailure();
    return res.status(400).json({ error: `Too long: ${words} words, cap is ${WORD_CAP}.` });
  }

  let result;
  try { result = await runDeslop(text); }
  catch (e) { releaseOnFailure(); return res.status(502).json({ error: "The editor choked. You were not charged." }); }

  try {
    const s = await settle(decoded, selected);
    if (!s.success) { releaseOnFailure(); return reply402(res, accepts, s.errorReason || "Payment settlement failed"); }
    res.setHeader("X-PAYMENT-RESPONSE", settleResponseHeader(s));
  } catch (e) {
    console.error("settle error", e);
    releaseOnFailure();
    return reply402(res, accepts, "Payment settlement failed");
  }
  // Settled: leave the nonce marked as seen for the rest of its TTL so a
  // stray duplicate request with the same (now-spent) header gets an
  // instant, cheap rejection instead of a wasted verify() round trip.

  return res.status(200).json({
    cleaned: result.cleaned,
    changelog: result.changelog,
    words_in: words,
    words_out: totalWords(result.cleaned),
    price: `$${PRICE} USDC on ${NETWORK}`,
  });
};
