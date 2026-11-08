// Shared plumbing for the SSE streaming endpoints (api/rewrite.js,
// api/say-less.js): one upstream pump with the lifecycle made explicit, so
// each endpoint only decides its own wire format.
//
// What this closes (implicit-state audit, Nov 2026):
// - A closed tab aborts the upstream call instead of billing a full
//   completion that nobody reads.
// - An in-stream provider error is an error outcome, never a clean "done".
// - Truncation (max_tokens, or a stream that ends without its stop marker)
//   is reported, not passed off as a complete answer.
// - A leftover SSE buffer is flushed, not dropped.
// - A hung provider hits our own timeout instead of holding the function
//   open until the platform kills it mid-response.

const DEFAULT_TIMEOUT_MS = 55_000; // under Vercel's own function ceiling

// Abort tied to the client connection. Node fires `close` on a normal finish
// too, so the endpoint calls settle() once the stream is over and a late
// close becomes a no-op.
function clientAbort(res) {
  const controller = new AbortController();
  let settled = false;
  res.on("close", () => {
    if (!settled) controller.abort();
  });
  return {
    signal: controller.signal,
    settle() {
      settled = true;
    },
    get aborted() {
      return controller.signal.aborted;
    },
  };
}

// Provider-specific readers of one parsed SSE JSON event. Each returns the
// fact the pump needs and nothing else, so the loop stays provider-agnostic.
const pickers = {
  claude: {
    pickDelta: (o) =>
      o.type === "content_block_delta" && o.delta && typeof o.delta.text === "string"
        ? o.delta.text
        : "",
    // overloaded_error and friends arrive mid-stream and then the stream
    // closes; without this the run would read as a clean, complete answer.
    pickError: (o) =>
      o.type === "error" ? (o.error && o.error.message) || "upstream error" : null,
    pickTruncation: (o) =>
      o.type === "message_delta" && o.delta && o.delta.stop_reason === "max_tokens",
    pickStop: (o) => o.type === "message_stop",
  },
  openaiChat: {
    pickDelta: (o) =>
      o.choices && o.choices[0] && o.choices[0].delta
        ? o.choices[0].delta.content || ""
        : "",
    pickError: (o) => (o.error ? o.error.message || "upstream error" : null),
    pickTruncation: (o) =>
      !!(o.choices && o.choices[0] && o.choices[0].finish_reason === "length"),
    // OpenAI marks a clean end with a bare [DONE] data line, which the pump
    // recognises itself.
    pickStop: () => false,
  },
};

// Streams one upstream SSE call and reports how it ended, calling
// onToken(text) for each delta. The result's outcome is one of:
//   done            clean end (qualified by `truncated` and `sawStop`)
//   aborted         the caller's signal fired (client went away)
//   timeout         our own timeout fired first
//   unreachable     the fetch itself failed
//   http_error      non-2xx before any stream (carries status, detail)
//   upstream_error  an in-stream provider error (carries error)
//   interrupted     the stream died mid-read
async function pumpSSE({
  url,
  headers,
  body,
  signal,
  onToken,
  pickDelta,
  pickError,
  pickTruncation,
  pickStop,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  let truncated = false;
  let sawStop = false;
  let errMsg = null;
  let timedOut = false;

  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  const finish = (outcome, extra) =>
    Object.assign({ outcome, truncated, sawStop, error: errMsg }, extra);
  const abortOutcome = () => (timedOut ? "timeout" : "aborted");

  // Reads one raw SSE event block. Returns "error" when the provider
  // reported an in-stream error, which must never become a clean done.
  const handleEvent = (ev) => {
    const line = ev.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      sawStop = true;
      return;
    }
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    const err = pickError ? pickError(obj) : null;
    if (err) {
      errMsg = err;
      return "error";
    }
    if (pickTruncation && pickTruncation(obj)) truncated = true;
    if (pickStop && pickStop(obj)) sawStop = true;
    const tok = pickDelta ? pickDelta(obj) : "";
    if (tok) onToken(tok);
  };

  try {
    let upstream;
    try {
      upstream = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) return finish(abortOutcome());
      return finish("unreachable");
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return finish("http_error", { status: upstream.status, detail });
    }

    const reader = upstream.body.getReader();
    // A mocked or misbehaving body may ignore the fetch signal; cancelling
    // the reader on abort guarantees the read below settles either way.
    ac.signal.addEventListener(
      "abort",
      () => {
        try {
          const p = reader.cancel();
          if (p && p.catch) p.catch(() => {});
        } catch {}
      },
      { once: true }
    );

    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (ac.signal.aborted) return finish(abortOutcome());
        return finish("interrupted");
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() || "";
      for (const ev of events) {
        if (handleEvent(ev) === "error") {
          try {
            const p = reader.cancel();
            if (p && p.catch) p.catch(() => {});
          } catch {}
          return finish("upstream_error");
        }
      }
    }
    if (ac.signal.aborted) return finish(abortOutcome());

    // Flush: a final event the provider sent without a trailing blank line
    // still carries real tokens.
    buf += decoder.decode();
    if (buf.trim() && handleEvent(buf) === "error") return finish("upstream_error");

    return finish("done");
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, clientAbort, pickers, pumpSSE };
