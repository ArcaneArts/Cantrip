import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  decodeTunnelDataPlaneFrame,
  directBrokerReadySchema,
  encodeTunnelDataPlaneFrame,
  type EncryptionKeyGrant,
  type EncryptionPrincipal,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import {
  tunnelContentRecordSchema,
  type TunnelDataProtectionConfiguration,
} from "@cantrip/protocol/tunnel-content";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import { CodeDirectEndpointManager } from "../src/code/direct-endpoint.js";
import type { CodeSupervisor } from "../src/code/supervisor.js";
import { DirectBroker } from "../src/direct-broker.js";
import { protectWorkerEndpointContent } from "../src/endpoint-content-encryption.js";
import { subscribeWorkerLogs } from "../src/logger.js";
import type { ProjectShareManager } from "../src/project-share-manager.js";
import { TunnelDestinationRouter } from "../src/tunnel-destination-router.js";
import {
  openTunnelDataFrame,
  sealTunnelDataFrame,
} from "../src/tunnel-data-protection.js";
import { TunnelTcpDestinationAdapter } from "../src/tunnel-tcp-adapter.js";
import { WorkerEncryptionService } from "../src/worker-encryption.js";

const ownerId = "owner-code-transport";
const serverId = "https://cantrip.test";
const workerId = "worker-code-1";
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function encryptionService(): Promise<WorkerEncryptionService> {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-code-transport-"),
  );
  cleanup.push(() => rm(dataDirectory, { recursive: true }));
  const worker = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl: serverId,
    workerId,
  });
  const registration = worker.registration();
  const now = "2026-08-23T12:00:00.000Z";
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: "Code transport worker",
    publicKey: registration.publicKey,
    state: "approved",
    revision: 1,
    approvedAt: now,
    revokedAt: null,
    revokedReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const componentKey = deriveComponentKey({
    accountMasterKey: generateAccountMasterKey(),
    ownerId,
    component: "tunnel-content",
    keyRevision: 1,
  });
  const grant: EncryptionKeyGrant = {
    id: randomUUID(),
    ownerId,
    principalId: principal.id,
    component: "tunnel-content",
    keyRevision: 1,
    wrappedKey: await wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component: "tunnel-content",
      componentKey,
      keyRevision: 1,
      workerPublicKey: principal.publicKey,
    }),
    state: "active",
    revision: 1,
    revokedAt: null,
    revokedReason: null,
    createdAt: now,
    updatedAt: now,
  };
  await worker.acceptBootstrap({ ownerId, principal, grants: [grant] });
  return worker;
}

function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

async function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/direct/v1`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("protected Code direct transport", () => {
  it("carries health and OpenVSCode HTTP through the composed worker route", async () => {
    let observed: IncomingMessage | null = null;
    const editor = createServer((request, response) => {
      observed = request;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("editor-ready");
    });
    await new Promise<void>((resolve) =>
      editor.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => editor.close(() => resolve())),
    );
    const editorPort = (editor.address() as AddressInfo).port;
    const connectionToken = "transport-token-must-stay-private";
    const workspaceUri = "file:///worker/private/project.code-workspace";
    const supervisor = {
      beginTunnelStream: vi.fn(),
      endTunnelStream: vi.fn(),
      proxyTarget: vi.fn(() => ({
        codeTabId: "code-1",
        connectionToken,
        editorOrigin: `http://127.0.0.1:${editorPort}`,
        processInstanceId: "process-1",
        workspaceUri,
      })),
    } as unknown as CodeSupervisor;
    const codeEndpoints = new CodeDirectEndpointManager(supervisor);
    cleanup.push(() => codeEndpoints.close());
    const tcp = new TunnelTcpDestinationAdapter();
    cleanup.push(() => tcp.close());
    const encryption = await encryptionService();
    const router = new TunnelDestinationRouter(
      tcp,
      { open: vi.fn() } as unknown as ProjectShareManager,
      codeEndpoints,
      encryption,
      workerId,
    );
    cleanup.push(() => router.close());
    const broker = new DirectBroker();
    cleanup.push(() => broker.close());
    broker.setTunnelFrameHandler((header, payload, diagnostics) =>
      router.handleFrame(header, payload, diagnostics),
    );
    router.setFrameEmitter(
      (header, payload) => broker.routeTunnelFrame(header, payload) ?? false,
      async (attachmentId) =>
        (await broker.waitForTunnelCapacity(attachmentId)) ?? false,
    );
    const advertisement = await broker.start();
    if (!advertisement.available) throw new Error("Direct broker unavailable");

    const tunnelId = randomUUID();
    const attachmentId = randomUUID();
    const sessionId = randomUUID();
    const operationId = randomUUID();
    const diagnosticTraceId = randomUUID();
    const dataProtection: TunnelDataProtectionConfiguration = {
      formatVersion: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      key: randomBytes(32).toString("base64url"),
    };
    const content = tunnelContentRecordSchema.parse({
      name: "Code transport",
      description: null,
      source: { kind: "desktop-loopback" },
      destination: {
        kind: "worker-code",
        workerId,
        resourceId: tunnelId,
        sessionId,
      },
      dataProtection,
    });
    const protectedContent = await protectWorkerEndpointContent({
      context: {
        domain: "tunnel-content",
        serverId,
        workerId,
        scopeId: JSON.stringify(["tunnel", tunnelId]),
        operationId,
        operation: "tunnel.record",
        direction: "stored",
        sequence: 1,
      },
      content,
      schema: tunnelContentRecordSchema,
      service: encryption,
    });
    const protectedRecord = {
      operationId,
      revision: 1,
      protectedContent,
    };
    const capabilityId = randomUUID();
    const binding = {
      capabilityId,
      ownerId,
      authSessionId: "auth-session-1",
      workerId,
      resourceKind: "tunnel" as const,
      resourceId: tunnelId,
      attachmentId,
      channels: ["tunnel-data"],
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const route = {
      tunnelId,
      attachmentId,
      sourceEndpointId: `desktop:client:${attachmentId}`,
      destinationEndpointId: `worker:${workerId}`,
      target: {
        kind: "protected-tunnel" as const,
        targetKind: "code" as const,
        recordId: tunnelId,
        protectedRecord,
      },
    };
    const secret = randomBytes(32).toString("base64url");
    const records: Array<{ context?: unknown }> = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    cleanup.push(unsubscribe);
    await broker.prepare({
      type: "direct.capability.prepare",
      binding,
      diagnosticTraceId,
      secret,
      tunnelRoute: route,
    });

    const socket = await connect(advertisement.loopbackPort);
    cleanup.push(() => socket.terminate());
    const messages: Array<{ data: Buffer; binary: boolean }> = [];
    socket.on("message", (data, binary) =>
      messages.push({ data: rawBytes(data), binary }),
    );
    socket.send(
      JSON.stringify({
        type: "initialize",
        binding,
        secret,
        challenge: randomBytes(32).toString("base64url"),
      }),
    );
    await vi.waitFor(() => {
      const ready = messages.find((message) => !message.binary);
      expect(ready).toBeDefined();
      directBrokerReadySchema.parse(JSON.parse(ready!.data.toString("utf8")));
    });

    const decodedFrames = () =>
      messages
        .filter((message) => message.binary)
        .map((message) => decodeTunnelDataPlaneFrame(message.data));
    const responseText = (connectionId: string) =>
      Buffer.concat(
        decodedFrames()
          .filter(
            (frame) =>
              frame.header.connectionId === connectionId &&
              frame.header.kind === "data" &&
              frame.header.direction === "destination-to-source",
          )
          .map((frame) => {
            if (frame.header.kind !== "data") return Buffer.alloc(0);
            return Buffer.from(
              openTunnelDataFrame(dataProtection, frame.header, frame.payload),
            );
          }),
      ).toString("utf8");
    const request = async (requestPath: string, expected: string) => {
      const connectionId = randomUUID();
      const open: TunnelDataPlaneFrameHeader = {
        protocolVersion: 1,
        tunnelId,
        attachmentId,
        sourceEndpointId: route.sourceEndpointId,
        destinationEndpointId: route.destinationEndpointId,
        connectionId,
        sequence: 0,
        kind: "open",
        initialCreditBytes: 256 * 1_024,
      };
      socket.send(encodeTunnelDataPlaneFrame(open, new Uint8Array()));
      await vi.waitFor(() =>
        expect(
          decodedFrames().some(
            (frame) =>
              frame.header.connectionId === connectionId &&
              frame.header.kind === "accepted",
          ),
        ).toBe(true),
      );
      const plainHeader: Extract<TunnelDataPlaneFrameHeader, { kind: "data" }> =
        {
          protocolVersion: 1,
          tunnelId,
          attachmentId,
          sourceEndpointId: route.sourceEndpointId,
          destinationEndpointId: route.destinationEndpointId,
          connectionId,
          sequence: 1,
          kind: "data",
          direction: "source-to-destination",
        };
      const sealed = sealTunnelDataFrame(
        dataProtection,
        plainHeader,
        Buffer.from(
          `GET ${requestPath} HTTP/1.1\r\nHost: cantrip-code.local\r\nConnection: close\r\n\r\n`,
          "utf8",
        ),
      );
      socket.send(encodeTunnelDataPlaneFrame(sealed.header, sealed.payload));
      await vi.waitFor(() =>
        expect(responseText(connectionId)).toContain(expected),
      );
      return connectionId;
    };

    const healthConnectionIds: string[] = [];
    const proxyConnectionIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      healthConnectionIds.push(
        await request("/code/_cantrip/health", '{"status":"ok"}'),
      );
      proxyConnectionIds.push(await request("/code/", "editor-ready"));
    }

    const rejectedConnectionId = randomUUID();
    const prepareFailure = vi
      .spyOn(codeEndpoints, "prepareProtected")
      .mockRejectedValueOnce(new Error("forced endpoint preparation failure"));
    const rejectedOpen: TunnelDataPlaneFrameHeader = {
      protocolVersion: 1,
      tunnelId,
      attachmentId,
      sourceEndpointId: route.sourceEndpointId,
      destinationEndpointId: route.destinationEndpointId,
      connectionId: rejectedConnectionId,
      sequence: 0,
      kind: "open",
      initialCreditBytes: 256 * 1_024,
    };
    socket.send(encodeTunnelDataPlaneFrame(rejectedOpen, new Uint8Array()));
    await vi.waitFor(() =>
      expect(
        decodedFrames().some(
          (frame) =>
            frame.header.connectionId === rejectedConnectionId &&
            frame.header.kind === "rejected" &&
            frame.header.code === "protected-endpoint-unavailable",
        ),
      ).toBe(true),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.send(
      encodeTunnelDataPlaneFrame(
        {
          protocolVersion: 1,
          tunnelId,
          attachmentId,
          sourceEndpointId: route.sourceEndpointId,
          destinationEndpointId: route.destinationEndpointId,
          connectionId: rejectedConnectionId,
          sequence: 1,
          kind: "close",
          code: "normal",
        },
        new Uint8Array(),
      ),
    );
    prepareFailure.mockRestore();
    healthConnectionIds.push(
      await request("/code/_cantrip/health", '{"status":"ok"}'),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);

    expect(observed?.url).toBe(
      "/?workspace=%2Fworker%2Fprivate%2Fproject.code-workspace",
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: expect.objectContaining({
            event: "direct.connection.accepted",
            diagnosticTraceId,
            tunnelId,
            connectionId: healthConnectionIds[0],
          }),
        }),
        expect.objectContaining({
          context: expect.objectContaining({
            event: "code.direct.prepared",
            diagnosticTraceId,
            tunnelId,
            sessionId,
            connectionId: healthConnectionIds[0],
          }),
        }),
        expect.objectContaining({
          context: expect.objectContaining({
            event: "code.direct.health-reached",
            attachmentId,
            diagnosticTraceId,
            tunnelId,
            sessionId,
            connectionId: healthConnectionIds[0],
          }),
        }),
        expect.objectContaining({
          context: expect.objectContaining({
            event: "code.direct.http-upstream-responded",
            attachmentId,
            diagnosticTraceId,
            tunnelId,
            sessionId,
            connectionId: proxyConnectionIds[0],
            requestId: expect.any(String),
            statusCode: 200,
          }),
        }),
      ]),
    );
    const events = records.map(
      (record) => (record.context as { event?: unknown } | undefined)?.event,
    );
    expect(
      events.filter((event) => event === "direct.connection.accepted"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event === "code.direct.prepared"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event === "code.direct.health-reached"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event === "code.direct.http-upstream-responded"),
    ).toHaveLength(1);
    expect(events).not.toEqual(
      expect.arrayContaining([
        "direct.frame.routed",
        "direct.frame.returned",
        "tunnel.protected-target.opening",
        "tunnel.protected-record.opened",
        "tunnel.protected-target.routed",
        "code.direct.http-upstream-opening",
      ]),
    );
    const captured = JSON.stringify(records);
    const protectedFragment = protectedContent.envelope.ciphertext.slice(0, 12);
    expect(captured).not.toContain(capabilityId);
    expect(captured).not.toContain(secret);
    expect(captured).not.toContain(dataProtection.key);
    expect(captured).not.toContain(connectionToken);
    expect(captured).not.toContain(workspaceUri);
    expect(captured).not.toContain("/worker/private/project.code-workspace");
    expect(captured).not.toContain(protectedFragment);
  });
});
