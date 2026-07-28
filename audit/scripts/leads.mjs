// Notion "Inbound Audit Leads" DB helpers for the batch runner (story 16).
// Query rows by Status, patch Status + coverage note, and attach the report PDF
// to the row (Files property "Report") so review happens on the row itself.
//
// Auth: NOTION_TOKEN (moochbot integration). AUDIT_LEADS_DS_ID overrides the data
// source id. All calls are same-token, no user OAuth.
//
// CLI:
//   node leads.mjs list <status>              # New|Approved|"Ready for review"|Send|Sent|Rejected
//   node leads.mjs set <pageId> <status> [note]
//   node leads.mjs attach <pageId> <pdfPath>
//   node leads.mjs log <pageId> <recordPath>  # judge reasoning onto the row page body

import { readFileSync } from "fs";
import { basename } from "path";
import { pathToFileURL } from "url";

const NOTION_VERSION = "2026-03-11";
const DS_ID = process.env.AUDIT_LEADS_DS_ID || "fd9fd4d9-944a-4b94-b3ff-7c753be81605";

function token() {
  const t = process.env.NOTION_TOKEN;
  if (!t) throw new Error("NOTION_TOKEN not set");
  return t;
}

async function notion(path, opts = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Notion ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Flatten a Notion page into the fields the runner needs.
function rowOf(page) {
  const p = page.properties || {};
  const title = (p["Site URL"]?.title || []).map((t) => t.plain_text).join("");
  const auditId = (p["Audit ID"]?.rich_text || []).map((t) => t.plain_text).join("");
  return {
    pageId: page.id,
    url: title,
    email: p.Email?.email || "",
    auditId,
    status: p.Status?.select?.name || "",
  };
}

export async function queryByStatus(status) {
  const rows = [];
  let cursor;
  do {
    const body = {
      filter: { property: "Status", select: { equals: status } },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const data = await notion(`data_sources/${DS_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    rows.push(...data.results.map(rowOf));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

export async function setStatus(pageId, status, note) {
  const properties = { Status: { select: { name: status } } };
  // Story 16: Sent carries a timestamp. Stamped here so every path that flips
  // to Sent gets one without the caller remembering to.
  if (status === "Sent") {
    properties["Sent at"] = { date: { start: new Date().toISOString() } };
  }
  if (note != null) {
    properties["Coverage note"] = {
      rich_text: [{ text: { content: String(note).slice(0, 1900) } }],
    };
  }
  return notion(`pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

// Notion direct file upload: create -> send bytes -> returns the file_upload id.
export async function uploadFile(path, contentType = "application/pdf") {
  const filename = basename(path);
  const created = await notion("file_uploads", {
    method: "POST",
    body: JSON.stringify({ filename, content_type: contentType, mode: "single_part" }),
  });
  // The send step is multipart to a signed URL, not JSON, so it bypasses notion().
  const form = new FormData();
  form.append(
    "file",
    new Blob([readFileSync(path)], { type: contentType }),
    filename
  );
  const sendRes = await fetch(created.upload_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Notion-Version": NOTION_VERSION },
    body: form,
  });
  if (!sendRes.ok) {
    throw new Error(`file upload send ${sendRes.status}: ${(await sendRes.text()).slice(0, 300)}`);
  }
  return created.id;
}

// Attaches the PDF (and optionally the record JSON) to the row's Report property.
// The record rides along so a later send, possibly in a different CI container,
// can rebuild the email without local disk (batch.mjs downloads it back).
export async function attachReport(pageId, pdfPath, recordPath) {
  const files = [];
  const pdfId = await uploadFile(pdfPath, "application/pdf");
  files.push({ name: basename(pdfPath), type: "file_upload", file_upload: { id: pdfId } });
  if (recordPath) {
    const recId = await uploadFile(recordPath, "application/json");
    files.push({ name: basename(recordPath), type: "file_upload", file_upload: { id: recId } });
  }
  return notion(`pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { Report: { files } } }),
  });
}

// ── Judge reasoning on the row page body ────────────────────────────────────
// The reviewer needs to see HOW the judge reached each finding, and a file
// attachment is not something anyone opens. This writes it into the row page
// itself, inside ONE toggle: a re-run replaces only that toggle, so review notes
// a human typed on the page survive. Deliberately not a property: properties are
// single-line and this is paragraphs.
const JUDGE_LOG_MARKER = "How the audit reached these findings";

// Notion caps a rich_text content string at 2000 chars.
const rt = (s) => [{ type: "text", text: { content: String(s ?? "").slice(0, 1900) } }];
const para = (s) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(s) } });
const h3 = (s) => ({ object: "block", type: "heading_3", heading_3: { rich_text: rt(s) } });
const bullet = (s) => ({
  object: "block",
  type: "bulleted_list_item",
  bulleted_list_item: { rich_text: rt(s) },
});

function pathOf(u) {
  try {
    return new URL(u).pathname || "/";
  } catch {
    return u || "?";
  }
}

// record -> the toggle's child blocks. Kept separate from the API call so it can
// be unit-tested without a token.
export function judgeLogBlocks(record) {
  const log = record.judge_log || {};
  const findings = record.findings || [];
  const blocks = [para(log.summary || "No summary recorded for this run.")];
  if (log.approach) blocks.push(h3("What the judge compared"), para(log.approach));

  if (findings.length) blocks.push(h3("Why each finding was kept"));
  for (const f of findings) {
    const head = `${String(f.severity || "low").toUpperCase()} ${f.category || "issue"} on ${pathOf(
      f.url
    )}${f.gate === "fail" ? "  [dropped by the quote gate, not in the report]" : ""}`;
    blocks.push(bullet(head));
    // The reasoning is the point of this block. Fall back to the short check
    // line, then to an explicit gap, so a silent judge is visible rather than
    // looking like a finding with nothing behind it.
    blocks.push(
      para(f.reasoning || f.check || "No reasoning returned by the judge for this finding.")
    );
  }

  const rejected = log.rejected || [];
  if (rejected.length) {
    blocks.push(h3("Considered and deliberately not flagged"));
    blocks.push(...rejected.map(bullet));
  }

  blocks.push(
    para(
      `Run ${record.auditId || record.tag || "?"}. Judge ${
        record.judge_model || "claude-opus-4-8"
      }, picker ${record.pickerModel || "?"}. ${
        (record.picker?.pages_used || []).length
      } pages read. Full reasoning stays on the runner as ${record.tag || "?"}.judge-raw.txt.`
    )
  );
  // A toggle takes at most 100 children in one request.
  return blocks.slice(0, 100);
}

// Writes (or replaces) the judge-reasoning toggle on the lead row's page body.
export async function writeJudgeLog(pageId, record) {
  if (!record || !record.judge_log) return { skipped: "no judge_log on record" };
  // Replace only our own toggle. Anything else on the page is a human's.
  const existing = await notion(`blocks/${pageId}/children?page_size=100`);
  for (const b of existing.results || []) {
    const title = (b.toggle?.rich_text || []).map((t) => t.plain_text).join("");
    if (b.type === "toggle" && title === JUDGE_LOG_MARKER) {
      await notion(`blocks/${b.id}`, { method: "DELETE" });
    }
  }
  return notion(`blocks/${pageId}/children`, {
    method: "PATCH",
    body: JSON.stringify({
      children: [
        {
          object: "block",
          type: "toggle",
          toggle: { rich_text: rt(JUDGE_LOG_MARKER), children: judgeLogBlocks(record) },
        },
      ],
    }),
  });
}

// Returns the row's Report files as [{name, url}] (urls are time-limited).
export async function getReportFiles(pageId) {
  const page = await notion(`pages/${pageId}`);
  const files = page.properties?.Report?.files || [];
  return files.map((f) => ({ name: f.name, url: f.file?.url || f.external?.url || "" }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = async () => {
    if (cmd === "list") {
      const rows = await queryByStatus(args[0] || "Approved");
      console.log(JSON.stringify(rows, null, 2));
    } else if (cmd === "set") {
      await setStatus(args[0], args[1], args[2]);
      console.log(`set ${args[0]} -> ${args[1]}`);
    } else if (cmd === "attach") {
      await attachReport(args[0], args[1]);
      console.log(`attached ${args[1]} to ${args[0]}`);
    } else if (cmd === "log") {
      const record = JSON.parse(readFileSync(args[1], "utf8"));
      const res = await writeJudgeLog(args[0], record);
      console.log(res.skipped ? `skipped: ${res.skipped}` : `wrote judge reasoning to ${args[0]}`);
    } else {
      console.error("usage: node leads.mjs list|set|attach|log ...");
      process.exit(2);
    }
  };
  run().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
