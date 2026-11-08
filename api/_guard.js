// api/_guard.js: one admission door for every endpoint in api/.
//
// Every function used to carry its own copy of the same checks (method, kill
// switch, origin, per-IP rate limit) in its own order, with its own drift:
// five kill-switch env names checked in three different positions and absent
// from three files, three origin policies, and rate limiters that recorded a
// hit before validation so a 400 burned quota, with only two files pruning
// their maps. This file is the one copy.
//
// The order is fixed: method, then kill switch, then origin, then the rate
// check. The replies are each endpoint's own, passed in and byte-for-byte
// what it sent before. The limiter is two-phase: guard() only CHECKS the
// caps, and the endpoint calls commitRate() once its input has validated, so
// a rejected request no longer consumes quota. The endpoint also chooses
// where to consult rateLimited, so reply ordering (say copy-count's 404
// before its 429) stays exactly as it was.
//
// Limiters stay best-effort and per-instance, as before: they stop casual
// loops, not a determined abuser. Durable caps remain upstream concerns.

const dns = require("node:dns").promises;

// --- who is calling ----------------------------------------------------------

function ipOf(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    "anon"
  );
}

// --- two-phase rate limiter --------------------------------------------------

const MIN = 60_000;
const DAY = 86_400_000;

// check(key): prune and say whether the key is at cap, WITHOUT recording.
// commit(key): record the hit. Dead keys are swept on every pass so a warm
// instance does not hold a record for every IP that ever visited.
function makeLimiter({ perMin = Infinity, perDay = Infinity }) {
  const hits = new Map();
  function sweep(now) {
    for (const [key, rec] of hits) {
      rec.min = rec.min.filter((t) => now - t < MIN);
      rec.day = rec.day.filter((t) => now - t < DAY);
      if (!rec.min.length && !rec.day.length) hits.delete(key);
    }
  }
  return {
    check(key) {
      const now = Date.now();
      sweep(now);
      const rec = hits.get(key);
      if (!rec) return false;
      return rec.min.length >= perMin || rec.day.length >= perDay;
    },
    commit(key) {
      const now = Date.now();
      sweep(now);
      const rec = hits.get(key) || { min: [], day: [] };
      rec.min.push(now);
      rec.day.push(now);
      hits.set(key, rec);
    },
  };
}

// --- origin policies ---------------------------------------------------------

// Lead endpoints: the Origin host must match the host the request came in on
// (true on production, previews and localhost with nothing hardcoded), with a
// static list as the belt-and-braces extra. `require` says whether a missing
// header is rejected (axbeat-lead) or waved through (audit).
function sameOriginPolicy({ hosts, require = false }) {
  return (req) => {
    const origin = req.headers.origin || "";
    if (!origin) return !require;
    let originHost;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return false;
    }
    const reqHost = String(req.headers.host || "").split(":")[0].toLowerCase();
    if (reqHost && originHost === reqHost) return true;
    return hosts.includes(originHost);
  };
}

// Everything else: Origin or Referer against a host list, optional suffixes,
// and optionally this project's own Vercel preview names (Vercel turns dots
// into hyphens, so previews are always mooch-agency-*.vercel.app; matching on
// that prefix stops every other Vercel site counting as trusted). A missing
// header is allowed unless the method is in requireForMethods.
function refererPolicy({ hosts = [], suffixes = [], projectPreviews = false, requireForMethods = [] }) {
  return (req) => {
    const src = req.headers.origin || req.headers.referer || "";
    if (!src) return !requireForMethods.includes(req.method);
    let host;
    try {
      host = new URL(src).hostname;
    } catch {
      return false;
    }
    if (hosts.includes(host)) return true;
    if (suffixes.some((s) => host.endsWith(s))) return true;
    if (
      projectPreviews &&
      (host === "mooch-agency.vercel.app" ||
        (host.startsWith("mooch-agency-") && host.endsWith(".vercel.app")))
    ) {
      return true;
    }
    return false;
  };
}

// --- body parsing ------------------------------------------------------------

// The strict shape the lead endpoints use: a pre-parsed object is taken as
// is, a string must parse (ok: false is their 400 badjson), anything else is
// an empty body. Never reads the stream, same as before.
function parseGivenBody(req) {
  if (req.body && typeof req.body === "object") return { ok: true, body: req.body };
  if (typeof req.body === "string") {
    try {
      return { ok: true, body: JSON.parse(req.body) };
    } catch {
      return { ok: false, body: {} };
    }
  }
  return { ok: true, body: req.body || {} };
}

// The lenient shape rewrite, feedback and copy-count use: any failure is an
// empty body and the endpoint's own validation answers. The raw-stream path
// (a caller without an application/json content-type) now stops buffering at
// maxBytes rather than holding an arbitrarily large body in memory; an
// over-size body reads as empty and fails validation like any other junk.
function readBody(req, { maxBytes = 64 * 1024 } = {}) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") {
    try {
      return Promise.resolve(JSON.parse(req.body || "{}"));
    } catch {
      return Promise.resolve({});
    }
  }
  return new Promise((resolve) => {
    let raw = "";
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      raw += c;
      if (raw.length > maxBytes) {
        over = true;
        raw = "";
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// --- MX deliverability -------------------------------------------------------

// One checker for both lead endpoints (audit.js wrote it; axbeat-lead.js used
// to fail closed on every resolver error while its header claimed otherwise).
// FAILS OPEN on timeout or a transient resolver error (one junk row at manual
// review beats a lost real lead), FAILS CLOSED on a definitive negative:
// NXDOMAIN, or no MX and no A record. The A-record fallback covers domains
// that take mail on the apex without an explicit MX. Resolvers and timeouts
// are injectable for tests only.
async function hasMailExchanger(domain, opts = {}) {
  const resolveMx = opts.resolveMx || ((d) => dns.resolveMx(d));
  const resolveA = opts.resolve || ((d) => dns.resolve(d));
  const mxTimeoutMs = opts.mxTimeoutMs ?? 3000;
  const aTimeoutMs = opts.aTimeoutMs ?? 2000;
  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error("__timeout__")), ms)),
    ]);
  const hasARecord = async () => {
    try {
      const a = await withTimeout(resolveA(domain), aTimeoutMs);
      return Array.isArray(a) && a.length > 0;
    } catch {
      return false;
    }
  };
  try {
    const mx = await withTimeout(resolveMx(domain), mxTimeoutMs);
    if (mx && mx.length > 0) return true;
    return await hasARecord(); // resolved but empty -> A-record fallback
  } catch (err) {
    if (err && err.message === "__timeout__") return true; // slow DNS -> fail open
    if (err && err.code === "ENODATA") return await hasARecord(); // exists, no MX
    if (err && err.code === "ENOTFOUND") return false; // NXDOMAIN -> fail closed
    return true; // any other resolver error -> fail open
  }
}

// --- the door ----------------------------------------------------------------

// cfg: { methods, killEnv?, origin?, limiter?, rateKey?, reply }.
// reply carries the endpoint's exact refusals: method(res, req), kill(res),
// origin(res), rate(res). limiter may be a limiter or (req) => limiter (for
// per-method caps). Returns null with the refusal sent, or an admission:
// { ip, rateLimited, commitRate(), replyRate() }. The endpoint consults
// rateLimited where its 429 always sat, and commits only after validation.
function guard(req, res, cfg) {
  if (!cfg.methods.includes(req.method)) {
    cfg.reply.method(res, req);
    return null;
  }
  if (cfg.killEnv && process.env[cfg.killEnv] === "1") {
    cfg.reply.kill(res);
    return null;
  }
  if (cfg.origin && !cfg.origin(req)) {
    cfg.reply.origin(res);
    return null;
  }
  const ip = ipOf(req);
  const limiter = typeof cfg.limiter === "function" ? cfg.limiter(req) : cfg.limiter;
  const key = cfg.rateKey ? cfg.rateKey(ip, req) : ip;
  return {
    ip,
    rateLimited: limiter ? limiter.check(key) : false,
    commitRate: () => {
      if (limiter) limiter.commit(key);
    },
    replyRate: () => cfg.reply.rate(res),
  };
}

module.exports = {
  guard,
  ipOf,
  makeLimiter,
  sameOriginPolicy,
  refererPolicy,
  parseGivenBody,
  readBody,
  hasMailExchanger,
};
