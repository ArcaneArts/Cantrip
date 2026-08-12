import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  tunnelListSchema,
  tunnelSummarySchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-tunnel-control-plane-"),
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
  workerToken: "test-worker-token",
};
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected() {
    return false;
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(_workerId, command) {
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let userTunnelId: string;
let managedTunnelId: string;

async function recordWorker(ownerId: string, workerId: string): Promise<void> {
  await database.repository.recordWorker(ownerId, {
    workerId,
    name: workerId,
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  database = await connectDatabase(config);
  await recordWorker(LOCAL_USER_ID, "worker-a");
  await recordWorker(LOCAL_USER_ID, "worker-b");
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "worker-a",
    repositoryId: "tunnel-control-plane",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  app = await buildApp({ config, database, logger: false, workerBridge });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("tunnel control plane", () => {
  it("creates a user tunnel with routing independent of its project", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tunnels",
      payload: {
        name: "Vite on worker B",
        projectId,
        protocolHint: "http-websocket",
        destination: {
          kind: "worker-tcp",
          workerId: "worker-b",
          port: 5173,
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const tunnel = tunnelSummarySchema.parse(response.json());
    userTunnelId = tunnel.id;
    expect(tunnel).toMatchObject({
      projectId,
      source: { kind: "desktop-loopback" },
      destination: { kind: "worker-tcp", workerId: "worker-b", port: 5173 },
      management: "user-managed",
      capabilities: { canEdit: true, canDelete: true, canOpenOwner: false },
    });

    const global = await app.inject({ method: "GET", url: "/api/tunnels" });
    const project = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/tunnels`,
    });
    expect(tunnelListSchema.parse(global.json())).toHaveLength(1);
    expect(tunnelListSchema.parse(project.json())).toHaveLength(1);
  });

  it("validates project and worker ownership without leaking either", async () => {
    const account = await database.repository.createAccount({
      displayName: "Another Owner",
      email: "other@example.test",
      normalizedEmail: "other@example.test",
      passwordHash: "unused-test-hash",
      role: "member",
    });
    await recordWorker(account.id, "other-worker");

    expect(
      await database.repository.getTunnel(account.id, userTunnelId),
    ).toBeNull();
    expect(
      await database.repository.createUserTunnel(account.id, {
        name: "Cross-owner attempt",
        description: null,
        projectId: null,
        protocolHint: "tcp",
        destination: {
          kind: "worker-tcp",
          workerId: "worker-b",
          host: "127.0.0.1",
          port: 5173,
        },
      }),
    ).toBeNull();

    const missing = await app.inject({
      method: "POST",
      url: "/api/tunnels",
      payload: {
        name: "Missing destination",
        protocolHint: "tcp",
        destination: {
          kind: "worker-tcp",
          workerId: "missing-worker",
          port: 3000,
        },
      },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("registers managed tunnels idempotently and protects owner lifecycle", async () => {
    const registration = {
      name: "Cantrip Code",
      description: null,
      projectId,
      origin: "code" as const,
      management: "managed-durable" as const,
      protocolHint: "http-websocket" as const,
      source: { kind: "server-http" as const, adapter: "code" as const },
      destination: {
        kind: "worker-adapter" as const,
        workerId: "worker-b",
        adapter: "code" as const,
        resourceId: "code-tab-1",
      },
      managedBy: { kind: "code" as const, id: "code-tab-1" },
      desiredState: "started" as const,
      status: "active" as const,
    };
    const first = await database.repository.registerManagedTunnel(
      LOCAL_USER_ID,
      registration,
    );
    const second = await database.repository.registerManagedTunnel(
      LOCAL_USER_ID,
      { ...registration, name: "Renamed by owner" },
    );
    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(second).toMatchObject({
      name: "Renamed by owner",
      capabilities: {
        canEdit: false,
        canDelete: false,
        canStart: false,
        canStop: false,
        canAttach: false,
        canOpenOwner: true,
      },
    });
    managedTunnelId = second?.id ?? "";

    const update = await app.inject({
      method: "PATCH",
      url: `/api/tunnels/${managedTunnelId}`,
      payload: { name: "User override" },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/tunnels/${managedTunnelId}`,
    });
    expect(update.statusCode).toBe(409);
    expect(remove.statusCode).toBe(409);
  });

  it("clears organizational project links without deleting tunnels", async () => {
    expect(
      await database.repository.deleteProject(LOCAL_USER_ID, projectId),
    ).toBe(true);
    expect(
      (await database.repository.getTunnel(LOCAL_USER_ID, userTunnelId))
        ?.projectId,
    ).toBeNull();
    expect(
      (await database.repository.getTunnel(LOCAL_USER_ID, managedTunnelId))
        ?.projectId,
    ).toBeNull();
  });

  it("updates and deletes user-managed tunnels through owner APIs", async () => {
    const update = await app.inject({
      method: "PATCH",
      url: `/api/tunnels/${userTunnelId}`,
      payload: { name: "Updated tunnel", projectId: null },
    });
    expect(update.statusCode).toBe(200);
    expect(tunnelSummarySchema.parse(update.json()).name).toBe(
      "Updated tunnel",
    );

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/tunnels/${userTunnelId}`,
    });
    expect(remove.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/tunnels/${userTunnelId}`,
        })
      ).statusCode,
    ).toBe(404);
  });
});
