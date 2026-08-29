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

// A key with nothing live left (its owner hasn't hit the endpoint in the last
// day) is dead weight: a warm Lambda instance can run for hours, and without
// this a record persists for every unique IP that ever visited, not just the
// ones still rate-limit-relevant. Called after each rateLimited() so the map
// only holds keys with at least one timestamp still in a live window.
function pruneDeadHits() {
  const now = Date.now();
  for (const [key, rec] of hits) {
    const liveMin = rec.min.some((t) => now - t < 60_000);
    const liveDay = rec.day.some((t) => now - t < 86_400_000);
    if (!liveMin && !liveDay) hits.delete(key);
  }
}

// Vercel replaces dots with hyphens in a project's preview subdomain, so this
// project's previews are always "mooch-agency-<something>.vercel.app" (or the
// bare "mooch-agency.vercel.app" alias). Matching on that prefix, not just
// ".vercel.app", stops any other Vercel-hosted site on the internet from
// counting as a trusted origin.
function isAllowedHost(host) {
  return (
    ALLOWED_HOSTS.includes(host) ||
    host.endsWith(".mooch.agency") ||
    host === "mooch-agency.vercel.app" ||
    (host.startsWith("mooch-agency-") && host.endsWith(".vercel.app"))
  );
}

function originOk(req, { requireHeader } = {}) {
  const src = req.headers.origin || req.headers.referer || "";
  if (!src) {
    // A GET is read-only, so a client that strips both headers (some privacy
    // browsers do) isn't worth blocking; the rate caps are the backstop for
    // it. A POST changes the public count, so it doesn't get that leniency:
    // no header means no proof of same-site, so it's rejected outright.
    return !requireHeader;
  }
  let host;
  try { host = new URL(src).hostname; } catch { return false; }
  return isAllowedHost(host);
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
  const prop = page && page.properties && page.properties.Count;
  // A missing or renamed Count property is not the same thing as a genuine
  // zero (soundlikeme legitimately starts at 0): falling back to 0 here would
  // let the POST path write 1 straight over Notion and destroy the real
  // total with no error and no way back. Fail loudly instead.
  if (!prop || typeof prop.number !== "number") {
    throw new Error("Count property missing from Notion page");
  }
  return prop.number;
}

module.exports = async function handler(req, res) {
  const method = req.method === "POST" ? "POST" : req.method === "GET" ? "GET" : null;
  if (!method) {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }
  if (!originOk(req, { requireHeader: method === "POST" })) {
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
  const limited = rateLimited(ip, method);
  pruneDeadHits();
  if (limited) {
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
      // No edge caching: this is a "live global count" precisely so a visitor
      // who just copied can reload and see it went up. A shared CDN cache
      // (even a short one) can serve a stale, lower number to that same
      // visitor or to someone else mid-window, which is worse than the cost
      // of one extra Notion read per page load - at these volumes (tens of
      // copies a year) that cost is free.
      res.setHeader("Cache-Control", "no-store");
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
    // Content-Type above already declared JSON, so a caller doing res.json()
    // must get JSON back on the error path too, not a plain string.
    return res.end(JSON.stringify({ error: "Copy count unavailable." }));
  }
};
