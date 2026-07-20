// Regression traps: run the pipeline on known sites and assert the FP-safety
// guarantees still hold after any method change (skill provenance / Work Log).
// These are the tripwires for "did we just start hallucinating or leaking hidden
// DOM". Run after any change to the reader, picker, judge, gate, or fallback.
//
//   node regression-traps.mjs            # run all traps live (needs ANTHROPIC_API_KEY + Chrome)
//   node regression-traps.mjs <name>     # run one trap by name
//
// Each trap runs run-pipeline.mjs and reads the record it writes, then asserts.
// A trap that bot-blocks and degrades gracefully (no pages, coverage note) still
// PASSES the "must NOT flag" traps: surfacing nothing is safe.

import { spawn } from "node:child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, "runs");

// TODO(Tahi): confirm the brplumbing + publishinghousebnb exact URLs against the
// case-study notes before relying on those two live. tability.io is exact.
const TRAPS = [
  {
    name: "tability-hidden-pricing",
    url: "https://tability.io",
    // The $/user calculator price is hidden DOM; a rendered-text reader must never
    // surface it. The gate already blocks non-visible quotes, so this guards the
    // reader specifically.
    assert: (rec) => {
      const bad = (rec.findings || []).filter((f) =>
        /\$\s?\d+(\.\d+)?\s*(per|\/)\s*(user|seat|member)/i.test(f.quote || "")
      );
      return bad.length === 0
        ? { pass: true, detail: "no hidden per-user price surfaced" }
        : { pass: false, detail: `leaked hidden pricing: ${bad.map((b) => b.quote).join(" | ")}` };
    },
  },
  {
    name: "brplumbing-including",
    url: "https://www.brplumbing.co.uk",
    // "including Bexhill and Hastings" signals examples, not an exhaustive list; it
    // must not be flagged as a coverage contradiction.
    assert: (rec) => {
      const bad = (rec.findings || []).filter((f) =>
        /including\s+bexhill/i.test(f.quote || "")
      );
      return bad.length === 0
        ? { pass: true, detail: '"including Bexhill" not flagged' }
        : { pass: false, detail: `flagged an "including" example: ${bad.map((b) => b.quote).join(" | ")}` };
    },
  },
  {
    name: "publishinghousebnb-404s",
    url: "https://publishinghousebnb.com",
    // Footer links 404; the hard-404 check MUST catch at least one. Only run this
    // as a positive trap when link checking is in scope for the change.
    assert: (rec) => {
      const broken = (rec.link_check && rec.link_check.broken) || [];
      return broken.length > 0
        ? { pass: true, detail: `${broken.length} broken link(s) caught` }
        : { pass: false, detail: "no broken links caught (expected footer 404s)" };
    },
  },
];

function runPipeline(url, runId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(HERE, "run-pipeline.mjs"), url, runId],
      { stdio: ["ignore", "inherit", "inherit"], env: process.env }
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`pipeline exited ${code}`));
      const slug = url.replace(/https?:\/\/(www\.)?/, "").split(/[/.]/)[0];
      resolve(JSON.parse(readFileSync(join(RUNS, `${slug}_pipe_r${runId}.json`), "utf8")));
    });
  });
}

async function runTrap(trap) {
  const runId = `trap_${trap.name}`;
  try {
    const rec = await runPipeline(trap.url, runId);
    const res = trap.assert(rec);
    const notes = (rec.coverage && rec.coverage.notes) || [];
    return {
      name: trap.name,
      url: trap.url,
      ...res,
      pages: (rec.picker && rec.picker.pages_used) || [],
      findings: (rec.findings || []).length,
      coverage: notes,
    };
  } catch (e) {
    return { name: trap.name, url: trap.url, pass: null, detail: `run failed: ${e.message}` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = process.argv[2];
  const traps = only ? TRAPS.filter((t) => t.name === only) : TRAPS;
  if (!traps.length) {
    console.error(`no trap named ${only}. Known: ${TRAPS.map((t) => t.name).join(", ")}`);
    process.exit(2);
  }
  const results = [];
  for (const t of traps) results.push(await runTrap(t));
  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.pass === false);
  console.log(
    failed.length ? `\nFAILED: ${failed.map((r) => r.name).join(", ")}` : "\nAll traps passed."
  );
  process.exit(failed.length ? 1 : 0);
}
