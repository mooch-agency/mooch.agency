// Vercel serverless function: ask a question, get it answered twice, live.
// Same wire contract as this repo's local tool (benchmark/serve_compare.py
// in github.com/gichigi/say-less), so the client is unmodified between the
// two: GET ?q=..., one SSE response, events {arm,delta} while streaming,
// {arm,done,words} on completion, {arm,error} on failure. Two arms run
// concurrently against the Anthropic API and interleave onto one stream,
// which is what makes "both answer at once" true rather than asserted.
//
// This demo is NOT Claude Code: no CLI, no tools, no coding context, just
// the model with or without the style as a system prompt. The page must
// say so; see the honesty note in say-less.html.
//
// Cost controls, same shape as api/rewrite.js: question word cap,
// conservative max_tokens, best-effort per-instance rate limit (halved,
// since one ask is two upstream calls), origin check, kill switch.

const SAYLESS_SYSTEM = require("./_say-less-system.js");

const MODEL = process.env.SAYLESS_MODEL || "claude-sonnet-5";
const MAX_TOKENS = 1500;           // headroom over the longest benchmark reply (~330 words)
const WORD_CAP = 200;              // a real question, not an essay pasted in
const RATE_PER_MIN = 4;            // two Anthropic calls per ask; half rewrite.js's 8/min
const RATE_PER_DAY = 30;
const PING_EVERY_MS = 2000;        // idle keep-alive; also surfaces a closed tab quickly
const ALLOWED_HOSTS = ["mooch.agency", "localhost", "127.0.0.1"];

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
  if (!src) return true; // non-browser clients aren't the cost threat; the caps are
  let host;
  try { host = new URL(src).hostname; } catch { return false; }
  return (
    ALLOWED_HOSTS.includes(host) ||
    host.endsWith(".mooch.agency") ||
    host.endsWith(".vercel.app") // preview deployments
  );
}

// Matches web/say-less.html's countWords exactly: every whitespace-run
// token containing a letter or digit, code included. Same rule the
// benchmark and the local tool use, so this page can't quietly drift from
// the published numbers.
function totalWords(text) {
  return String(text || "").split(/\s+/).filter((w) => /[0-9A-Za-z]/.test(w)).length;
}

async function streamArm(arm, system, question, write, signal) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    messages: [{ role: "user", content: question }],
  };
  if (system) body.system = system;

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    write({ arm, error: "Upstream unreachable." });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error("anthropic error", arm, upstream.status, detail.slice(0, 500));
    write({ arm, error: "Answer failed. Try again." });
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() || "";
      for (const ev of events) {
        const line = ev.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        // A mid-stream error (overloaded_error and friends) closes the
        // upstream without a further content_block_delta; without this
        // check the loop falls through to "done" below and reports a
        // truncated answer as a clean, complete one.
        if (obj.type === "error") {
          write({ arm, error: (obj.error && obj.error.message) || "Answer failed. Try again." });
          return;
        }
        if (obj.type === "content_block_delta" && obj.delta && obj.delta.text) {
          full += obj.delta.text;
          write({ arm, delta: obj.delta.text });
        }
      }
    }
  } catch (e) {
    write({ arm, error: "Stream interrupted." });
    return;
  }
  write({ arm, done: true, words: totalWords(full) });
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }
  if (process.env.SAYLESS_DISABLED === "1") {
    res.statusCode = 503;
    return res.end("The demo is paused. Back shortly.");
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

  let q = (req.query && req.query.q) ||
    new URL(req.url, "http://internal").searchParams.get("q") || "";
  if (Array.isArray(q)) q = q[0] || ""; // repeated ?q= params
  const prompt = String(q).trim();
  if (!prompt) {
    res.statusCode = 400;
    return res.end("Missing q.");
  }
  if (prompt.length > 1200) { // matches the page's own input maxlength
    res.statusCode = 413;
    return res.end("Question too long.");
  }
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (words > WORD_CAP) {
    res.statusCode = 413;
    return res.end(`Keep it under ${WORD_CAP} words. That was ${words}.`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.statusCode = 500;
    return res.end("Server missing API key.");
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();

  let closed = false;
  // A closed connection has to cancel the upstream Anthropic calls, not just
  // stop writing to a dead response: without this, Stop (or a closed tab)
  // still runs both replies to completion server-side, and Anthropic still
  // bills for tokens generated after nobody is listening.
  const controller = new AbortController();
  req.on("close", () => { closed = true; controller.abort(); });

  function write(obj) {
    if (closed) return;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { closed = true; }
  }

  // Same idle-ping purpose as serve_compare.py: a dead tab surfaces as a
  // write failure within a couple of seconds instead of at the next delta.
  const ping = setInterval(() => {
    if (closed) return;
    try { res.write(": ping\n\n"); } catch { closed = true; }
  }, PING_EVERY_MS);

  await Promise.all([
    streamArm("default", null, prompt, write, controller.signal),
    streamArm("sayless", SAYLESS_SYSTEM, prompt, write, controller.signal),
  ]);

  clearInterval(ping);
  try { res.end(); } catch {}
};
