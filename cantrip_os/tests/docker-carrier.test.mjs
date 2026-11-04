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
