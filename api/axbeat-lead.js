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
// Admission (method, kill switch, origin, per-IP rate caps) goes through
// api/_guard.js; the Notion write goes through api/_notion.js (real timeout:
// 504 on timeout, 502 on a refusal) and takes an optional idempotency_key the
// same way api/audit.js does, becoming the row's Audit ID so a retried POST
// finds its first row instead of duplicating. The MX check is the shared
// hasMailExchanger: it now fails OPEN on transient resolver errors (as this
// header always claimed) and accepts a domain that takes mail on its apex A
// record, closing only on a definitive negative.
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
// Env (set on the Vercel `mooch.agency` project, none committed):
//   NOTION_TOKEN        internal integration "moochbot" token (Keystore > Notion)
//   AUDIT_LEADS_DS_ID   data source id of the Inbound Audit Leads DB
//   NATALIE_USER_ID     Notion user id set as Reviewer on every new row
//   AXBEAT_LEADS_KILL   optional "1" kill switch -> 503

const Mailchecker = require("mailchecker");
const {
  guard,
  makeLimiter,
  sameOriginPolicy,
  parseGivenBody,
  hasMailExchanger,
} = require("./_guard.js");
const { notion, findLeadByAuditId, isNotionTimeout } = require("./_notion.js");

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
// live in this lambda's memory, so on a scaled deploy each instance keeps its
// own and GLOBAL_PER_DAY is a per-instance floor rather than a true global
// cap. It stops casual loops, nothing more. The real containment is upstream
// of it: the address has to pass syntax, blocklist and MX checks, and every
// row waits for a human before anything is sent. The per-IP caps live in the
// shared guard and are committed only once the address has validated.
const RATE_PER_MIN = 5;
const RATE_PER_DAY = 30;
const PER_DOMAIN_PER_DAY = 10;
const GLOBAL_PER_DAY = 300;
const DAY = 86_400_000;
const limiter = makeLimiter({ perMin: RATE_PER_MIN, perDay: RATE_PER_DAY });
const domainHits = new Map();
const globalDay = [];

const ADMIT = {
  methods: ["POST"],
  killEnv: "AXBEAT_LEADS_KILL",
  // Origin is REQUIRED, not just checked when present. Browsers send it on
  // every cross-origin and same-origin fetch POST, so the board always has
  // one; letting a missing header through would have waved past every
  // non-browser caller, which is the one shape a real abuser sends.
  origin: sameOriginPolicy({ hosts: ALLOWED_HOSTS, require: true }),
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

function overCap(list, cap, windowMs, now) {
  const fresh = list.filter((t) => now - t < windowMs);
  list.length = 0;
  list.push(...fresh);
  return fresh.length >= cap;
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

// The local part only. No @, no spaces, no routing tricks, and short enough that
// nothing downstream has to think about length.
function localPartOk(s) {
  return typeof s === "string" && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.\-]{1,64}$/.test(s) && !s.startsWith(".") && !s.endsWith(".");
}

// Same shape and rules as api/audit.js's clientKey.
function clientKey(body) {
  const k = body.idempotency_key;
  return typeof k === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(k) ? k : null;
}

async function createLeadRow({ email, domain, leadId }) {
  return deps.notion("pages", "POST", {
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
  });
}

// A short, opaque id that threads the lead through to the report we send back.
function makeLeadId() {
  return `axb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const handler = async (req, res) => {
  const admit = guard(req, res, ADMIT);
  if (!admit) return;
  if (admit.rateLimited) return admit.replyRate();

  const parsed = parseGivenBody(req);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "badjson" });
  const body = parsed.body;

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
  if (!(await deps.hasMailExchanger(domain))) {
    return res.status(400).json({ ok: false, error: "email", reason: "mx" });
  }

  // Validated: this submission now costs per-IP quota, and only now.
  admit.commitRate();
  if (domainOrGlobalLimited(domain)) return res.status(429).json({ ok: false, error: "rate" });

  if (!process.env.NOTION_TOKEN) {
    console.error("axbeat-lead: NOTION_TOKEN is not set");
    return res.status(500).json({ ok: false, error: "store" });
  }

  const key = clientKey(body);
  const leadId = key ? `axb_${key}` : makeLeadId();

  // A keyed retry finds the row its first attempt created. The lookup fails
  // open to a create: a rare duplicate at manual review beats a lost lead.
  if (key) {
    try {
      const existing = await deps.findLeadByAuditId(DATA_SOURCE_ID, leadId);
      if (existing) return res.status(200).json({ ok: true, leadId });
    } catch (e) {
      console.error("axbeat-lead: idempotency lookup failed", e && e.message);
    }
  }

  try {
    await createLeadRow({ email, domain, leadId });
  } catch (e) {
    console.error("axbeat-lead: Notion write failed", e && e.message);
    const status = isNotionTimeout(e) ? 504 : 502;
    return res.status(status).json({ ok: false, error: "store" });
  }

  return res.status(200).json({ ok: true, leadId });
};

// Test seams, same pattern as api/audit.js and api/deslop.js.
const deps = {
  hasMailExchanger,
  notion,
  findLeadByAuditId,
};

module.exports = handler;
module.exports.deps = deps;
