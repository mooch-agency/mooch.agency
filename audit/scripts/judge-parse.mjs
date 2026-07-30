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

// Every balanced top-level {...} span, in order. Brace- and string-aware, so a
// brace inside a quoted value does not end a span.
//
// One first-{-to-last-} slice is not enough. The system prompt shows the judge a
// schema object, so a judge that echoes that schema and THEN emits its real
// verdict produces two top-level objects; a single span across both parses as
// nothing, which is exactly the failure this module exists to prevent.
function braceSpans(text) {
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        spans.push(text.slice(i, j + 1));
        i = j; // skip the nested opens; this span already covers them
        break;
      }
    }
  }
  return spans;
}

// Candidate JSON strings, best guess first.
function candidates(text) {
  const out = [];
  // 1. Fenced blocks, ANY language tag or none. Last first: the closing block is
  //    the verdict, an earlier one is more likely an example.
  const fenced = [...text.matchAll(/```[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)```/g)].map((m) => m[1]);
  for (let i = fenced.length - 1; i >= 0; i--) out.push(fenced[i]);
  // 2. The whole response, for a reply that is nothing but JSON.
  out.push(text);
  // 3. Each balanced brace span, last first: JSON in prose, or a verdict that
  //    trails an echoed schema.
  const spans = braceSpans(text);
  for (let i = spans.length - 1; i >= 0; i--) out.push(spans[i]);
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
