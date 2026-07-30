// Pulls the judge's verdict out of its response.
//
// The judge is asked to "END with ONE fenced json block". It usually complies,
// but it is free not to, and when it does not the verdict is still right there.
// apexvolumetrics.com (aud_ms75zc7ua1xxer, 30 Jul) returned the whole object as
// bare JSON with no fence at all: valid approach, valid findings, real
// cross-page spelling contradictions. The old parser matched only
// /```json\s*...```/ so it saw nothing, and the run aborted with no verdict
// three times in a row. Same signature as lisbon.amplify.eu and propstrata.
//
// So: accept every shape the verdict can arrive in, and reserve failure for a
// response that genuinely has no findings array anywhere in it.

// Candidate JSON strings, best guess first.
function candidates(text) {
  const out = [];
  // 1. Fenced blocks, ANY language tag or none. Last first: the closing block is
  //    the verdict, an earlier one is more likely an example.
  const fenced = [...text.matchAll(/```[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)```/g)].map((m) => m[1]);
  for (let i = fenced.length - 1; i >= 0; i--) out.push(fenced[i]);
  // 2. The whole response, for a reply that is nothing but JSON.
  out.push(text);
  // 3. The outermost brace span, for JSON wrapped in a sentence of prose.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) out.push(text.slice(first, last + 1));
  return out;
}

// text -> { parsed, findings, rejected, approach }. `parsed` false means no
// candidate carried a findings array, which is the only case the caller should
// treat as "no verdict".
export function parseJudge(text) {
  const empty = { parsed: false, findings: [], rejected: [], approach: "" };
  if (!text || typeof text !== "string") return empty;
  for (const c of candidates(text)) {
    let j;
    try {
      j = JSON.parse(c.trim());
    } catch {
      continue;
    }
    if (!j || !Array.isArray(j.findings)) continue;
    return {
      parsed: true,
      findings: j.findings,
      rejected: Array.isArray(j.rejected) ? j.rejected : [],
      approach: typeof j.approach === "string" ? j.approach : "",
    };
  }
  return empty;
}
