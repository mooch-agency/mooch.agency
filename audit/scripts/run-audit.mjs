// Per-lead orchestrator: URL -> pipeline record -> branded report + PDF.
// Used by the batch runner (RUNNER.md) once per Approved lead. Keeps the merged
// record (pipeline output + the lead's auditId + email) so the later send step
// can find the exact PDF and address by auditId.
//
// LLM engine (the picker + judge inside the pipeline):
//   AUDIT_LLM=api (default) -> audit/scripts/run-pipeline.mjs via the Anthropic
//     SDK. This is the measured, validated path (needs ANTHROPIC_API_KEY).
//   The subscription path (claude -p, $0 marginal, the R2 target) is not wired
//     here yet: it needs a live subscription smoke test, which belongs with the
//     Phase 4 live-run tests. Tracked on the ticket. Until then the runner uses
//     the API engine; the ~$0.15/audit cost is trivial and it is what is proven.
//
// Test seam: AUDIT_RECORD_FIXTURE=<path> skips the pipeline and uses that record,
// so the orchestration (merge -> report -> PDF) is testable without API spend.

import { buildReport } from "../report/build-report.mjs";
import { logRun } from "./langsmith.mjs";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, "runs");
const OUT = join(HERE, "..", "report", "out");

// Mirrors run-pipeline.mjs's slug EXACTLY (from the full URL string, stripping
// protocol + www) so we read back the file it actually wrote. Deriving from the
// URL host instead would keep "www" and miss the file for www sites.
function pipelineSlug(url) {
  return url.replace(/https?:\/\/(www\.)?/, "").split(/[/.]/)[0];
}

// AUDIT_METHOD picks the engine. `pipeline` (default) is the incumbent
// picker -> prefetch -> judge -> gate. `websearch` is the method benchmarked on
// 31 Jul: the auditor searches for its own pages, reads them with the rendering
// reader, and the gate verifies quotes and absence claims after the fact. On the
// six-site benchmark the pipeline shipped 0 critical/high findings and websearch
// shipped 8, reporting on 6 of 6 sites against 3 of 6. See
// benchmark/2026-07-31-websearch-method.md.
//
// Default flipped to `websearch` on 31 Jul, deliberately and in its own commit.
// `pipeline` is kept and still works: AUDIT_METHOD=pipeline (or the workflow
// dropdown) switches back with no other change, which is the point of leaving it
// in rather than deleting it. Revert the default if the live runs disagree with
// the benchmark.
const METHOD = (process.env.AUDIT_METHOD || "websearch").toLowerCase();

// Runs the websearch auditor as a child and returns the report-shaped record it
// wrote. websearch-audit.mjs already emits picker.pages_used, coverage.notes and
// link_check, so the report renderer and the honesty gate work unchanged.
function runWebsearch(url, auditId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(HERE, "websearch-audit.mjs"), url, auditId],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, WSA_NOTION: "1" } }
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`websearch audit exited ${code}`));
      const slug = pipelineSlug(url);
      const recordPath = join(RUNS, `${slug}_wsn_r${auditId}.json`);
      let record;
      try {
        record = JSON.parse(readFileSync(recordPath, "utf8"));
      } catch (e) {
        return reject(new Error(`websearch record not found at ${recordPath}: ${e.message}`));
      }
      // Same story-13 contract as the pipeline. A run that read nothing is a
      // personal-reply case, never a report: without this the renderer would be
      // handed zero pages and zero findings and would print a clean bill of health
      // for a site we never saw.
      if (!(record.picker?.pages_used || []).length)
        return reject(
          new Error(`UNREADABLE_SITE: no readable pages on ${url}; reply personally and set Rejected (story 13)`)
        );
      // No parseable findings block is the websearch equivalent of
      // JUDGE_UNPARSEABLE: it looks exactly like a clean site and must not ship.
      if (record.parse_error)
        return reject(
          new Error(`JUDGE_UNPARSEABLE: ${record.parse_error} for ${url}; left Approved to retry, see the runner's .audit-raw.txt`)
        );
      resolve(record);
    });
  });
}

// Runs run-pipeline.mjs as a child, returns the record it wrote. The pipeline
// keys its output file by <slug>_pipe_r<runId>, so we pass auditId as runId.
function runPipeline(url, auditId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(HERE, "run-pipeline.mjs"), url, auditId],
      { stdio: ["ignore", "inherit", "inherit"], env: process.env }
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      // Exit 3 = no readable pages (bot-block/empty site): a personal-reply case
      // per story 13, not a crash. Distinct message so the runner acts on it.
      if (code === 3)
        return reject(
          new Error(`UNREADABLE_SITE: no readable pages on ${url}; reply personally and set Rejected (story 13)`)
        );
      // Exit 4 = the judge ran but we could not parse a verdict out of it. Not a
      // clean site and not a crash: the lead stays Approved so the next batch
      // retries it. Never let this fall through to a zero-findings report.
      if (code === 4)
        return reject(
          new Error(`JUDGE_UNPARSEABLE: no readable verdict for ${url}; left Approved to retry, see the runner's .judge-raw.txt`)
        );
      if (code !== 0) return reject(new Error(`pipeline exited ${code}`));
      const recordPath = join(RUNS, `${pipelineSlug(url)}_pipe_r${auditId}.json`);
      try {
        resolve(JSON.parse(readFileSync(recordPath, "utf8")));
      } catch (e) {
        reject(new Error(`pipeline record not found at ${recordPath}: ${e.message}`));
      }
    });
  });
}

// { url, auditId, email } -> { recordPath, pdfPath, htmlPath, thin, findingCount, summary }
export async function runAudit({ url, auditId, email }) {
  mkdirSync(OUT, { recursive: true });
  const fixture = process.env.AUDIT_RECORD_FIXTURE;
  const record = fixture
    ? JSON.parse(readFileSync(fixture, "utf8"))
    : METHOD === "websearch"
      ? await runWebsearch(url, auditId)
      : await runPipeline(url, auditId);

  // Stamp the lead's identity onto the record so downstream steps are self-contained.
  record.auditId = auditId;
  record.email = email;
  record.site = record.site || url;
  const recordPath = join(OUT, `${auditId}.record.json`);
  writeFileSync(recordPath, JSON.stringify(record, null, 2));

  const { htmlPath, pdfPath, thin, findingCount, weight } = await buildReport(
    record,
    OUT
  );
  // Observability: one LangSmith run per audit. Never fatal to the audit.
  await logRun(record).catch(() => {});
  const broken = (record.link_check && record.link_check.broken) || [];
  // Where the pipeline left the judge's verbatim reasoning. Same container, so
  // it is readable now; on CI it stops existing when the job ends, which is why
  // the caller copies it onto the Notion row while it still can.
  const rawPath = record.tag ? join(RUNS, `${record.tag}.judge-raw.txt`) : null;
  return {
    recordPath,
    htmlPath,
    pdfPath,
    rawPath,
    tag: record.tag,
    thin,
    findingCount,
    summary: `${findingCount} findings${
      broken.length ? ` + ${broken.length} broken links` : ""
    }, weight ${weight}${thin ? " (thin -> good-shape variant)" : ""}`,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url, auditId, email] = process.argv.slice(2);
  if (!url || !auditId || !email) {
    console.error("usage: node run-audit.mjs <url> <auditId> <email>");
    process.exit(2);
  }
  runAudit({ url, auditId, email })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
