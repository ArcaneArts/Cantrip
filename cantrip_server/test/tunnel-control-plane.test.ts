import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  tunnelAttachmentCreateResultSchema,
  tunnelAttachmentReadySchema,
  tunnelWireListSchema,
  tunnelWireSummarySchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import { protectedProjectFields } from "./private-label-fixture.js";

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
  isConnected(workerId) {
    return workerId === "worker-b";
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
let otherOwnerId: string;

function protectedRecord(operationId: string, revision: number) {
  return {
    operationId,
    revision,
    protectedContent: {
      formatVersion: 1,
      domain: "tunnel-content" as const,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM" as const,
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
        ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      },
    },
  };
}

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
    ...protectedProjectFields(),
    repositoryId: "tunnel-control-plane",
    repositoryBlindIndex: "a".repeat(64),
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
    userTunnelId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/api/tunnels",
      payload: {
        id: userTunnelId,
        projectId,
        protocolHint: "http-websocket",
        destination: {
          kind: "worker-tcp",
          workerId: "worker-b",
        },
        protectedRecord: protectedRecord(userTunnelId, 1),
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const tunnel = tunnelWireSummarySchema.parse(response.json());
    expect(tunnel).toMatchObject({
      projectId,
      source: { kind: "desktop-loopback" },
      destination: { kind: "worker-tcp", workerId: "worker-b" },
      management: "user-managed",
      capabilities: { canEdit: true, canDelete: true, canOpenOwner: false },
    });

    const global = await app.inject({ method: "GET", url: "/api/tunnels" });
    const project = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/tunnels`,
    });
    expect(tunnelWireListSchema.parse(global.json())).toHaveLength(1);
    expect(tunnelWireListSchema.parse(project.json())).toHaveLength(1);
  });

  it("validates project and worker ownership without leaking either", async () => {
    const account = await database.repository.createAccount({
      displayName: "Another Owner",
      email: "other@example.test",
      normalizedEmail: "other@example.test",
      passwordHash: "unused-test-hash",
      role: "member",
    });
    otherOwnerId = account.id;
    await recordWorker(account.id, "other-worker");
    const crossOwnerTunnelId = randomUUID();

    expect(
      await database.repository.getTunnel(account.id, userTunnelId),
    ).toBeNull();
    expect(
      await database.repository.createUserTunnel(account.id, {
        id: crossOwnerTunnelId,
        projectId: null,
        protocolHint: "tcp",
        destination: {
          kind: "worker-tcp",
          workerId: "worker-b",
        },
        protectedRecord: protectedRecord(crossOwnerTunnelId, 1),
      }),
    ).toBeNull();

    const missingTunnelId = randomUUID();
    const missing = await app.inject({
      method: "POST",
      url: "/api/tunnels",
      payload: {
        id: missingTunnelId,
        protocolHint: "tcp",
        destination: {
          kind: "worker-tcp",
          workerId: "missing-worker",
        },
        protectedRecord: protectedRecord(missingTunnelId, 1),
      },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("authenticates, rotates, and revokes short-lived desktop attachments", async () => {
    const create = async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/tunnels/${userTunnelId}/attachments`,
        payload: { clientId: "desktop-test" },
      });
      expect(response.statusCode).toBe(201);
      return tunnelAttachmentCreateResultSchema.parse(response.json());
    };
    const first = await create();
    expect(first.connectPath).not.toContain(first.secret);
    expect(
      await database.repository.stopDesktopTunnelAttachment(
        otherOwnerId,
        first.attachmentId,
      ),
    ).toBeNull();

    let unauthorizedClose: Promise<number>;
    const unauthorized = await app.injectWS(
      first.connectPath,
      { headers: { authorization: "Bearer invalid-credential" } },
      {
        onInit(client) {
          unauthorizedClose = new Promise((resolve) =>
            client.once("close", resolve),
          );
        },
      },
    );
    expect(await unauthorizedClose!).toBe(1008);
    unauthorized.terminate();

    let firstClient: WebSocket | null = null;
    const readyMessages: unknown[] = [];
    const firstSocket = await app.injectWS(
      first.connectPath,
      { headers: { authorization: `Bearer ${first.secret}` } },
      {
        onInit(client) {
          firstClient = client;
          client.on("message", (data, binary) => {
            if (!binary) readyMessages.push(JSON.parse(data.toString()));
          });
        },
      },
    );
    if (!firstClient) throw new Error("Tunnel test socket did not initialize.");
    firstClient.send(
      JSON.stringify({
        type: "initialize",
        clientId: "desktop-test",
      }),
    );
    await expect.poll(() => readyMessages.length).toBe(1);
    expect(tunnelAttachmentReadySchema.parse(readyMessages[0])).toMatchObject({
      attachmentId: first.attachmentId,
      tunnelId: userTunnelId,
    });
    expect(
      (await database.repository.getTunnel(LOCAL_USER_ID, userTunnelId))
        ?.attachments[0],
    ).toMatchObject({
      status: "active",
    });

    const editWhileActive = await app.inject({
      method: "PATCH",
      url: `/api/tunnels/${userTunnelId}`,
      payload: { protectedRecord: protectedRecord(randomUUID(), 2) },
    });
    expect(editWhileActive.statusCode).toBe(409);

    const firstClosed = new Promise<number>((resolve) =>
      firstClient!.once("close", resolve),
    );
    const second = await create();
    expect(second.attachmentId).toBe(first.attachmentId);
    expect(await firstClosed).toBe(1008);

    let staleClose: Promise<number>;
    const stale = await app.injectWS(
      first.connectPath,
      { headers: { authorization: `Bearer ${first.secret}` } },
      {
        onInit(client) {
          staleClose = new Promise((resolve) => client.once("close", resolve));
        },
      },
    );
    expect(await staleClose!).toBe(1008);
    stale.terminate();

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/tunnel-attachments/${second.attachmentId}`,
    });
    expect(revoke.statusCode).toBe(204);
    expect(
      (await database.repository.getTunnel(LOCAL_USER_ID, userTunnelId))
        ?.status,
    ).toBe("stopped");
    firstSocket.terminate();

    const expired = await database.repository.createDesktopTunnelAttachment(
      LOCAL_USER_ID,
      userTunnelId,
      {
        clientId: "desktop-expired",
        expiresAt: new Date(Date.now() - 1_000),
        secretExpiresAt: new Date(Date.now() - 2_000),
        secretHash: "expired-attachment-secret-hash",
      },
    );
    expect(expired).not.toBeNull();
    expect(await database.repository.expireDesktopTunnelAttachments()).toEqual([
      expect.objectContaining({
        attachmentId: expired!.attachmentId,
        tunnelId: userTunnelId,
      }),
    ]);
    expect(
      (await database.repository.getTunnel(LOCAL_USER_ID, userTunnelId))
        ?.status,
    ).toBe("failed");
  });

  it("registers managed tunnels idempotently and protects owner lifecycle", async () => {
    await expect(
      database.repository.registerManagedTunnel(LOCAL_USER_ID, {
        name: "Private relay",
        description: null,
        projectId,
        origin: "system",
        management: "managed-durable",
        protocolHint: "tcp",
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-tcp",
          workerId: "worker-b",
        },
        managedBy: { kind: "system", id: "private-relay-1" },
        desiredState: "started",
        status: "starting",
      }),
    ).rejects.toThrow(/protected content/u);

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
      payload: { protectedRecord: protectedRecord(randomUUID(), 1) },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/tunnels/${managedTunnelId}`,
    });
    expect(update.statusCode).toBe(409);
    expect(remove.statusCode).toBe(409);
  });

  it("persists and independently revokes managed server relays", async () => {
    const codeRelay = await database.repository.registerManagedTunnel(
      LOCAL_USER_ID,
      {
        name: "Cantrip Code",
        description: "Server-terminated Code access.",
        projectId,
        origin: "code",
        management: "managed-ephemeral",
        protocolHint: "http-websocket",
        source: { kind: "server-http", adapter: "code" },
        destination: {
          kind: "worker-adapter",
          workerId: "worker-b",
          adapter: "code",
          resourceId: "code-relay-1",
        },
        managedBy: { kind: "code", id: "code-relay-1" },
        desiredState: "started",
        status: "starting",
      },
    );
    expect(codeRelay).not.toBeNull();
    expect(
      await database.repository.createManagedServerRelayAttachment(
        LOCAL_USER_ID,
        codeRelay!.id,
        "share-1",
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    await database.repository.touchManagedServerRelay(otherOwnerId, "share-1", {
      activeConnectionDelta: 99,
      bytesFromSource: 999,
    });
    await database.repository.touchManagedServerRelay(
      LOCAL_USER_ID,
      "share-1",
      {
        activeConnectionDelta: 1,
        bytesFromSource: 123,
        bytesToSource: 456,
      },
    );
    const global = tunnelWireListSchema.parse(
      (await app.inject({ method: "GET", url: "/api/tunnels" })).json(),
    );
    const project = tunnelWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tunnels`,
        })
      ).json(),
    );
    const persisted = global.find(({ id }) => id === codeRelay!.id);
    expect(persisted).toMatchObject({
      projectId,
      origin: "code",
      status: "active",
      activeConnectionCount: 1,
      bytesFromSource: 123,
      bytesToSource: 456,
      attachments: [
        {
          id: "share-1",
          kind: "server-relay",
          status: "active",
          clientId: null,
        },
      ],
    });
    expect(project.some(({ id }) => id === codeRelay!.id)).toBe(true);
    expect(
      await database.repository.createManagedServerRelayAttachment(
        LOCAL_USER_ID,
        codeRelay!.id,
        "share-2",
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    await database.repository.touchManagedServerRelay(
      LOCAL_USER_ID,
      "share-2",
      { activeConnectionDelta: 2 },
    );
    expect(
      (await database.repository.getTunnel(LOCAL_USER_ID, codeRelay!.id))
        ?.activeConnectionCount,
    ).toBe(3);
    expect(
      await database.repository.removeManagedServerRelayAttachment(
        otherOwnerId,
        "share-1",
      ),
    ).toBeNull();
    expect(
      await database.repository.removeManagedServerRelayAttachment(
        LOCAL_USER_ID,
        "share-1",
      ),
    ).toMatchObject({ tunnelId: codeRelay!.id, tunnelRemoved: false });
    expect(
      await database.repository.getTunnel(LOCAL_USER_ID, codeRelay!.id),
    ).toMatchObject({
      activeConnectionCount: 2,
      attachments: [expect.objectContaining({ id: "share-2" })],
    });
    expect(
      await database.repository.removeManagedServerRelayAttachment(
        LOCAL_USER_ID,
        "share-2",
      ),
    ).toMatchObject({ tunnelId: codeRelay!.id, tunnelRemoved: true });
    expect(
      await database.repository.getTunnel(LOCAL_USER_ID, codeRelay!.id),
    ).toBeNull();
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
      payload: {
        projectId: null,
        protectedRecord: protectedRecord(randomUUID(), 2),
      },
    });
    expect(update.statusCode).toBe(200);
    expect(
      tunnelWireSummarySchema.parse(update.json()).protectedRecord?.revision,
    ).toBe(2);

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
