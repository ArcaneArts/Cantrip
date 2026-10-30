import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import {
  streamingHttpRequest,
  headersOnlyHttpRequest,
} from "./streaming-http-request.mjs";

test("retains the actual early HTTP rejection and cookies without finishing the upload", async () => {
  const body = "x".repeat(4 * 1024 * 1024);
  let received = 0,
    declared,
    encoding;
  const server = http.createServer((request, response) => {
    declared = request.headers["content-length"];
    encoding = request.headers["transfer-encoding"];
    request.on("data", (chunk) => {
      received += chunk.length;
    });
    request.once("data", () => {
      // Keep the peer open while unread upload bytes arrive. Closing it here
      // can reset the TCP connection before Windows delivers the actual reply.
      response.writeHead(413, {
        "content-type": "application/json",
        connection: "keep-alive",
        "set-cookie": ["first=one; Path=/", "second=two; Path=/"],
      });
      response.end(JSON.stringify({ error: "actual early response" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await streamingHttpRequest(
      `http://127.0.0.1:${server.address().port}/`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body,
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("connection"), "keep-alive");
    assert.deepEqual(await response.json(), { error: "actual early response" });
    assert.deepEqual(response.headers.getSetCookie(), [
      "first=one; Path=/",
      "second=two; Path=/",
    ]);
    assert.equal(declared, undefined);
    assert.equal(encoding, "chunked");
    assert.ok(received > 0, "the actual chunked upload reached the peer");
    assert.ok(
      received < Buffer.byteLength(body),
      "actual early response stops unnecessary writes",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("sends the complete actual body with chunked framing when the peer reads it", async () => {
  const body = "complete actual upload ".repeat(16384);
  let received = Buffer.alloc(0);
  const server = http.createServer((request, response) => {
    assert.equal(request.headers["content-length"], undefined);
    assert.equal(request.headers["transfer-encoding"], "chunked");
    request.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
    });
    request.on("end", () => {
      response.end(JSON.stringify({ received: received.length }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await streamingHttpRequest(
      `http://127.0.0.1:${server.address().port}/`,
      { method: "POST", headers: {}, body, signal: AbortSignal.timeout(5000) },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      received: Buffer.byteLength(body),
    });
    assert.equal(received.toString(), body);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("observes a headers-only rejection without sending the declared body", async () => {
  const declared = 4 * 1024 * 1024 + 1;
  let received = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.headers["content-length"], String(declared));
    assert.equal(request.headers["transfer-encoding"], undefined);
    request.on("data", (chunk) => {
      received += chunk.length;
    });
    response.writeHead(413, { connection: "close" });
    response.end(
      JSON.stringify({ error: "actual advertised-length rejection" }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await headersOnlyHttpRequest(
      `http://127.0.0.1:${server.address().port}/`,
      {
        method: "POST",
        headers: { "content-length": String(declared) },
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      error: "actual advertised-length rejection",
    });
    assert.equal(received, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a socket reset without an HTTP response fails instead of inventing a rejection", async () => {
  const server = net.createServer((socket) =>
    socket.once("data", () => socket.resetAndDestroy()),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(
      streamingHttpRequest(`http://127.0.0.1:${server.address().port}/`, {
        method: "POST",
        headers: {},
        body: "x".repeat(4 * 1024 * 1024),
        signal: AbortSignal.timeout(5000),
      }),
      (error) => ["ECONNRESET", "EPIPE"].includes(error.code),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an incomplete rejection body still fails", async () => {
  const server = net.createServer((socket) =>
    socket.once("data", () => {
      socket.end(
        'HTTP/1.1 413 Payload Too Large\r\nContent-Length: 200\r\nConnection: close\r\n\r\n{"error":',
      );
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(
      streamingHttpRequest(`http://127.0.0.1:${server.address().port}/`, {
        method: "POST",
        headers: {},
        body: "x".repeat(4 * 1024 * 1024),
        signal: AbortSignal.timeout(5000),
      }),
      (error) =>
        ["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(
          error.code,
        ),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
