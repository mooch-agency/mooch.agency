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
//   X402_FACILITATOR_URL default https://x402.org/facilitator (testnet, keyless).
//                        Mainnet: Coinbase CDP facilitator (needs CDP keys) or
//                        another facilitator URL.
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

const MODEL = process.env.DESLOP_MODEL || "claude-sonnet-5";
const PRICE = process.env.DESLOP_PRICE_USD || "0.10";
const NETWORK = process.env.X402_NETWORK || "base-sepolia";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
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
  // Split on the changelog heading; if the model varied, ship the whole thing
  // as cleaned rather than failing a paid call over formatting.
  const split = full.split(/\*\*Changelog\*\*/i);
  return {
    cleaned: split[0].replace(/^\s*\*\*Cleaned draft\*\*\s*/i, "").trim(),
    changelog: (split[1] || "").trim(),
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only. Body: { \"text\": \"...\" }" });
  }
  if (process.env.DESLOP_KILL === "1") {
    return res.status(503).json({ error: "Endpoint paused." });
  }
  if (!process.env.X402_PAY_TO) {
    return res.status(503).json({ error: "Payments not configured yet. Try again soon." });
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

  const { verify, settle } = useFacilitator({ url: FACILITATOR_URL });
  try {
    const v = await verify(decoded, selected);
    if (!v.isValid) return reply402(res, accepts, v.invalidReason || "Payment invalid");
  } catch (e) {
    console.error("verify error", e);
    return reply402(res, accepts, "Payment verification failed");
  }

  // Payment verified. Do the work BEFORE settling, so a model failure costs
  // the caller nothing.
  const text = String((req.body && req.body.text) || "");
  const words = totalWords(text);
  if (!words) return res.status(400).json({ error: "Body must be JSON: { \"text\": \"...\" }" });
  if (words > WORD_CAP) {
    return res.status(400).json({ error: `Too long: ${words} words, cap is ${WORD_CAP}.` });
  }

  let result;
  try { result = await runDeslop(text); }
  catch (e) { return res.status(502).json({ error: "The editor choked. You were not charged." }); }

  try {
    const s = await settle(decoded, selected);
    if (!s.success) return reply402(res, accepts, s.errorReason || "Payment settlement failed");
    res.setHeader("X-PAYMENT-RESPONSE", settleResponseHeader(s));
  } catch (e) {
    console.error("settle error", e);
    return reply402(res, accepts, "Payment settlement failed");
  }

  return res.status(200).json({
    cleaned: result.cleaned,
    changelog: result.changelog,
    words_in: words,
    words_out: totalWords(result.cleaned),
    price: `$${PRICE} USDC on ${NETWORK}`,
  });
};
