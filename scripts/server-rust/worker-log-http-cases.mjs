// The same actual HTTP requests and worker command observations for both peers.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { gate } from "./worker-log-stream-probe.mjs";
import { longFetch } from "./worker-operation-http-lifecycle.mjs";
export const record = (cursor = 7) => ({
  cursor,
  timestamp: "2026-10-25T00:00:00.123Z",
  system: " worker ",
  level: "warn",
  message: 'quote " slash \\ line\n雪 🦀',
  context: { opaque: "\ud800", nested: [null, true, 1] },
  unknown: "removed",
});
export const readResult = (records = [record()]) => ({
  records,
  nextCursor: 7,
  oldestCursor: 2,
  latestCursor: 9,
  hasMore: false,
  truncated: false,
  unknown: "removed",
});
export async function workerLogHttpCases({ f, state, visit, result, profile }) {
  const path = "/api/workers/alpha/logs";
  for (const [name, query] of [
    ["defaults", ""],
    [
      "cursor bounds",
      "?afterCursor=7&beforeCursor=9007199254740991&limit=50&minimumLevel=info",
    ],
    ["coercion", "?afterCursor=0x10&limit=5e1"],
    ["empty cursor", "?afterCursor=&limit=1"],
    ...["trace", "debug", "info", "warn", "error", "fatal"].map((level) => [
      "level " + level,
      "?minimumLevel=" + level,
    ]),
  ]) {
    const offset = state.commands.length;
    const body = await visit(name, "GET", path + query);
    assert.equal(body.records[0].system, "worker");
    assert.equal(body.records[0].unknown, undefined);
    assert.equal(body.unknown, undefined);
    result.cases.push({ name, commands: state.commands.slice(offset) });
  }
  await visit("HEAD read", "HEAD", path, { compareContentLength: true });
  for (const [name, type, raw] of [
    ["malformed JSON", "application/json", "{"],
    ["unsupported media", "application/unknown", "ignored"],
    [
      "prototype-shaped JSON",
      "application/json",
      '{"__proto__":{"ignored":true}}',
    ],
    ["large ignored body", "application/json", "{".repeat(300000)],
  ]) {
    await visit("GET ignores " + name, "GET", path, {
      fetcher: longFetch,
      raw,
      headers: {
        "content-type": type,
        "content-length": Buffer.byteLength(raw),
      },
    });
  }
  state.reply = readResult([]);
  await visit("empty history", "GET", path);
  delete state.reply;
  state.reply = readResult(
    Array.from({ length: 500 }, (_, i) => record(i + 1)),
  );
  await visit("maximum read batch", "GET", path);
  delete state.reply;
  for (const query of [
    "?limit=0",
    "?limit=501",
    "?limit=1.5",
    "?limit=NaN",
    "?afterCursor=-1",
    "?beforeCursor=0",
    "?afterCursor=9007199254740992",
    "?minimumLevel=INFO",
    "?unknown=x",
    "?limit=1&limit=2",
    "?minimumLevel=info&minimumLevel=warn",
    "?afterCursor=1&afterCursor=2",
  ]) {
    const before = state.commands.length;
    await visit("invalid " + query, "GET", path + query, { status: 400 });
    assert.equal(state.commands.length, before);
  }
  for (const worker of ["foreign", "missing", "beta"]) {
    const before = state.commands.length;
    await visit(worker + " read", "GET", path.replace("alpha", worker), {
      status: worker === "beta" ? 503 : 404,
    });
    await visit(
      worker + " validation first",
      "GET",
      path.replace("alpha", worker) + "?limit=501",
      { status: 400 },
    );
    assert.equal(state.commands.length, before);
  }
  for (const target of [path, path + "/stream"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      await visit(method + " " + target, method, target, { status: 404 });
    const response = await fetch(f.server.origin + target, {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:5173" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.equal(text, "Invalid Preflight Request");
    result.cases.push({
      name: "malformed preflight " + target,
      status: response.status,
      text,
      headers: Object.fromEntries(
        [
          "content-type",
          "access-control-allow-origin",
          "access-control-allow-credentials",
          "vary",
        ].map((name) => [name, response.headers.get(name)]),
      ),
    });
  }
  await visit("plain stream GET", "GET", path + "/stream", { status: 404 });
  await visit("plain stream HEAD", "HEAD", path + "/stream", {
    status: 500,
    compareContentLength: true,
  });
  for (const reply of [
    null,
    {},
    readResult([{ ...record(), cursor: 0 }]),
    { ...readResult(), nextCursor: -1 },
    readResult(Array.from({ length: 501 }, (_, i) => record(i + 1))),
  ]) {
    state.reply = reply;
    await visit("malformed read reply " + result.http.length, "GET", path, {
      status: 502,
    });
  }
  delete state.reply;
  state.error = "Controlled worker log failure";
  await visit("worker read failure", "GET", path, { status: 502 });
  delete state.error;
  if (profile === "none") {
    const release = gate();
    state.readHold = release.promise;
    const started = performance.now();
    try {
      const body = await visit("real read deadline", "GET", path, {
        status: 502,
      });
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 5000 && elapsed < 15000, String(elapsed));
      assert.equal(
        body.error,
        "Worker command diagnostics.logs.read timed out.",
      );
      result.readDeadlineMs = elapsed;
    } finally {
      release.resolve();
      delete state.readHold;
    }
    await visit("read after late reply", "GET", path);
  }
  if (profile !== "none") {
    const before = state.commands.length;
    await visit("anonymous log read", "GET", path, {
      client: "anonymous",
      status: 401,
    });
    assert.equal(state.commands.length, before);
  }
}
