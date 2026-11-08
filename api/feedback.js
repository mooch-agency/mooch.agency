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
//
// Admission (method, kill switch, origin, rate caps) goes through
// api/_guard.js; quota is committed only once the event has validated, so a
// bad body no longer burns it. The Notion write goes through api/_notion.js,
// which carries a real timeout: a timeout answers 504 (nothing known to be
// wrong, try again), a refusal stays 502. FEEDBACK_KILL=1 pauses the endpoint,
// same convention as the other functions.

const { guard, makeLimiter, refererPolicy, readBody } = require("./_guard.js");
const { notion, isNotionTimeout } = require("./_notion.js");

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

const limiter = makeLimiter({ perMin: RATE_PER_MIN, perDay: RATE_PER_DAY });

const ADMIT = {
  methods: ["POST"],
  killEnv: "FEEDBACK_KILL",
  // Non-browser clients aren't the cost threat; the caps are. So a missing
  // header passes, a present one must match.
  origin: refererPolicy({
    hosts: ALLOWED_HOSTS,
    suffixes: [".mooch.agency", ".vercel.app"], // previews included
  }),
  limiter,
  reply: {
    method: (res) => { res.statusCode = 405; res.end("Method not allowed"); },
    kill: (res) => { res.statusCode = 503; res.end("Feedback is paused. Back shortly."); },
    origin: (res) => { res.statusCode = 403; res.end("Forbidden"); },
    rate: (res) => { res.statusCode = 429; res.end("Slow down a moment, then try again."); },
  },
};

// A short, human-scannable title, not a UUID: the response id already lives
// as a client-side value, the title column is for scanning the table.
function titleFor(now) {
  return now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const handler = async function handler(req, res) {
  const admit = guard(req, res, ADMIT);
  if (!admit) return;
  if (admit.rateLimited) return admit.replyRate();
  if (!process.env.NOTION_TOKEN) {
    res.statusCode = 500;
    return res.end("Server missing Notion token.");
  }

  const body = await readBody(req);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (body.event === "shown") {
      admit.commitRate();
      const now = new Date();
      const page = await deps.notion("pages", "POST", {
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
      admit.commitRate();
      await deps.notion(`pages/${id}`, "PATCH", { properties });
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }

    res.statusCode = 400;
    return res.end("Unknown event.");
  } catch (e) {
    console.error("feedback write failed", e && e.message);
    // A timeout is "nothing known to be wrong, try again", not Notion saying no.
    res.statusCode = isNotionTimeout(e) ? 504 : 502;
    return res.end("Feedback write failed.");
  }
};

// Test seam, same pattern as api/deslop.js.
const deps = { notion };

module.exports = handler;
module.exports.deps = deps;
