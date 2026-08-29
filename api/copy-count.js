// Vercel serverless function: a global, cross-visitor count of how many times
// a prompt page's copy button has actually been pressed, backed by the
// 🔢 Copy Counters database in Notion (app.notion.com/p/9aa9959e83fb4177b21e13b89564fdcc).
//
//   GET  ?slug=deslop        → { count } for that page, unchanged
//   POST { slug: "deslop" }  → increments that page's count, returns the new value
//
// Why Notion and not a proper KV store: this reuses NOTION_TOKEN, which is
// already in production for api/feedback.js, so there is no new integration to
// provision for a number nobody checks twice a day. The real cost is that a
// Notion page update is a read-then-write, not an atomic increment, so two
// copies landing in the same instant could clobber each other. At the volume
// these pages see (order of tens of copies a year) that has never happened and
// is very unlikely to; it would be the wrong trade at real scale.
//
// Slugs are a hardcoded allowlist, not user input passed through to Notion:
// each maps to a specific page id from that one-time seeding, so there is
// nothing here for a slug value to inject into.

const NOTION_VERSION = "2026-03-11";
const ALLOWED_HOSTS = ["mooch.agency", "localhost", "127.0.0.1"];

const PAGES = {
  "deslop": "3cb804529ed08134986cdeb19a30f57a",
  "soundlikeme": "3cb804529ed0815fa148cea34d1880ea",
  "say-less": "3cb804529ed081e2832ae8ac3dd6bcb9",
};

// A GET fires on every page load (cheap, read-only); a POST changes shared
// state, so it gets the tighter cap. Both are generous for a human clicking a
// button, not for a script hammering the endpoint to inflate the number.
const RATE_PER_MIN = { GET: 60, POST: 5 };
const RATE_PER_DAY = { GET: 2000, POST: 50 };

const hits = new Map();
function rateLimited(ip, method) {
  const key = `${ip}:${method}`;
  const now = Date.now();
  const rec = hits.get(key) || { min: [], day: [] };
  rec.min = rec.min.filter((t) => now - t < 60_000);
  rec.day = rec.day.filter((t) => now - t < 86_400_000);
  if (rec.min.length >= RATE_PER_MIN[method] || rec.day.length >= RATE_PER_DAY[method]) {
    hits.set(key, rec);
    return true;
  }
  rec.min.push(now);
  rec.day.push(now);
  hits.set(key, rec);
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

function readBody(req) {
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

async function notion(path, method, body) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "notion-version": NOTION_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.message) || `Notion ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function countOf(page) {
  return (page.properties && page.properties.Count && page.properties.Count.number) || 0;
}

module.exports = async function handler(req, res) {
  const method = req.method === "POST" ? "POST" : req.method === "GET" ? "GET" : null;
  if (!method) {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }
  if (!originOk(req)) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  const slug = method === "GET"
    ? String((req.query && req.query.slug) || "")
    : String((await readBody(req)).slug || "");
  const pageId = PAGES[slug];
  if (!pageId) {
    res.statusCode = 404;
    return res.end("Unknown page.");
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (rateLimited(ip, method)) {
    res.statusCode = 429;
    return res.end("Slow down a moment, then try again.");
  }
  if (!process.env.NOTION_TOKEN) {
    res.statusCode = 500;
    return res.end("Server missing Notion token.");
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (method === "GET") {
      const page = await notion(`pages/${pageId}`, "GET");
      // Read-only, so a short edge cache is free accuracy-for-load trade: a
      // burst of visitors in the same 30s window shares one Notion read.
      res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=300");
      return res.end(JSON.stringify({ count: countOf(page) }));
    }

    // POST: read current, write current + 1. Not atomic, see file header.
    const page = await notion(`pages/${pageId}`, "GET");
    const count = countOf(page) + 1;
    await notion(`pages/${pageId}`, "PATCH", { properties: { Count: { number: count } } });
    res.statusCode = 200;
    return res.end(JSON.stringify({ count }));
  } catch (e) {
    console.error("copy-count failed", slug, e && e.message);
    res.statusCode = 502;
    return res.end("Copy count unavailable.");
  }
};
