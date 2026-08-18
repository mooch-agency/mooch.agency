// Fire-and-forget LangSmith tracing for the Say Less demo.
//
// Why this exists: Vercel Web Analytics counts asks (sayless_ask) but only
// ever sees prompt_words and source, never the question itself. So we knew
// 36 people had asked something and nothing about what. This records the
// question, both answers and both word counts, which also keeps the 71%
// headline checkable against real traffic instead of only the fixed
// benchmark set.
//
// No SDK on purpose: this is a no-build repo and the function streams, so
// a cold-start dependency earns nothing. One POST opens the run and one
// PATCH closes it, which is LangSmith's documented REST contract.
//
// Every call is best-effort: a tracing outage, a rotated key or a slow
// LangSmith must never break the stream the visitor is watching. Failures
// resolve rather than reject, and every request carries its own timeout.
//
// They do, however, return their promise. The closing PATCH has to be
// awaited before the response ends, because a serverless invocation can be
// frozen the moment it replies and would otherwise take the in-flight
// request down with it, leaving the run open and empty forever.

const ENDPOINT = (process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com").replace(/\/+$/, "");
const PROJECT = process.env.LANGSMITH_PROJECT || "say-less";
// Bounded so a hanging LangSmith can only ever delay res.end() by this much.
// Both answers are already on screen by then, so the visitor sees no wait.
const TIMEOUT_MS = 2500;

// Tracing is opt-in by key presence, so local dev and preview deploys stay
// silent unless someone deliberately sets the variable.
const on = () => Boolean(process.env.LANGSMITH_API_KEY);

// Failures are logged, never thrown: a 401 from a rotated key should surface
// in runtime logs, not as a broken demo for whoever is on the page.
// Always returns a promise that resolves, never rejects, so callers can
// await it without needing a try/catch of their own.
function send(method, path, body) {
  if (!on()) return Promise.resolve();
  return fetch(ENDPOINT + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.LANGSMITH_API_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((r) => {
      if (!r.ok) return r.text().then((t) => console.error("langsmith", method, r.status, t.slice(0, 200)));
    })
    .catch((e) => console.error("langsmith", method, e && e.message));
}

// Opened as soon as the question arrives, before either answer starts.
// Posting up front rather than once at the end means a run the visitor
// abandons (closed tab, Stop pressed) still records what was asked, which
// is exactly the case we most want to see.
// Not awaited by the caller on purpose: this one has the whole stream to
// land in, and blocking the first token on a tracing round trip would be a
// visible cost for no gain.
function startRun(question, metadata) {
  if (!on()) return null;
  const id = crypto.randomUUID();
  send("POST", "/runs", {
    id,
    name: "say-less compare",
    run_type: "chain",
    session_name: PROJECT,
    start_time: new Date().toISOString(),
    inputs: { question },
    extra: { metadata: metadata || {} },
  });
  return id;
}

// Await this before ending the response. See the timeout note above.
function endRun(id, outputs) {
  if (!id) return Promise.resolve();
  return send("PATCH", "/runs/" + id, {
    end_time: new Date().toISOString(),
    outputs: outputs || {},
  });
}

module.exports = { startRun, endRun };
