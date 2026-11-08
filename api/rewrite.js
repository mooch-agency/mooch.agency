// Vercel serverless function: rewrite pasted prose in Paul Graham's voice.
// Streams the rewrite back over SSE, proxying the provider's stream. The API key
// stays server-side. OpenAI (gpt-5.5) is the v0.1 provider; Claude is a one-env-
// var fallback. Cost controls: word cap, conservative max_tokens, best-effort
// per-instance IP rate limit, origin check, and a kill switch.
//
// System prompt is api/pg-system.md (generated from voice/paulgraham.md +
// voice/rewrite.md by build_prompt.py). Regenerate it when either file changes.

const fs = require("fs");
const path = require("path");
const { clientAbort, pickers, pumpSSE } = require("./_stream.js");

// Provider is a config switch. Default OpenAI (gpt-5.5), the chosen voice for
// v0.1; Claude is a ready fallback so switching back is a one-env-var change.
// Both stream over SSE, so the client is provider-agnostic.
const PROVIDER = (process.env.PROVIDER || "openai").toLowerCase();
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const MAX_TOKENS = 2000;            // ceiling; output is ~500 words. Headroom so
                                    // reasoning-class OpenAI models still emit text
const WORD_CAP = 500;               // server-enforced, reject before the API
const RATE_PER_MIN = 8;             // best-effort, per warm instance
const RATE_PER_DAY = 60;
const ALLOWED_HOSTS = [
  "mooch.agency",
  "localhost",
  "127.0.0.1",
];

// Lazy + cached, so a missing/unbundled prompt returns a clean error from the
// handler rather than throwing at module load (which 500s every request).
let _system = null;
function loadSystem() {
  if (_system === null) _system = fs.readFileSync(path.join(__dirname, "pg-system.md"), "utf8");
  return _system;
}

// Best-effort in-memory limiter. Resets when the instance recycles, so it
// stops casual loops but isn't durable. The hard cost guards are the word cap,
// max_tokens, the Anthropic monthly spend ceiling, and the kill switch.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { min: [], day: [] };
  rec.min = rec.min.filter((t) => now - t < 60_000);
  rec.day = rec.day.filter((t) => now - t < 86_400_000);
  if (rec.min.length >= RATE_PER_MIN || rec.day.length >= RATE_PER_DAY) {
    hits.set(ip, rec);
    return true;
  }
  rec.min.push(now);
  rec.day.push(now);
  hits.set(ip, rec);
  return false;
}

function originOk(req) {
  const src = req.headers.origin || req.headers.referer || "";
  if (!src) return true; // non-browser clients (curl) aren't the threat; cost is
  let host;
  try { host = new URL(src).hostname; } catch { return false; }
  return (
    ALLOWED_HOSTS.includes(host) ||
    host.endsWith(".mooch.agency") ||   // www and any other mooch subdomain
    host.endsWith(".vercel.app")        // preview deployments
  );
}

function readBody(req) {
  // Vercel's Node runtime often pre-parses JSON into req.body. Use it when
  // present; otherwise read the raw stream ourselves.
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") {
    try { return Promise.resolve(JSON.parse(req.body || "{}")); } catch { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }
  if (process.env.REWRITER_DISABLED === "1") {
    res.statusCode = 503;
    return res.end("The rewriter is paused. Back shortly.");
  }
  if (!originOk(req)) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (rateLimited(ip)) {
    res.statusCode = 429;
    return res.end("Slow down a moment, then try again.");
  }

  const { text } = await readBody(req);
  if (!text || !text.trim()) {
    res.statusCode = 400;
    return res.end("Nothing to rewrite.");
  }
  const words = text.trim().split(/\s+/).length;
  if (words > WORD_CAP) {
    res.statusCode = 413;
    return res.end(`Keep it under ${WORD_CAP} words. That was ${words}.`);
  }
  const claude = PROVIDER !== "openai";
  const key = claude ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) {
    res.statusCode = 500;
    return res.end("Server missing API key.");
  }
  let system;
  try { system = loadSystem(); }
  catch (e) { res.statusCode = 500; return res.end("Server misconfigured."); }

  // Stream setup
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();

  const url = claude
    ? "https://api.anthropic.com/v1/messages"
    : "https://api.openai.com/v1/chat/completions";
  const headers = claude
    ? { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", authorization: `Bearer ${key}` };
  const body = claude
    ? { model: CLAUDE_MODEL, max_tokens: MAX_TOKENS, stream: true, system: system,
        messages: [{ role: "user", content: text.trim() }] }
    : { model: OPENAI_MODEL, max_completion_tokens: MAX_TOKENS, stream: true,
        messages: [{ role: "system", content: system }, { role: "user", content: text.trim() }] };

  const sendError = (msg) => {
    try { res.write(`event: error\ndata: ${JSON.stringify(msg)}\n\n`); } catch {}
    try { res.end(); } catch {}
  };

  // Abort the upstream call the moment the client goes away: without this a
  // closed tab still billed a full completion that nobody read.
  const guard = clientAbort(res);
  const result = await pumpSSE({
    url,
    headers,
    body,
    signal: guard.signal,
    onToken: (tok) => {
      try { res.write(`data: ${JSON.stringify(tok)}\n\n`); } catch {}
    },
    ...(claude ? pickers.claude : pickers.openaiChat),
  });
  guard.settle();

  switch (result.outcome) {
    case "aborted":
      try { res.end(); } catch {}
      return;
    case "unreachable":
      return sendError("Upstream unreachable.");
    case "http_error":
      console.error(`${PROVIDER} error`, result.status, (result.detail || "").slice(0, 500));
      return sendError("Rewrite failed. Try again.");
    case "upstream_error":
      console.error(`${PROVIDER} stream error`, result.error);
      return sendError("Rewrite failed. Try again.");
    case "timeout":
    case "interrupted":
      return sendError("Stream interrupted.");
  }

  // Clean end. A capped or unterminated stream is flagged first; the data
  // payload stays "end" because the page's parser skips that value, so older
  // copies of the page cannot render an event's data as rewrite text.
  if (result.truncated || !result.sawStop) {
    res.write("event: truncated\ndata: end\n\n");
  }
  res.write("event: done\ndata: end\n\n");
  res.end();
};
