import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LocalDocker } from "../host/index.mjs";

test("a lost real HTTP mutation receipt is unknown and is never automatically replayed", async () => {
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cantrip-os-test-${randomUUID()}`
      : join(
          process.platform === "darwin" ? "/tmp" : tmpdir(),
          `cantrip-os-${randomUUID()}.sock`,
        );
  const received = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ method: request.method, url: request.url, body });
    if (request.url === "/v1.41/mutation") request.socket.destroy();
    else {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "actual Engine refusal" }));
    }
  });
  server.listen(socket);
  await once(server, "listening");
  try {
    const engine = new LocalDocker(socket);
    await assert.rejects(engine.request("POST", "/mutation", { once: true }), {
      delivery: "unknown",
    });
    assert.deepEqual(received, [
      { method: "POST", url: "/v1.41/mutation", body: '{"once":true}' },
    ]);
    await assert.rejects(engine.request("POST", "/denied", {}), {
      status: 403,
      message: "actual Engine refusal",
    });
    assert.equal(received.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("image streams exceed JSON receipt limits and propagate actual HTTP/transport failures", async () => {
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cantrip-stream-${randomUUID()}`
      : join(
          process.platform === "darwin" ? "/tmp" : tmpdir(),
          `cantrip-stream-${randomUUID()}.sock`,
        );
  const block = Buffer.alloc(5 * 1024 * 1024, 73),
    requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith("/denied")) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "actual private image refusal" }));
    } else if (request.url.endsWith("/oversized-error")) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(block);
    } else if (request.url.endsWith("/redirect")) {
      response.writeHead(302, { Location: "/not-followed" });
      response.end();
    } else if (request.url.endsWith("/slow")) {
      response.writeHead(200, { "Content-Type": "application/x-tar" });
      response.write("first");
      const timer = setInterval(() => response.write("next"), 10);
      response.once("close", () => clearInterval(timer));
    } else if (request.url.endsWith("/broken")) {
      response.writeHead(200, {
        "Content-Type": "application/x-tar",
        "Content-Length": block.length,
      });
      response.write(block.subarray(0, 1024));
      setImmediate(() => response.destroy());
    } else {
      response.writeHead(200, { "Content-Type": "application/x-tar" });
      response.end(block);
    }
  });
  server.listen(socket);
  await once(server, "listening");
  try {
    const engine = new LocalDocker(socket);
    const stream = await engine.readStream("/images/private/get");
    let bytes = 0;
    for await (const chunk of stream) {
      assert.ok(chunk.every((value) => value === 73));
      bytes += chunk.length;
    }
    assert.equal(bytes, block.length);
    await assert.rejects(engine.readStream("/denied"), {
      status: 403,
      message: "actual private image refusal",
    });
    const broken = await engine.readStream("/broken");
    await assert.rejects(async () => {
      for await (const chunk of broken) void chunk;
    });
    await assert.rejects(engine.readStream("/oversized-error"), {
      status: 500,
      message: "Docker archive error response exceeded the diagnostic limit.",
    });
    await assert.rejects(engine.readStream("/redirect"), { status: 302 });
    const controller = new AbortController();
    const cancelled = await engine.readStream("/slow", {
      signal: controller.signal,
    });
    let consumed = false;
    await assert.rejects(async () => {
      for await (const chunk of cancelled) {
        consumed = true;
        controller.abort();
      }
    });
    assert.equal(consumed, true);
    assert.equal(requests.length, 6);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
