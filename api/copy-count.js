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
//
// Admission (method, kill switch, origin, per-method rate caps) goes through
// api/_guard.js; quota is committed only once the slug and token have passed,
// so a junk request no longer burns it, and the unknown-slug 404 still answers
// before the 429 exactly as it always did. Notion calls go through
// api/_notion.js with a real timeout: a timeout answers 504, a refusal 502.
// COPY_COUNT_KILL=1 pauses the endpoint, same convention as the others.

const { guard, makeLimiter, refererPolicy } = require("./_guard.js");
const { notion, isNotionTimeout } = require("./_notion.js");

const ALLOWED_HOSTS = ["mooch.agency", "localhost", "127.0.0.1"];

const PAGES = {
  "deslop": "3cb804529ed08134986cdeb19a30f57a",
  "soundlikeme": "3cb804529ed0815fa148cea34d1880ea",
  "say-less": "3cb804529ed081e2832ae8ac3dd6bcb9",
};

// A GET fires on every page load (cheap, read-only); a POST changes shared
// state, so it gets the tighter cap. Both are generous for a human clicking a
// button, not for a script hammering the endpoint to inflate the number.
// Separate limiters per method keep the same keying the old `${ip}:${method}`
// map had.
const LIMITERS = {
  GET: makeLimiter({ perMin: 60, perDay: 2000 }),
  POST: makeLimiter({ perMin: 5, perDay: 50 }),
};

const ADMIT = {
  methods: ["GET", "POST"],
  killEnv: "COPY_COUNT_KILL",
  // A GET is read-only, so a client that strips both headers (some privacy
  // browsers do) isn't worth blocking; the rate caps are the backstop for it.
  // A POST changes the public count, so it doesn't get that leniency: no
  // header means no proof of same-site, so it's rejected outright. Only this
  // project's own preview names count as trusted, not all of vercel.app.
  origin: refererPolicy({
    hosts: ALLOWED_HOSTS,
    suffixes: [".mooch.agency"],
    projectPreviews: true,
    requireForMethods: ["POST"],
  }),
  limiter: (req) => LIMITERS[req.method],
  reply: {
    method: (res) => { res.statusCode = 405; res.end("Method not allowed"); },
    kill: (res) => { res.statusCode = 503; res.end("The counter is paused. Back shortly."); },
    origin: (res) => { res.statusCode = 403; res.end("Forbidden"); },
    rate: (res) => { res.statusCode = 429; res.end("Slow down a moment, then try again."); },
  },
};

// Same lenient body shape the old inline reader had; kept local because the
// GET path reads req.query instead.
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

const handler = async function handler(req, res) {
  const admit = guard(req, res, ADMIT);
  if (!admit) return;
  const method = req.method;

  const slug = method === "GET"
    ? String((req.query && req.query.slug) || "")
    : String((await readBody(req)).slug || "");
  const pageId = PAGES[slug];
  if (!pageId) {
    res.statusCode = 404;
    return res.end("Unknown page.");
  }

  if (admit.rateLimited) return admit.replyRate();
  if (!process.env.NOTION_TOKEN) {
    res.statusCode = 500;
    return res.end("Server missing Notion token.");
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  admit.commitRate();

  try {
    if (method === "GET") {
      const page = await deps.notion(`pages/${pageId}`, "GET");
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
    const page = await deps.notion(`pages/${pageId}`, "GET");
    const count = countOf(page) + 1;
    await deps.notion(`pages/${pageId}`, "PATCH", { properties: { Count: { number: count } } });
    res.statusCode = 200;
    return res.end(JSON.stringify({ count }));
  } catch (e) {
    console.error("copy-count failed", slug, e && e.message);
    // A timeout is "try again", not Notion refusing; everything else stays 502.
    res.statusCode = isNotionTimeout(e) ? 504 : 502;
    // Content-Type above already declared JSON, so a caller doing res.json()
    // must get JSON back on the error path too, not a plain string.
    return res.end(JSON.stringify({ error: "Copy count unavailable." }));
  }
};

// Test seam, same pattern as api/deslop.js.
const deps = { notion };

module.exports = handler;
module.exports.deps = deps;
