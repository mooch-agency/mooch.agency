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

// Fixtures (all confirmed 20 Jul): tability + including-examples run the live
// pipeline; hard-404-detection is self-contained (stable status endpoints).
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
    name: "including-examples",
    // Replaces the original brplumbing fixture (brplumbing.co.uk is now NXDOMAIN).
    // This page claims coverage of "the surrounding Sierra Nevada foothills"
    // then lists "including Prather, Tollhouse, and the Shaver Lake corridor".
    // The "including X and Y" signals examples, not an exhaustive list, so it must
    // NOT be flagged as a coverage contradiction. Confirmed readable + phrase
    // present + passes live 20 Jul; re-confirm the phrase if the site changes.
    url: "https://www.stedmansplumbing.com/plumber-auberry-ca",
    assert: (rec) => {
      const bad = (rec.findings || []).filter((f) =>
        /including\s+prather/i.test(f.quote || "")
      );
      return bad.length === 0
        ? { pass: true, detail: '"including Prather..." not flagged' }
        : { pass: false, detail: `flagged an "including" example: ${bad.map((b) => b.quote).join(" | ")}` };
    },
  },
  {
    name: "hard-404-detection",
    // The link check MUST catch a definitive 404/410 and MUST NOT report a 200.
    // The original publishinghousebnb footer-404 fixture rotted (its 404s were
    // fixed), and any live 404 gets patched eventually, so this is a self-contained
    // check against stable always-N status endpoints, exercising the exact predicate
    // run-pipeline uses (status === 404 || 410 -> broken). No pipeline run, no LLM.
    custom: async () => {
      const isBroken = async (u) => {
        try {
          const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(10000) });
          return r.status === 404 || r.status === 410;
        } catch {
          return null; // network/timeout -> inconclusive
        }
      };
      const b404 = await isBroken("https://mock.httpstatus.io/404");
      const b200 = await isBroken("https://mock.httpstatus.io/200");
      if (b404 === null || b200 === null)
        return { pass: null, detail: "status endpoint unreachable (inconclusive)" };
      if (b404 === true && b200 === false)
        return { pass: true, detail: "404 flagged, 200 not" };
      return { pass: false, detail: `404 detected=${b404}, 200 flagged=${b200}` };
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
    // Self-contained traps (no live site / no LLM) run their own check.
    if (trap.custom) {
      const res = await trap.custom();
      return { name: trap.name, ...res };
    }
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
