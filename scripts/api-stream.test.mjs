// Tests for api/_stream.js, the shared SSE pump behind rewrite and say-less.
// Each test pins a failure the old inline loops shipped: a closed tab billing
// a full completion, an in-stream error reported as a clean done, truncation
// passed off as complete, a dropped final buffer, a hung upstream held open.
//
// Lives in scripts/, not api/: Vercel deploys every file in api/ as an
// endpoint.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import stream from "../api/_stream.js";

const { clientAbort, pickers, pumpSSE } = stream;

const enc = new TextEncoder();

// An SSE body from raw string chunks. Closes unless told to hang.
function sseBody(chunks, { hang = false } = {}) {
  return new ReadableStream({
    start(c) {
      for (const part of chunks) c.enqueue(enc.encode(part));
      if (!hang) c.close();
    },
  });
}

function fetchOk(body) {
  const calls = { signal: null };
  const impl = (url, opts) => {
    calls.signal = opts.signal;
    return Promise.resolve({ ok: true, status: 200, body });
  };
  return { impl, calls };
}

function claudeDelta(text) {
  return `data: ${JSON.stringify({ type: "content_block_delta", delta: { text } })}\n\n`;
}
const CLAUDE_STOP = 'data: {"type":"message_stop"}\n\n';

function run(fetchImpl, { signal, chunksTokens = [], ...rest } = {}) {
  const tokens = chunksTokens;
  const p = pumpSSE({
    url: "https://upstream.test/v1/messages",
    headers: {},
    body: { q: 1 },
    signal,
    onToken: (t) => tokens.push(t),
    fetchImpl,
    ...pickers.claude,
    ...rest,
  });
  return { p, tokens };
}

test("client disconnect aborts the upstream within a tick", async () => {
  const { impl, calls } = fetchOk(sseBody([claudeDelta("Hel")], { hang: true }));
  const res = new EventEmitter();
  const guard = clientAbort(res);
  const { p, tokens } = run(impl, { signal: guard.signal });

  // Let the first delta land, then drop the client.
  await new Promise((r) => setTimeout(r, 10));
  res.emit("close");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.signal.aborted, true, "upstream fetch signal must abort");

  const result = await p;
  assert.equal(result.outcome, "aborted");
  assert.deepEqual(tokens, ["Hel"]);
});

test("abort after a normal finish is a no-op", async () => {
  const { impl, calls } = fetchOk(sseBody([claudeDelta("Hi"), CLAUDE_STOP]));
  const res = new EventEmitter();
  const guard = clientAbort(res);
  const { p } = run(impl, { signal: guard.signal });

  const result = await p;
  assert.equal(result.outcome, "done");
  guard.settle();
  res.emit("close"); // normal completion also fires close
  assert.equal(guard.aborted, false);
  assert.equal(calls.signal.aborted, false);
});

test("an in-stream error never yields done", async () => {
  const { impl } = fetchOk(
    sseBody([
      claudeDelta("partial "),
      'data: {"type":"error","error":{"message":"Overloaded"}}\n\n',
    ])
  );
  const { p, tokens } = run(impl);
  const result = await p;
  assert.equal(result.outcome, "upstream_error");
  assert.notEqual(result.outcome, "done");
  assert.equal(result.error, "Overloaded");
  assert.deepEqual(tokens, ["partial "]);
});

test("max_tokens truncation is flagged (Claude)", async () => {
  const { impl } = fetchOk(
    sseBody([
      claudeDelta("short"),
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
      CLAUDE_STOP,
    ])
  );
  const { p } = run(impl);
  const result = await p;
  assert.equal(result.outcome, "done");
  assert.equal(result.truncated, true);
  assert.equal(result.sawStop, true);
});

test("a stream that ends without its stop marker reads as unterminated", async () => {
  const { impl } = fetchOk(sseBody([claudeDelta("cut")]));
  const { p } = run(impl);
  const result = await p;
  assert.equal(result.outcome, "done");
  assert.equal(result.sawStop, false);
});

test("finish_reason length is flagged and [DONE] counts as the stop (OpenAI)", async () => {
  const { impl } = fetchOk(
    sseBody([
      'data: {"choices":[{"delta":{"content":"tok"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ])
  );
  const tokens = [];
  const result = await pumpSSE({
    url: "https://upstream.test/v1/chat/completions",
    headers: {},
    body: {},
    onToken: (t) => tokens.push(t),
    fetchImpl: impl,
    ...pickers.openaiChat,
  });
  assert.equal(result.outcome, "done");
  assert.equal(result.truncated, true);
  assert.equal(result.sawStop, true);
  assert.deepEqual(tokens, ["tok"]);
});

test("a leftover buffer without a trailing blank line is flushed", async () => {
  const { impl } = fetchOk(
    sseBody([
      claudeDelta("Hel"),
      // Final event arrives unterminated, then the stream closes.
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "lo" } })}`,
    ])
  );
  const { p, tokens } = run(impl);
  const result = await p;
  assert.equal(result.outcome, "done");
  assert.deepEqual(tokens, ["Hel", "lo"]);
});

test("a hung upstream hits the pump's own timeout", async () => {
  const { impl } = fetchOk(sseBody([claudeDelta("st")], { hang: true }));
  const { p } = run(impl, { timeoutMs: 25 });
  const result = await p;
  assert.equal(result.outcome, "timeout");
});

test("an unreachable upstream is its own outcome", async () => {
  const impl = () => Promise.reject(new Error("ECONNREFUSED"));
  const { p } = run(impl);
  const result = await p;
  assert.equal(result.outcome, "unreachable");
});

test("a non-2xx answer carries status and detail", async () => {
  const impl = () =>
    Promise.resolve({
      ok: false,
      status: 529,
      body: null,
      text: () => Promise.resolve("overloaded"),
    });
  const { p } = run(impl);
  const result = await p;
  assert.equal(result.outcome, "http_error");
  assert.equal(result.status, 529);
  assert.equal(result.detail, "overloaded");
});
