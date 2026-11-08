// api/_notion.js: the one Notion client for api/.
//
// Every endpoint that writes to Notion used to call fetch with no timeout, so
// a hung Notion request rode the function to the platform kill and surfaced
// as a 502 that looked like Notion refusing. Here every call carries a real
// timeout, and a timeout throws a tagged error so the endpoint can answer
// 504 (try again, nothing is known to be wrong) instead of 502 (the store
// said no).
//
// Lead idempotency, without a schema change: both lead endpoints already
// write an "Audit ID" property on every row, so a client-supplied retry key
// becomes the Audit ID and findLeadByAuditId() lets a retried request find
// the row its first attempt created, instead of writing a duplicate. The
// find-then-create is not atomic; at these volumes a rare duplicate beats a
// lost lead, same trade copy-count.js documents for its read-then-write.

const NOTION_VERSION = "2026-03-11";
const TIMEOUT_MS = 8000;

function timeoutError() {
  const e = new Error("Notion timed out");
  e.notionTimeout = true;
  return e;
}

function isNotionTimeout(e) {
  return !!(e && e.notionTimeout);
}

async function notion(path, method, body, { timeoutMs = TIMEOUT_MS, fetchImpl } = {}) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN not set");
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(`https://api.notion.com/v1/${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "notion-version": NOTION_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw timeoutError();
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.message) || `Notion ${res.status}`);
  }
  return data;
}

// First row whose "Audit ID" equals auditId, or null. Both lead databases
// carry the property already.
async function findLeadByAuditId(dataSourceId, auditId, opts) {
  const data = await notion(
    `data_sources/${dataSourceId}/query`,
    "POST",
    {
      filter: { property: "Audit ID", rich_text: { equals: auditId } },
      page_size: 1,
    },
    opts
  );
  return (data.results && data.results[0]) || null;
}

module.exports = { notion, findLeadByAuditId, isNotionTimeout, timeoutError, NOTION_VERSION };
