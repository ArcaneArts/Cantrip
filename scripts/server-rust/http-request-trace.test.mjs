import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import test from "node:test";
import {
  traceHttpRequests,
  setHttpTraceContext,
  registerHttpTraceOrigin,
} from "./http-request-trace.mjs";
const { WebSocket, WebSocketServer } = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");

test("request trace observes fetch and HTTP replies without recording secrets", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(418);
    res.end("unchanged response bytes");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  setHttpTraceContext({ kind: "different-current-context" });
  registerHttpTraceOrigin(origin, { kind: "actual-client" });
  const trace = traceHttpRequests();
  try {
    const response = await fetch(origin + "/fetch?credential=private-query", {
      headers: { authorization: "private-header" },
    });
    assert.equal(await response.text(), "unchanged response bytes");
    const body = await new Promise((resolve, reject) => {
      const req = request(origin + "/http?secret=private-query", (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.once("end", () => resolve(Buffer.concat(chunks).toString()));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(body, "unchanged response bytes");
    const records = trace.close();
    assert.deepEqual(
      records.map(({ client, method, path, status, context }) => ({
        client,
        method,
        path,
        status,
        context,
      })),
      ["fetch", "http"].map((client) => ({
        client,
        method: "GET",
        path: "/" + client,
        status: 418,
        context: { kind: "actual-client" },
      })),
    );
    assert.equal(JSON.stringify(records).includes("private-"), false);
    assert.equal(JSON.stringify(records).includes("unchanged response"), false);
  } finally {
    trace.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("request trace preserves automatic rejection of an unowned upgrade", async () => {
  const server = createServer();
  server.on("upgrade", (_req, socket) =>
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n",
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const outcomes = [];
  try {
    for (const enabled of [false, true]) {
      const trace = enabled ? traceHttpRequests() : null;
      try {
        const errors = [];
        const req = request(
          `http://127.0.0.1:${server.address().port}/unowned`,
          {
            headers: { connection: "Upgrade", upgrade: "fixture" },
          },
        );
        req.on("error", (error) => errors.push(error.code));
        const closed = new Promise((resolve) => req.once("close", resolve));
        req.end();
        await closed;
        outcomes.push({
          errors,
          upgrades: req.listenerCount("upgrade"),
          responses: req.listenerCount("response"),
        });
      } finally {
        trace?.close();
      }
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
    assert.equal(outcomes[1].upgrades, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("request trace observes an actual WebSocket upgrade without changing frames", async () => {
  const server = createServer();
  const gateway = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) =>
    gateway.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (bytes, binary) => ws.send(bytes, { binary }));
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const trace = traceHttpRequests();
  let ws;
  try {
    ws = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/connect?secret=private-query`,
    );
    await once(ws, "open");
    const reply = once(ws, "message");
    const payload = Buffer.from([0, 255, 128, 42]);
    ws.send(payload, { binary: true });
    const [bytes, binary] = await reply;
    assert.deepEqual(bytes, payload);
    assert.equal(binary, true);
    ws.close();
    await once(ws, "close");
    assert.deepEqual(
      trace
        .close()
        .map(({ method, path, status }) => ({ method, path, status })),
      [{ method: "GET", path: "/connect", status: 101 }],
    );
  } finally {
    trace.close();
    ws?.terminate();
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test("request trace does not take ownership of an unhandled response", async () => {
  const server = createServer((_req, res) => res.end("automatically drained"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const trace = traceHttpRequests();
  try {
    const req = request(`http://127.0.0.1:${server.address().port}/unhandled`);
    assert.equal(req.listenerCount("response"), 0);
    assert.equal(req.listenerCount("upgrade"), 0);
    req.end();
    await once(req, "close");
    assert.equal(req.listenerCount("response"), 0);
    assert.equal(req.listenerCount("upgrade"), 0);
    assert.equal(trace.close()[0].status, 200);
  } finally {
    trace.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
