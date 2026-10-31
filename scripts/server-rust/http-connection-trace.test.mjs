import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { traceHttpConnections } from "./http-connection-trace.mjs";

test("real request diagnostics omit credentials, query parameters and payloads", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.end("private-response-sentinel");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const trace = traceHttpConnections();
  try {
    const response = await fetch(
      origin + "/fixture?token=private-query-sentinel",
      {
        method: "POST",
        headers: { authorization: "Bearer private-header-sentinel" },
        body: "private-body-sentinel",
      },
    );
    assert.equal(await response.text(), "private-response-sentinel");
    const events = trace.close();
    const sent = events.find(
      (event) => event.event === "send" && event.origin === origin,
    );
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, "/fixture");
    assert.ok(
      events.some(
        (event) => event.event === "socket" && event.socket === sent.socket,
      ),
    );
    assert.ok(
      events.some(
        (event) => event.event === "connected" && event.socket === sent.socket,
      ),
      "record the actual TCP connection time, separately from first request use",
    );
    assert.equal(JSON.stringify(events).includes("sentinel"), false);
    const count = events.length;
    assert.equal((await fetch(origin + "/after-close")).status, 200);
    await setImmediate();
    assert.equal(events.length, count, "closed diagnostics stop recording");
  } finally {
    trace.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an actual connection reset remains a failed request without retries", async () => {
  let attempts = 0;
  const server = net.createServer((socket) => {
    attempts++;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const trace = traceHttpConnections();
  try {
    await assert.rejects(
      fetch(`http://127.0.0.1:${server.address().port}/reset`),
    );
    await setImmediate();
    const events = trace.close();
    assert.equal(attempts, 1);
    assert.ok(
      events.some(
        (event) => event.event === "request-error" && event.path === "/reset",
      ),
    );
  } finally {
    trace.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
