// Vercel serverless function: self-serve content-audit intake.
// The homepage band POSTs { url, email }; this validates both, then writes one
// row to the Notion "Inbound Audit Leads" DB (Status: New, Reviewer: Natalie).
// The audit itself is run later by the moochbot batch-runner (manual-first, R2):
// this endpoint only captures the lead. No audit runs here, no keys but Notion's.
//
// Admission (method, kill switch, origin, per-IP rate caps) goes through
// api/_guard.js, one door shared by every function here; the Notion write goes
// through api/_notion.js, which carries a real timeout (504 on timeout, 502 on
// a refusal) and the lead-idempotency lookup. A client may send a one-time
// idempotency_key with the submission; it becomes the row's Audit ID, so a
// retried POST finds the row its first attempt created instead of duplicating.
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

const Mailchecker = require("mailchecker");
const {
  guard,
  makeLimiter,
  sameOriginPolicy,
  parseGivenBody,
  hasMailExchanger,
} = require("./_guard.js");
const { notion, findLeadByAuditId, isNotionTimeout } = require("./_notion.js");

// Natalie's Notion user id. Overridable by env, but hardcoded so a missing env
// var never silently drops the Reviewer (which fires her review notification).
const NATALIE_USER_ID =
  process.env.NATALIE_USER_ID || "da15afb0-5f18-4139-82d2-721813c71ba3";

const DATA_SOURCE_ID =
  process.env.AUDIT_LEADS_DS_ID || "fd9fd4d9-944a-4b94-b3ff-7c753be81605";

// Extra hosts allowed on top of the same-origin match (apex, www, local dev).
// Preview deploys (*.vercel.app) don't need listing: they pass the same-origin
// check because their Origin host equals the request Host.
const ALLOWED_HOSTS = [
  "mooch.agency",
  "www.mooch.agency",
  "localhost",
  "127.0.0.1",
];

// Best-effort in-memory limits, per instance. The per-IP caps live in the
// shared guard (checked at the door, committed only on an otherwise-valid
// submission, so bad-email attempts no longer burn quota); the two below are
// endpoint-specific. Durable caps + Cloudflare Turnstile are R3 (story 12);
// at R2 nothing runs until a human approves the lead, so the real exposure is
// junk rows, not agent spend.
const RATE_PER_MIN = 5;
const RATE_PER_DAY = 30;
const PER_TARGET_PER_DAY = 10;
const GLOBAL_PER_DAY = 300;
const DAY = 86_400_000;
const limiter = makeLimiter({ perMin: RATE_PER_MIN, perDay: RATE_PER_DAY });
const targetHits = new Map();
let globalDay = [];

const ADMIT = {
  methods: ["POST"],
  killEnv: "AUDIT_KILL",
  // Same-origin only; a missing header is allowed (non-browser callers aren't
  // the threat here), a present one must match. Blocks casual cross-site abuse.
  origin: sameOriginPolicy({ hosts: ALLOWED_HOSTS, require: false }),
  limiter,
  reply: {
    method: (res) => {
      res.setHeader("Allow", "POST");
      res.status(405).json({ ok: false, error: "method" });
    },
    kill: (res) => res.status(503).json({ ok: false, error: "unavailable" }),
    origin: (res) => res.status(403).json({ ok: false, error: "origin" }),
    rate: (res) => res.status(429).json({ ok: false, error: "rate" }),
  },
};

// Trims a timestamp list to the last `windowMs` and returns whether adding one
// more would exceed `cap`. Does not mutate on a reject.
function overCap(list, cap, windowMs, now) {
  const fresh = list.filter((t) => now - t < windowMs);
  list.length = 0;
  list.push(...fresh);
  return fresh.length >= cap;
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

// A client retry key: becomes the Audit ID, so it has to be filename-plain and
// long enough not to collide by accident. Anything else is ignored and the
// server mints its own id, exactly as before the key existed.
function clientKey(body) {
  const k = body.idempotency_key;
  return typeof k === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(k) ? k : null;
}

async function createLeadRow({ url, email, auditId }) {
  return deps.notion("pages", "POST", {
    parent: { type: "data_source_id", data_source_id: DATA_SOURCE_ID },
    properties: {
      "Site URL": { title: [{ text: { content: url } }] },
      Email: { email },
      "Audit ID": { rich_text: [{ text: { content: auditId } }] },
      Status: { select: { name: "New" } },
      Reviewer: { people: [{ id: NATALIE_USER_ID }] },
    },
  });
}

// A short, opaque run id that threads the lead through the pipeline, report and
// code gate. Not cryptographic; just needs to be unique per submission.
function makeAuditId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `aud_${t}${r}`;
}

const handler = async (req, res) => {
  const admit = guard(req, res, ADMIT);
  if (!admit) return;
  if (admit.rateLimited) return admit.replyRate();

  const parsed = parseGivenBody(req);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error: "badjson" });
  }
  const body = parsed.body;

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
  if (!(await deps.hasMailExchanger(domain))) {
    return res.status(400).json({ ok: false, error: "email", reason: "mx" });
  }

  // Validated: this submission now costs per-IP quota, and only now.
  admit.commitRate();

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

  const key = clientKey(body);
  const auditId = key ? `aud_${key}` : makeAuditId();

  // A keyed retry finds the row its first attempt created. The lookup fails
  // open to a create: a rare duplicate at manual review beats a lost lead.
  if (key) {
    try {
      const existing = await deps.findLeadByAuditId(DATA_SOURCE_ID, auditId);
      if (existing) return res.status(200).json({ ok: true, auditId });
    } catch (err) {
      console.error("[audit] idempotency lookup failed:", err.message);
    }
  }

  try {
    await createLeadRow({ url, email, auditId });
  } catch (err) {
    // The lead IS the product: never silently drop it. Surface a retryable error
    // so the visitor can resubmit, and log loudly for us (Vercel captures stderr).
    console.error("[audit] lead write failed:", err.message);
    const status = isNotionTimeout(err) ? 504 : 502;
    return res.status(status).json({ ok: false, error: "store" });
  }

  return res.status(200).json({ ok: true, auditId });
};

// Test seams, same pattern as api/deslop.js: production uses exactly these
// defaults, the unit tests swap them to drive every exit with no DNS and no
// Notion. Vercel still receives the bare handler as module.exports.
const deps = {
  hasMailExchanger,
  notion,
  findLeadByAuditId,
};

module.exports = handler;
module.exports.deps = deps;
