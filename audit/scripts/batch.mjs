// Batch runner: the scripted version of RUNNER.md's daily flow (story 16).
// One invocation does both halves:
//   1. Every lead with Status=Approved  -> run audit -> attach PDF -> Ready for review
//   2. Every lead with Status=Send     -> email report via Resend -> Sent
// Nothing skips the two human flips: this only processes rows a human moved to
// Approved or Send. Designed for GitHub Actions (workflow_dispatch) but runs
// anywhere with the env set.
//
// Env: NOTION_TOKEN, ANTHROPIC_API_KEY (or AUDIT_LLM=subscription locally),
//      RESEND_API_KEY (send half), CHROME_PATH (CI points at installed Chrome).
// Failure policy: one lead failing must not sink the batch; failures are noted
// on the row (coverage note) and the batch exits non-zero so CI shows red.

import { queryByStatus, setStatus, attachReport, getReportFiles, writeJudgeLog } from "./leads.mjs";
import { runAudit } from "./run-audit.mjs";
import { sendReport } from "./send-report.mjs";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const results = { ran: [], sent: [], failed: [] };

// ── Half 1: Approved -> Ready for review ────────────────────────────────────
const approved = await queryByStatus("Approved");
console.log(`Approved leads: ${approved.length}`);
for (const lead of approved) {
  const auditId = lead.auditId || `aud_${lead.pageId.replace(/-/g, "").slice(0, 12)}`;
  try {
    if (!/^https?:\/\//.test(lead.url)) throw new Error(`bad url: ${lead.url}`);
    const r = await runAudit({ url: lead.url, auditId, email: lead.email });
    await attachReport(lead.pageId, r.pdfPath, r.recordPath);
    // Judge reasoning onto the row page body, so review happens where the PDF is.
    // Never fatal: a failed log must not block a good report from reaching review.
    await writeJudgeLog(lead.pageId, JSON.parse(readFileSync(r.recordPath, "utf8"))).catch((e) =>
      console.error(`  (judge log not written: ${String(e.message || e).slice(0, 120)})`)
    );
    await setStatus(lead.pageId, "Ready for review", r.summary);
    results.ran.push({ url: lead.url, auditId, summary: r.summary });
    console.log(`✓ ran ${lead.url} -> ${r.summary}`);
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    results.failed.push({ url: lead.url, stage: "run", error: msg });
    console.error(`✗ ${lead.url}: ${msg}`);
    // UNREADABLE_SITE = story-13 personal-reply case; leave Approved so a human
    // decides (reply personally + Rejected). Other failures also stay Approved
    // for the next batch, but get the error noted on the row.
    await setStatus(lead.pageId, "Approved", `run failed: ${msg}`).catch(() => {});
  }
}

// ── Half 2: Send -> Sent ────────────────────────────────────────────────────
const toSend = await queryByStatus("Send");
console.log(`Send leads: ${toSend.length}`);
for (const lead of toSend) {
  try {
    // Pull the PDF + record from the row itself: approve and send may have
    // happened in different CI containers, so local disk can't be assumed.
    const files = await getReportFiles(lead.pageId);
    const pdfFile = files.find((f) => f.name.endsWith(".pdf"));
    const recFile = files.find((f) => f.name.endsWith(".record.json"));
    if (!pdfFile || !recFile) throw new Error("row is missing the report PDF or record (regenerate: flip back to Approved)");
    const tmp = mkdtempSync(join(tmpdir(), "audit-send-"));
    const dl = async (f) => {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`download ${f.name}: ${res.status}`);
      const p = join(tmp, f.name);
      writeFileSync(p, Buffer.from(await res.arrayBuffer()));
      return p;
    };
    const record = JSON.parse(readFileSync(await dl(recFile), "utf8"));
    const r = await sendReport(record, await dl(pdfFile));
    await setStatus(lead.pageId, "Sent");
    results.sent.push({ to: r.to, subject: r.subject });
    console.log(`✓ sent ${r.subject} -> ${r.to}`);
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    results.failed.push({ url: lead.url, stage: "send", error: msg });
    console.error(`✗ send ${lead.url}: ${msg}`);
  }
}

console.log(`\nBatch done: ${results.ran.length} run, ${results.sent.length} sent, ${results.failed.length} failed.`);
if (results.failed.length) process.exit(1);
