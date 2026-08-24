import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  directTunnelTicketSchema,
  tunnelAttachmentCreateResultSchema,
  tunnelAttachmentReadySchema,
  tunnelWireListSchema,
  tunnelWireSummarySchema,
  unprobedCodexRuntimeReport,
  type CodeRuntimeStatus,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { buildApp } from "../src/app.js";
import { CodeTunnelBroker } from "../src/code/tunnel.js";
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
const workerCommands: WorkerCommand[] = [];
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
    workerCommands.push(command);
    if (command.type === "direct.capability.prepare") {
      return { accepted: true, capabilityId: command.binding.capabilityId };
    }
    if (command.type === "direct.capability.revoke") {
      return { revoked: true };
    }
    if (command.type === "direct.capability.renew") {
      return { renewed: true, leaseExpiresAt: command.leaseExpiresAt };
    }
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};
const codeTunnel = new CodeTunnelBroker(workerBridge, { idleTtlMs: 60_000 });
const codeRuntime: CodeRuntimeStatus = {
  sessionId: "tunnel-control-plane-code-session",
  workspaceUri: "file:///worker/state/project.code-workspace",
  status: "running",
  editorBuild: {
    version: "1.109.5-cantrip.1",
    upstreamRevision: "a".repeat(40),
    patchset: 1,
    fingerprint: "b".repeat(64),
  },
  processInstanceId: "tunnel-control-plane-code-process",
  bridgeConnected: true,
  dirtyEditors: [],
  workbench: {
    activeEditor: null,
    git: null,
    conflicts: [],
    savePolicy: "always",
    agentStatus: "idle",
  },
  startedAt: "2026-08-08T12:00:00.000Z",
  lastActivityAt: "2026-08-08T12:00:00.000Z",
  lastError: null,
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let userTunnelId: string;
let managedTunnelId: string;
let otherOwnerId: string;
let codeAttachment: ReturnType<typeof tunnelAttachmentCreateResultSchema.parse>;

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
    directBroker: {
      available: true,
      protocol: "ws-v1",
      loopbackHost: "127.0.0.1",
      loopbackPort: 43123,
      instanceId: randomUUID(),
      publicKey: "a".repeat(43),
      fingerprint: "b".repeat(64),
      leaseRenewal: true,
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
  app = await buildApp({
    codeTunnel,
    config,
    database,
    logger: false,
    workerBridge,
  });
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
    expect(Date.parse(second.secretExpiresAt)).toBeGreaterThan(
      Date.parse(first.secretExpiresAt),
    );
    expect(await firstClosed).toBe(1008);
    expect(
      await app.inject({
        method: "POST",
        url: `/api/tunnel-attachments/${second.attachmentId}/lease`,
      }),
    ).toMatchObject({ statusCode: 204 });

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

    const protectedCodeTunnelId = randomUUID();
    const registration = {
      name: "Cantrip Code",
      description: null,
      projectId,
      origin: "code" as const,
      management: "managed-durable" as const,
      protocolHint: "http-websocket" as const,
      source: { kind: "desktop-loopback" as const },
      destination: {
        kind: "worker-adapter" as const,
        workerId: "worker-b",
        adapter: "code" as const,
        resourceId: protectedCodeTunnelId,
      },
      managedBy: { kind: "code" as const, id: protectedCodeTunnelId },
      desiredState: "started" as const,
      status: "active" as const,
    };
    const first = await database.repository.registerManagedTunnel(
      LOCAL_USER_ID,
      registration,
      {
        id: protectedCodeTunnelId,
        protectedRecord: protectedRecord(protectedCodeTunnelId, 1),
      },
    );
    const second = await database.repository.registerManagedTunnel(
      LOCAL_USER_ID,
      { ...registration, name: "Renamed by owner" },
      {
        id: protectedCodeTunnelId,
        protectedRecord: protectedRecord(randomUUID(), 2),
      },
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

  it("advances relay credential generations monotonically", async () => {
    const requestedSecretExpiry = new Date(Date.now() + 120_000);
    const expiresAt = new Date(Date.now() + 600_000);
    const first = await database.repository.createDesktopTunnelAttachment(
      LOCAL_USER_ID,
      userTunnelId,
      {
        clientId: "monotonic-relay-generation",
        expiresAt,
        secretExpiresAt: requestedSecretExpiry,
        secretHash: "first-secret-hash",
      },
    );
    const second = await database.repository.createDesktopTunnelAttachment(
      LOCAL_USER_ID,
      userTunnelId,
      {
        clientId: "monotonic-relay-generation",
        expiresAt,
        secretExpiresAt: requestedSecretExpiry,
        secretHash: "second-secret-hash",
      },
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.attachmentId).toBe(first!.attachmentId);
    expect(second!.secretExpiresAt.getTime()).toBeGreaterThan(
      first!.secretExpiresAt.getTime(),
    );
    await database.repository.stopDesktopTunnelAttachment(
      LOCAL_USER_ID,
      second!.attachmentId,
    );
  });

  it("fails closed for an orphaned Code tunnel without its broker root", async () => {
    const tunnelId = randomUUID();
    await database.repository.registerManagedTunnel(
      LOCAL_USER_ID,
      {
        name: "Orphaned Cantrip Code",
        description: null,
        projectId,
        origin: "code",
        management: "managed-ephemeral",
        protocolHint: "http-websocket",
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-adapter",
          workerId: "worker-b",
          adapter: "code",
          resourceId: tunnelId,
        },
        managedBy: { kind: "code", id: tunnelId },
        desiredState: "started",
        status: "starting",
      },
      { id: tunnelId, protectedRecord: protectedRecord(tunnelId, 1) },
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/attachments`,
      payload: { clientId: "orphaned-code-client" },
    });
    expect(response.statusCode, response.body).toBe(409);
    const orphanedAttachment =
      await database.repository.createDesktopTunnelAttachment(
        LOCAL_USER_ID,
        tunnelId,
        {
          clientId: "orphaned-code-client",
          expiresAt: new Date(Date.now() + 60_000),
          secretExpiresAt: new Date(Date.now() + 30_000),
          secretHash: "orphaned-code-secret-hash",
        },
      );
    expect(orphanedAttachment).not.toBeNull();
    expect(
      await app.inject({
        method: "POST",
        url: `/api/tunnel-attachments/${orphanedAttachment!.attachmentId}/lease`,
      }),
    ).toMatchObject({ statusCode: 409 });
    await database.repository.stopDesktopTunnelAttachment(
      LOCAL_USER_ID,
      orphanedAttachment!.attachmentId,
    );
    await database.repository.removeManagedTunnel(LOCAL_USER_ID, {
      kind: "code",
      id: tunnelId,
    });
  });

  it("attaches desktops to protected Cantrip Code tunnels", async () => {
    const tunnelId = randomUUID();
    await codeTunnel.createProtectedAttachment({
      authSessionId: null,
      codeTabId: "tunnel-control-plane-code-tab",
      ownerId: LOCAL_USER_ID,
      projectId,
      protectedRecord: protectedRecord(tunnelId, 1),
      runtime: codeRuntime,
      serverId: await database.repository.getOrCreateServerId(),
      sessionId: codeRuntime.sessionId,
      tunnelId,
      workerId: "worker-b",
      worktreeId: "tunnel-control-plane-worktree",
      worktreePath: "/test/tunnel-control-plane-worktree",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/tunnels/${tunnelId}/attachments`,
      payload: { clientId: "desktop-code-test" },
    });
    expect(response.statusCode).toBe(201);
    const attachment = tunnelAttachmentCreateResultSchema.parse(
      response.json(),
    );
    codeAttachment = attachment;
    expect(attachment.tunnelId).toBe(tunnelId);
    expect(
      await app.inject({
        method: "POST",
        url: `/api/tunnel-attachments/${attachment.attachmentId}/lease`,
      }),
    ).toMatchObject({ statusCode: 204 });
    await expect(
      database.repository.getDesktopTunnelAttachment(
        LOCAL_USER_ID,
        attachment.attachmentId,
      ),
    ).resolves.toMatchObject({
      destination: {
        kind: "worker-adapter",
        workerId: "worker-b",
        adapter: "code",
        resourceId: tunnelId,
      },
      tunnelId,
    });
  });

  it("preserves the relay credential after direct route activation", async () => {
    const commandCount = workerCommands.length;
    const invalid = await app.inject({
      method: "POST",
      url: `/api/tunnel-attachments/${codeAttachment.attachmentId}/direct`,
      payload: { diagnosticTraceId: "not-a-uuid" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(workerCommands).toHaveLength(commandCount);

    const diagnosticTraceId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/api/tunnel-attachments/${codeAttachment.attachmentId}/direct`,
      payload: { diagnosticTraceId },
    });
    expect(response.statusCode, response.body).toBe(201);
    const command = workerCommands.at(-1);
    expect(command).toMatchObject({
      type: "direct.capability.prepare",
      diagnosticTraceId,
    });
    expect(
      command?.type === "direct.capability.prepare" ? command.binding : {},
    ).not.toHaveProperty("diagnosticTraceId");

    const responseBody = response.json();
    expect(responseBody).not.toHaveProperty("diagnosticTraceId");
    const ticket = directTunnelTicketSchema.parse(responseBody);
    expect(ticket.binding.attachmentId).toBe(codeAttachment.attachmentId);
    expect(ticket.binding).not.toHaveProperty("diagnosticTraceId");

    const activation = await app.inject({
      method: "POST",
      url: `/api/tunnel-attachments/${codeAttachment.attachmentId}/direct-activate`,
      payload: { capabilityId: ticket.binding.capabilityId },
    });
    expect(activation.statusCode, activation.body).toBe(204);
    const renewalsBefore = workerCommands.filter(
      (candidate) => candidate.type === "direct.capability.renew",
    ).length;
    const telemetry = await app.inject({
      method: "POST",
      url: `/api/direct-attachments/${ticket.binding.capabilityId}/telemetry`,
      payload: {
        bytesFromLocal: 0,
        bytesToLocal: 0,
        connectionsClosed: 0,
        connectionsOpened: 0,
      },
    });
    expect(telemetry.statusCode, telemetry.body).toBe(204);
    expect(
      workerCommands.filter(
        (candidate) => candidate.type === "direct.capability.renew",
      ),
    ).toHaveLength(renewalsBefore + 1);

    let relayClient: WebSocket | null = null;
    const readyMessages: unknown[] = [];
    const relaySocket = await app.injectWS(
      codeAttachment.connectPath,
      { headers: { authorization: `Bearer ${codeAttachment.secret}` } },
      {
        onInit(client) {
          relayClient = client;
          client.on("message", (data, binary) => {
            if (!binary) readyMessages.push(JSON.parse(data.toString()));
          });
        },
      },
    );
    if (!relayClient) throw new Error("Relay socket did not initialize.");
    relayClient.send(
      JSON.stringify({ type: "initialize", clientId: "desktop-code-test" }),
    );
    await expect.poll(() => readyMessages.length).toBe(1);
    expect(tunnelAttachmentReadySchema.parse(readyMessages[0])).toMatchObject({
      attachmentId: codeAttachment.attachmentId,
      tunnelId: codeAttachment.tunnelId,
    });

    const releaseDirect = await app.inject({
      method: "DELETE",
      url: `/api/direct-attachments/${ticket.binding.capabilityId}`,
    });
    expect(releaseDirect.statusCode, releaseDirect.body).toBe(204);
    const releaseDirectAgain = await app.inject({
      method: "DELETE",
      url: `/api/direct-attachments/${ticket.binding.capabilityId}`,
    });
    expect(releaseDirectAgain.statusCode, releaseDirectAgain.body).toBe(204);
    expect(relayClient.readyState).toBe(1);
    expect(workerCommands.at(-1)).toMatchObject({
      type: "direct.capability.revoke",
      capabilityId: ticket.binding.capabilityId,
    });

    relaySocket.terminate();
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
