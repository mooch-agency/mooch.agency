// Vercel serverless function: self-serve content-audit intake.
// The homepage band POSTs { url, email }; this validates both, then writes one
// row to the Notion "Inbound Audit Leads" DB (Status: New, Reviewer: Natalie).
// The audit itself is run later by the moochbot batch-runner (manual-first, R2):
// this endpoint only captures the lead. No audit runs here, no keys but Notion's.
//
// Junk defence at the door (v1 audit ticket, story 15 / Work Log 18 Jul):
//   client-side syntax  ->  mailchecker blocklist  ->  dns.resolveMx.
// The MX check FAILS OPEN on timeout: one junk row reaching manual review beats a
// lost real lead. Plausible-but-fake emails pass by design; manual review and the
// report-delivered-to-that-address absorb them. Turnstile is deferred to R3.
//
// Env (set on the Vercel `mooch.agency` project, none committed):
//   NOTION_TOKEN        internal integration "moochbot" token (Keystore > Notion)
//   AUDIT_LEADS_DS_ID   data source id of the Inbound Audit Leads DB
//   NATALIE_USER_ID     Notion user id set as Reviewer on every new row
//   AUDIT_KILL          optional "1" kill switch -> 503

const dns = require("node:dns").promises;
const Mailchecker = require("mailchecker");

// The integration was created against this API version (Keystore > Notion).
const NOTION_VERSION = "2026-03-11";

// Natalie's Notion user id. Overridable by env, but hardcoded so a missing env
// var never silently drops the Reviewer (which fires her review notification).
const NATALIE_USER_ID =
  process.env.NATALIE_USER_ID || "da15afb0-5f18-4139-82d2-721813c71ba3";

const DATA_SOURCE_ID =
  process.env.AUDIT_LEADS_DS_ID || "fd9fd4d9-944a-4b94-b3ff-7c753be81605";

// Extra hosts allowed on top of the same-origin match below (apex, www, local
// dev). Preview deploys (*.vercel.app) don't need listing: they pass the
// same-origin check because their Origin host equals the request Host.
const ALLOWED_HOSTS = [
  "mooch.agency",
  "www.mooch.agency",
  "localhost",
  "127.0.0.1",
];

// The endpoint only ever gets same-origin POSTs from the band, so the real test
// is "does the Origin host match the host this request came in on". That holds
// on production, on every Vercel preview URL, and on localhost, with no deploy
// hostnames hardcoded. A genuine cross-site POST (Origin host != request Host)
// still fails and is rejected. The static list above is a belt-and-braces extra.
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

// Best-effort in-memory limiter, same pattern as api/rewrite.js. Resets when the
// instance recycles, so it stops casual loops but isn't durable. Three layers:
// per-IP (min + day), per-audited-domain (day, so one target can't be spammed),
// and a global daily floor. Durable caps + Cloudflare Turnstile are R3 (story 12);
// at R2 nothing runs until a human approves the lead, so the real exposure is junk
// rows, not agent spend. This is the cheap floor until then.
const RATE_PER_MIN = 5;
const RATE_PER_DAY = 30;
const PER_TARGET_PER_DAY = 10;
const GLOBAL_PER_DAY = 300;
const DAY = 86_400_000;
const hits = new Map();
const targetHits = new Map();
let globalDay = [];

// Trims a timestamp list to the last `windowMs` and returns whether adding one
// more would exceed `cap`. Does not mutate on a reject.
function overCap(list, cap, windowMs, now) {
  const fresh = list.filter((t) => now - t < windowMs);
  list.length = 0;
  list.push(...fresh);
  return fresh.length >= cap;
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { min: [], day: [] };
  rec.min = rec.min.filter((t) => now - t < 60_000);
  rec.day = rec.day.filter((t) => now - t < DAY);
  if (rec.min.length >= RATE_PER_MIN || rec.day.length >= RATE_PER_DAY) {
    hits.set(ip, rec);
    return true;
  }
  rec.min.push(now);
  rec.day.push(now);
  hits.set(ip, rec);
  return false;
}

// Per-audited-domain daily cap + global daily floor. Checked after the URL is
// known. Records the hit only when accepted.
function targetOrGlobalLimited(domain) {
  const now = Date.now();
  const list = targetHits.get(domain) || [];
  if (overCap(list, PER_TARGET_PER_DAY, DAY, now)) {
    targetHits.set(domain, list);
    return true;
  }
  if (overCap(globalDay, GLOBAL_PER_DAY, DAY, now)) return true;
  list.push(now);
  targetHits.set(domain, list);
  globalDay.push(now);
  return false;
}

// Accepts "example.com" or "https://example.com/path". Returns a normalised
// https URL string, or null if it isn't a plausible public web address.
function normaliseUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length > 2000) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  // Must look like a real public domain: a dot, no localhost/IP-only, no spaces.
  if (!host.includes(".")) return null;
  if (host === "localhost" || /^[\d.]+$/.test(host)) return null;
  u.protocol = "https:";
  return u.toString();
}

// Syntax + shape only. mailchecker handles the disposable/placeholder blocklist.
function emailSyntaxOk(email) {
  if (!email || typeof email !== "string") return false;
  if (email.length > 254) return false;
  // Deliberately simple: one @, a dot in the domain, no spaces. The MX check is
  // the real deliverability gate; this just rejects obvious nonsense fast.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// dns.resolveMx deliverability check. FAILS OPEN on timeout or transient resolver
// error (better one junk row at review than a lost real lead), but FAILS CLOSED on
// a definitive negative: NXDOMAIN (ENOTFOUND) = the domain doesn't exist, and
// no-MX-plus-no-A = nothing to receive mail. Those are the "can't receive mail"
// verdicts the visitor should see. Fallback to A record covers domains that take
// mail on the apex without an explicit MX.
async function hasMailExchanger(domain) {
  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("__timeout__")), ms)
      ),
    ]);
  const hasARecord = async () => {
    try {
      const a = await withTimeout(dns.resolve(domain), 2000);
      return Array.isArray(a) && a.length > 0;
    } catch {
      return false;
    }
  };
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 3000);
    if (mx && mx.length > 0) return true;
    return await hasARecord(); // resolved but empty -> A-record fallback
  } catch (err) {
    if (err && err.message === "__timeout__") return true; // slow DNS -> fail open
    // ENODATA = domain exists but has no MX; fall back to its A record.
    if (err && err.code === "ENODATA") return await hasARecord();
    // ENOTFOUND = NXDOMAIN, definitively undeliverable -> fail closed.
    if (err && err.code === "ENOTFOUND") return false;
    return true; // any other resolver error -> fail open
  }
}

async function createLeadRow({ url, email, auditId }) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN not set");
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID },
      properties: {
        "Site URL": { title: [{ text: { content: url } }] },
        Email: { email },
        "Audit ID": { rich_text: [{ text: { content: auditId } }] },
        Status: { select: { name: "New" } },
        Reviewer: { people: [{ id: NATALIE_USER_ID }] },
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Notion ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// A short, opaque run id that threads the lead through the pipeline, report and
// code gate. Not cryptographic; just needs to be unique per submission.
function makeAuditId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `aud_${t}${r}`;
}

module.exports = async (req, res) => {
  if (process.env.AUDIT_KILL === "1") {
    return res.status(503).json({ ok: false, error: "unavailable" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method" });
  }

  // Same-origin only. Blocks casual cross-site abuse of a public write endpoint.
  const origin = req.headers.origin || "";
  if (origin && !originAllowed(origin, req.headers.host)) {
    return res.status(403).json({ ok: false, error: "origin" });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "rate" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: "badjson" });
    }
  }
  body = body || {};

  const url = normaliseUrl(body.url);
  if (!url) {
    return res.status(400).json({ ok: false, error: "url" });
  }

  const email = String(body.email || "").trim().toLowerCase();
  // reason lets the client fire audit_validation_fail with syntax|blocklist|mx.
  if (!emailSyntaxOk(email)) {
    return res.status(400).json({ ok: false, error: "email", reason: "syntax" });
  }
  if (!Mailchecker.isValid(email)) {
    return res
      .status(400)
      .json({ ok: false, error: "email", reason: "blocklist" });
  }
  const domain = email.split("@")[1];
  if (!(await hasMailExchanger(domain))) {
    return res.status(400).json({ ok: false, error: "email", reason: "mx" });
  }

  // Per-audited-domain + global daily caps, counted only on otherwise-valid
  // submissions so bad-email attempts can't exhaust a target's allowance.
  const targetDomain = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  })();
  if (targetOrGlobalLimited(targetDomain)) {
    return res.status(429).json({ ok: false, error: "rate" });
  }

  const auditId = makeAuditId();
  try {
    await createLeadRow({ url, email, auditId });
  } catch (err) {
    // The lead IS the product: never silently drop it. Surface a retryable error
    // so the visitor can resubmit, and log loudly for us (Vercel captures stderr).
    console.error("[audit] lead write failed:", err.message);
    return res.status(502).json({ ok: false, error: "store" });
  }

  return res.status(200).json({ ok: true, auditId });
};
