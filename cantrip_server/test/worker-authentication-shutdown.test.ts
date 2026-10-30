import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import { WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL } from "@cantrip/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function createFixture() {
  const state = { lookupThrows: false };
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-worker-authentication-shutdown-"),
  );
  const config: ServerConfig = {
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    appOrigins: ["http://127.0.0.1:5173"],
    authMode: "none",
    bootstrapMode: "pnpm-dev",
    dataDirectory,
    deploymentMode: "local",
    host: "127.0.0.1",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    workerToken: "different-development-token",
  };
  const database = await connectDatabase(config);
  const authenticated = deferred<void>();
  const finishAuthentication = deferred<void>();
  const lookingUpOwner = deferred<void>();
  const finishOwnerLookup = deferred<void>();
  const closeDatabase = vi.spyOn(database, "close");
  vi.spyOn(
    database.repository,
    "authenticateWorkerCredential",
  ).mockImplementation(async () => {
    authenticated.resolve();
    await finishAuthentication.promise;
    return {
      id: "shutdown-credential",
      ownerId: LOCAL_USER_ID,
      scopes: ["worker:connect"],
      workerId: "shutdown-worker",
    };
  });
  vi.spyOn(database.repository, "getWorkerOwnerId").mockImplementation(
    async () => {
      lookingUpOwner.resolve();
      await finishOwnerLookup.promise;
      if (state.lookupThrows)
        throw new Error("Controlled owner lookup failure");
      return null;
    },
  );
  const app = await buildApp({ config, database, logger: false });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    state,
    dataDirectory,
    app,
    origin,
    closeDatabase,
    authenticated,
    finishAuthentication,
    lookingUpOwner,
    finishOwnerLookup,
    socket: undefined as WebSocket | undefined,
  };
}

let fixture: Awaited<ReturnType<typeof createFixture>>;
// Cold WASM, full migrations and application startup use the same budget as
// the real-server fixture. The shutdown test bodies retain their deadlines.
beforeEach(async () => {
  const startedAt = performance.now();
  fixture = await createFixture();
  console.info(
    `Worker authentication fixture ready in ${Math.round(performance.now() - startedAt)}ms`,
  );
}, 60_000);
afterEach(async () => {
  fixture.finishAuthentication.resolve();
  fixture.finishOwnerLookup.resolve();
  fixture.socket?.terminate();
  await fixture.app.close();
  await rm(fixture.dataDirectory, { recursive: true, force: true });
});

it.each([false, true])(
  "drains a closed socket's authentication before database shutdown (lookup throws: %s)",
  async (lookupThrows) => {
    const {
      app,
      origin,
      closeDatabase,
      authenticated,
      finishAuthentication,
      lookingUpOwner,
      finishOwnerLookup,
    } = fixture;
    fixture.state.lookupThrows = lookupThrows;
    const socket = (fixture.socket = new WebSocket(
      `${origin.replace(/^http/, "ws")}/api/internal/workers/connect?workerId=shutdown-worker&connectionGeneration=11111111-1111-4111-8111-111111111111`,
      WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL,
      { headers: { authorization: "Bearer controlled-enrolled-credential" } },
    ));
    await once(socket, "open");
    await authenticated.promise;
    const closed = once(socket, "close");
    socket.close();
    await closed;

    const shutdown = app.close();
    await setImmediate();
    expect(closeDatabase).not.toHaveBeenCalled();
    finishAuthentication.resolve();
    await lookingUpOwner.promise;
    await setImmediate();
    expect(closeDatabase).not.toHaveBeenCalled();
    finishOwnerLookup.resolve();
    await shutdown;
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  },
);
