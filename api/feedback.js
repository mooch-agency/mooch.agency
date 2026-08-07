// Vercel serverless function: writes the adoption-intercept response to the
// Feedback database in Notion (📣 Feedback, filtered on the site by Product =
// Say Less). Two calls per response, matching the ticket's data plan:
//
//   POST { event: "shown" }                 → creates the row, returns its id
//   POST { event: "answered", id, ... }      → patches that same row
//
// The row exists from the moment the question is shown, with Would use and
// Reason blank; a blank row is the shown-but-unanswered signal, not noise.
// The client holds the id returned by "shown" in memory only, so a page
// reload without answering leaves that row blank, which is correct.

const NOTION_VERSION = "2026-03-11";
const DATA_SOURCE_ID = "1b1d44d0-1194-45ec-8205-67fcaee0ff07"; // 📣 Feedback
const ALLOWED_HOSTS = ["mooch.agency", "localhost", "127.0.0.1"];
const RATE_PER_MIN = 20;   // two writes per real response; generous over say-less.js's ask limit
const RATE_PER_DAY = 200;

// Exact Reason select options on the Feedback database. A value outside this
// set would 400 from Notion; checked here first so a mismatched client build
// fails loudly instead of silently dropping the reason.
const REASONS = new Set([
  "I don't understand what it does",
  "Setting it up feels like effort right now",
  "I'm worried it'll mess things up",
  "I'd add it but not right now",
  "Something else",
]);

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

// A short, human-scannable title, not a UUID: the response id already lives
// as a client-side value, the title column is for scanning the table.
function titleFor(now) {
  return now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method not allowed");
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
  if (!process.env.NOTION_TOKEN) {
    res.statusCode = 500;
    return res.end("Server missing Notion token.");
  }

  const body = await readBody(req);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (body.event === "shown") {
      const now = new Date();
      const page = await notion("pages", "POST", {
        parent: { data_source_id: DATA_SOURCE_ID },
        properties: {
          Response: { title: [{ text: { content: titleFor(now) } }] },
          Product: { select: { name: "Say Less" } },
          Submitted: { date: { start: now.toISOString() } },
          "Ran it twice": { checkbox: body.trigger === "second_run" },
        },
      });
      res.statusCode = 200;
      return res.end(JSON.stringify({ id: page.id }));
    }

    if (body.event === "answered") {
      const id = String(body.id || "");
      // A bare Notion page id, nothing else: rejects anything that isn't the
      // id this same endpoint handed back from "shown".
      if (!/^[0-9a-f-]{32,36}$/i.test(id)) {
        res.statusCode = 400;
        return res.end("Bad id.");
      }
      const wouldUse = body.would_use === "Yes" ? "Yes" : body.would_use === "No" ? "No" : null;
      if (!wouldUse) {
        res.statusCode = 400;
        return res.end("Bad would_use.");
      }
      const properties = { "Would use": { select: { name: wouldUse } } };
      if (wouldUse === "No" && body.reason && REASONS.has(body.reason)) {
        properties.Reason = { select: { name: body.reason } };
        // "Something else" carries free text; every other reason is
        // self-explanatory, so only that one gets a detail column write.
        if (body.reason === "Something else" && typeof body.note === "string") {
          properties["Reason detail"] = { rich_text: [{ text: { content: body.note.slice(0, 300) } }] };
        }
      }
      await notion(`pages/${id}`, "PATCH", { properties });
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }

    res.statusCode = 400;
    return res.end("Unknown event.");
  } catch (e) {
    console.error("feedback write failed", e && e.message);
    res.statusCode = 502;
    return res.end("Feedback write failed.");
  }
};
