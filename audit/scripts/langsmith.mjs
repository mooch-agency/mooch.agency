// Logs one LangSmith run per audit so review has a trend line (gate failures per
// week, findings drift, cost/latency) and a log to run evals over. Observability
// must never break the audit, so every failure here is swallowed.
//
// Env: LANGSMITH_API_KEY (Keystore > LangSmith). LANGSMITH_PROJECT overrides the
// project name. No-ops (returns {skipped}) when the key is absent.

import { randomUUID } from "node:crypto";

const ENDPOINT = "https://api.smith.langchain.com/runs";
const PROJECT = process.env.LANGSMITH_PROJECT || "mooch-audit-v1";

// record: pipeline output (+ auditId/email stamped). Posts a completed chain run
// whose metadata carries the per-stage timing, cost, token, and gate numbers.
export async function logRun(record, { latencyMs } = {}) {
  const key = process.env.LANGSMITH_API_KEY;
  if (!key) return { skipped: "no LANGSMITH_API_KEY" };

  const now = Date.now();
  const totalMs = latencyMs || (record.timing?.total_s || 0) * 1000;
  const start = new Date(now - totalMs).toISOString();
  const end = new Date(now).toISOString();

  const run = {
    id: randomUUID(),
    name: "content-audit",
    run_type: "chain",
    start_time: start,
    end_time: end,
    session_name: PROJECT,
    inputs: { site: record.site, auditId: record.auditId || record.tag },
    outputs: {
      findings: record.n ?? (record.findings || []).length,
      gate_pass: record.gate_pass,
      gate_fail: record.gate_fail,
      broken_links: (record.link_check?.broken || []).length,
    },
    extra: {
      metadata: {
        auditId: record.auditId || record.tag,
        picker_model: record.pickerModel,
        pages_used: (record.picker?.pages_used || []).length,
        timing: record.timing,
        cost: record.cost,
        judge_usage: record.judge_usage,
        gate_fail: record.gate_fail,
        coverage_notes: (record.coverage?.notes || []).length,
      },
    },
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(run),
    });
    if (!res.ok) {
      return { error: `LangSmith ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { logged: run.id };
  } catch (e) {
    return { error: e.message };
  }
}
