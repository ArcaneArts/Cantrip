import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const postgres = createRequire(
  new URL("../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

test("ending a postgres.js pool closes a socket returned after termination", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  let clientSocket;
  let peerSocket;
  const factoryEntered = Promise.withResolvers();
  const factoryResult = Promise.withResolvers();
  const pool = postgres("postgres://fixture@127.0.0.1/fixture", {
    max: 1,
    socket() {
      factoryEntered.resolve();
      return factoryResult.promise;
    },
  });
  try {
    const queryRejected = assert.rejects(pool`select 1`, {
      code: "CONNECTION_DESTROYED",
    });
    await factoryEntered.promise;
    await pool.end({ timeout: 0 });
    await queryRejected;

    const accepted = once(server, "connection");
    clientSocket = createConnection(server.address());
    [peerSocket] = await accepted;
    const closed = once(peerSocket, "close");
    factoryResult.resolve(clientSocket);

    const timeout = new AbortController();
    try {
      await Promise.race([
        closed,
        delay(2_000, undefined, { signal: timeout.signal }).then(() => {
          assert.fail("A PostgreSQL socket remained open after the pool ended");
        }),
      ]);
    } finally {
      timeout.abort();
    }
  } finally {
    clientSocket?.destroy();
    peerSocket?.destroy();
    await pool.end({ timeout: 0 });
    server.close();
  }
});
