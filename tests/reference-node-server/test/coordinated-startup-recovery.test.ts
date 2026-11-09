import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import {
  createInMemoryRelayCoordinatorBackend,
  InMemoryRelayCoordinator,
} from "../src/coordination/relay-coordinator.js";
import { connectDatabase } from "../src/db/index.js";

const dataDirectories: string[] = [];

async function testConfig(instanceId: string): Promise<ServerConfig> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-coordinated-startup-"),
  );
  dataDirectories.push(dataDirectory);
  return {
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
    serverInstanceId: instanceId,
    workerToken: "test-worker-token",
  };
}

afterAll(async () => {
  await Promise.all(
    dataDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("coordinated startup recovery", () => {
  it("performs global recovery when it is the only server instance", async () => {
    const config = await testConfig("instance-solo");
    const database = await connectDatabase(config);
    const coordinator = new InMemoryRelayCoordinator(
      "instance-solo",
      createInMemoryRelayCoordinatorBackend(),
    );
    await coordinator.start();
    const resetSurfaces = vi.spyOn(
      database.repository,
      "resetTransientRemoteSurfaceStatuses",
    );
    const resetTunnels = vi.spyOn(
      database.repository,
      "resetTransientTunnelAttachments",
    );
    const resetChats = vi.spyOn(
      database.repository,
      "resetInterruptedChatExecutions",
    );
    const app = await buildApp({
      config,
      coordinator,
      database,
      logger: false,
    });

    expect(resetSurfaces).toHaveBeenCalledOnce();
    expect(resetTunnels).toHaveBeenCalledOnce();
    expect(resetChats).toHaveBeenCalledOnce();
    await app.close();
  });

  it("preserves transient state owned by an existing peer", async () => {
    const config = await testConfig("instance-new");
    const database = await connectDatabase(config);
    const backend = createInMemoryRelayCoordinatorBackend();
    const peer = new InMemoryRelayCoordinator("instance-peer", backend);
    const coordinator = new InMemoryRelayCoordinator("instance-new", backend);
    await peer.start();
    await coordinator.start();
    const resetSurfaces = vi.spyOn(
      database.repository,
      "resetTransientRemoteSurfaceStatuses",
    );
    const resetTunnels = vi.spyOn(
      database.repository,
      "resetTransientTunnelAttachments",
    );
    const resetChats = vi.spyOn(
      database.repository,
      "resetInterruptedChatExecutions",
    );

    const app = await buildApp({
      config,
      coordinator,
      database,
      logger: false,
    });

    expect(resetSurfaces).not.toHaveBeenCalled();
    expect(resetTunnels).not.toHaveBeenCalled();
    expect(resetChats).not.toHaveBeenCalled();
    await app.close();
    await peer.close();
  });
});
