import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL } from "@cantrip/protocol";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { WorkerBridge } from "../src/workers/bridge.js";

it("configures reconnected workers under their credential owners in account mode", async () => {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-observation-owner-"),
  );
  const config: ServerConfig = {
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    appOrigins: ["http://127.0.0.1:5173"],
    authMode: "accounts",
    bootstrapMode: "pnpm-dev",
    dataDirectory,
    deploymentMode: "local",
    host: "127.0.0.1",
    port: 4310,
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  };
  const database = await connectDatabase(config);
  const owners = new Map([
    ["worker-one", "11111111-1111-4111-8111-111111111111"],
    ["worker-two", "22222222-2222-4222-8222-222222222222"],
  ]);
  vi.spyOn(
    database.repository,
    "authenticateWorkerCredential",
  ).mockImplementation(async (_credentialHash, workerId) => {
    return {
      id: workerId,
      ownerId: owners.get(workerId)!,
      workerId,
      scopes: ["worker:connect"],
    };
  });
  vi.spyOn(database.repository, "getWorkerOwnerId").mockImplementation(
    async (worker) => owners.get(worker) ?? null,
  );
  const targets = vi.spyOn(
    database.repository,
    "listWorkerWorktreeObservationTargets",
  );
  const roots = vi.spyOn(
    database.repository,
    "listWorkerExecutionRootContexts",
  );
  const bridge = new WorkerBridge();
  const requests = vi
    .spyOn(bridge, "request")
    .mockResolvedValue({ accepted: true, paths: [] });
  const app = await buildApp({
    config,
    database,
    workerBridge: bridge,
    logger: false,
  });
  const sockets: WebSocket[] = [];
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const [worker, owner] of owners) {
      const socket = new WebSocket(
        `${origin.replace(/^http/, "ws")}/api/internal/workers/connect?workerId=${worker}&connectionGeneration=33333333-3333-4333-8333-333333333333`,
        WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL,
        { headers: { authorization: `Bearer ${worker}` } },
      );
      sockets.push(socket);
      await once(socket, "open");
      await vi.waitFor(
        () => {
          expect(targets).toHaveBeenCalledWith(owner, worker);
          expect(roots).toHaveBeenCalledWith(owner, worker);
          expect(requests).toHaveBeenCalledWith(
            worker,
            {
              type: "worktree.observation.configure",
              targets: [],
              codegraphTargets: [],
            },
            { ownerId: owner },
          );
        },
        { timeout: 3000 },
      );
    }
    expect(targets.mock.calls).toEqual(
      [...owners].map(([worker, owner]) => [owner, worker]),
    );
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
}, 60_000);
