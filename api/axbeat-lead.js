// Vercel serverless function: AXBeat's report request.
//
// The board's only lead form lives inside each opened row (axbeat.html's
// rowCta). It takes one field, a whole work email address, and posts exactly
// that: the row's chain name stays in the browser as analytics context and
// never reaches this endpoint. This writes one row to the same Notion "Inbound
// Audit Leads" DB the homepage audit band uses (Status: New, Reviewer:
// Natalie), so both inbound routes land in one review queue rather than two.
// The report itself is written and sent by a human afterwards; nothing runs
// here.
//
// The board is no longer an allowlist
//   This used to read axbeat.html's own baked scan block back off disk and
//   reject any email whose domain wasn't one of the 22 chains on the board.
//   Dropped deliberately on 17 Sep, not by omission: the board is public, so a
//   real visitor at a real L2 that just isn't ranked yet would have bounced
//   with no way to say so. What still guards the Notion queue, unchanged and in
//   this order, is email syntax, the mailchecker blocklist, dns.resolveMx
//   (failing open on timeout), and both rate limits below. None of that depends
//   on knowing which chain, if any, an address belongs to, so losing the board
//   lookup costs nothing. Nothing here names a chain: "Coverage note" says only
//   that a report was asked for, and Natalie triages who it's from the same way
//   she would any lead that doesn't resolve to a known chain.
//
// Junk defence at the door: local-part syntax -> mailchecker blocklist ->
// dns.resolveMx -> rate limits. The MX check FAILS OPEN on timeout: one junk
// row reaching manual review beats a lost real lead.
//
// Env (set on the Vercel `mooch.agency` project, none committed):
//   NOTION_TOKEN        internal integration "moochbot" token (Keystore > Notion)
//   AUDIT_LEADS_DS_ID   data source id of the Inbound Audit Leads DB
//   NATALIE_USER_ID     Notion user id set as Reviewer on every new row
//   AXBEAT_LEADS_KILL   optional "1" kill switch -> 503

const dns = require("node:dns").promises;
const Mailchecker = require("mailchecker");

// The integration was created against this API version (Keystore > Notion).
const NOTION_VERSION = "2026-03-11";

const NATALIE_USER_ID =
  process.env.NATALIE_USER_ID || "da15afb0-5f18-4139-82d2-721813c71ba3";

// Same DB as the homepage audit band. Overridable so AXBeat can be split into
// its own queue later without a code change.
const DATA_SOURCE_ID =
  process.env.AXBEAT_LEADS_DS_ID ||
  process.env.AUDIT_LEADS_DS_ID ||
  "fd9fd4d9-944a-4b94-b3ff-7c753be81605";

const ALLOWED_HOSTS = ["mooch.agency", "www.mooch.agency", "localhost", "127.0.0.1"];

// Best-effort and per-instance, which is worth stating plainly: these counters
// live in this lambda's memory, so on a scaled deploy each instance keeps its own
// and GLOBAL_PER_DAY is a per-instance floor rather than a true global cap. It
// stops casual loops, nothing more. The real containment is upstream of it: the
// address has to pass syntax, blocklist and MX checks, and every row waits for
// a human before anything is sent.
const RATE_PER_MIN = 5;
const RATE_PER_DAY = 30;
const PER_DOMAIN_PER_DAY = 10;
const GLOBAL_PER_DAY = 300;
const DAY = 86_400_000;
const hits = new Map();
const domainHits = new Map();
const globalDay = [];

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

// Daily cap per email domain so one address (or one company) can't be spammed,
// plus a global daily floor. The domain is simply whatever the submitted
// address carries; nothing verifies it against the board any more.
function domainOrGlobalLimited(domain) {
  const now = Date.now();
  const list = domainHits.get(domain) || [];
  if (overCap(list, PER_DOMAIN_PER_DAY, DAY, now)) {
    domainHits.set(domain, list);
    return true;
  }
  if (overCap(globalDay, GLOBAL_PER_DAY, DAY, now)) return true;
  list.push(now);
  domainHits.set(domain, list);
  globalDay.push(now);
  return false;
}

// The endpoint only ever gets same-origin POSTs from the board, so the real test
// is whether the Origin host matches the host the request came in on. That holds
// on production, on every Vercel preview URL and on localhost, with no deploy
// hostnames hardcoded.
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

// The local part only. No @, no spaces, no routing tricks, and short enough that
// nothing downstream has to think about length.
function localPartOk(s) {
  return typeof s === "string" && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.\-]{1,64}$/.test(s) && !s.startsWith(".") && !s.endsWith(".");
}

async function hasMx(domain) {
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 2500)),
    ]);
    if (records === "timeout") return true; // fail open, see the header note
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

async function createLeadRow({ email, domain, leadId }) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      parent: { data_source_id: DATA_SOURCE_ID },
      properties: {
        // Best-effort, from the address alone: there is no board lookup any
        // more to confirm this is a real chain's working host, only what the
        // domain itself says. Natalie triages from here.
        "Site URL": { title: [{ text: { content: `https://${domain}` } }] },
        Email: { email },
        "Audit ID": { rich_text: [{ text: { content: leadId } }] },
        // No chain to name: the row's chain never leaves the browser, so this
        // just says a report was asked for rather than guessing at one.
        "Coverage note": {
          rich_text: [{ text: { content: "AXBeat: full report request" } }],
        },
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

// A short, opaque id that threads the lead through to the report we send back.
function makeLeadId() {
  return `axb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = async (req, res) => {
  if (process.env.AXBEAT_LEADS_KILL === "1") {
    return res.status(503).json({ ok: false, error: "unavailable" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method" });
  }

  // Origin is REQUIRED, not just checked when present. Browsers send it on every
  // cross-origin and same-origin fetch POST, so the board always has one; letting
  // a missing header through would have waved past every non-browser caller,
  // which is the one shape a real abuser sends.
  const origin = req.headers.origin || "";
  if (!origin || !originAllowed(origin, req.headers.host)) {
    return res.status(403).json({ ok: false, error: "origin" });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: "rate" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: "badjson" }); }
  }
  body = body || {};

  // One field, a whole work email address: there is no chain to fix the domain
  // to, and no board to check it against either (see the header note). Split on
  // the LAST "@": a local part is never supposed to
  // carry one unescaped, but failing safe here is free and simpler than
  // parsing quoted-local-part edge cases nothing downstream needs.
  const rawEmail = String(body.email || "").trim();
  const at = rawEmail.lastIndexOf("@");
  if (at < 1 || at === rawEmail.length - 1) {
    return res.status(400).json({ ok: false, error: "email", reason: "syntax" });
  }
  const local = rawEmail.slice(0, at);
  const domain = rawEmail.slice(at + 1).toLowerCase();

  if (!localPartOk(local)) {
    return res.status(400).json({ ok: false, error: "email", reason: "syntax" });
  }
  const email = `${local}@${domain}`;
  if (!Mailchecker.isValid(email)) {
    return res.status(400).json({ ok: false, error: "email", reason: "blocklist" });
  }
  if (!(await hasMx(domain))) {
    return res.status(400).json({ ok: false, error: "email", reason: "mx" });
  }
  if (domainOrGlobalLimited(domain)) return res.status(429).json({ ok: false, error: "rate" });

  if (!process.env.NOTION_TOKEN) {
    console.error("axbeat-lead: NOTION_TOKEN is not set");
    return res.status(500).json({ ok: false, error: "store" });
  }

  const leadId = makeLeadId();
  try {
    await createLeadRow({ email, domain, leadId });
  } catch (e) {
    console.error("axbeat-lead: Notion write failed", e && e.message);
    return res.status(502).json({ ok: false, error: "store" });
  }

  return res.status(200).json({ ok: true, leadId });
};
