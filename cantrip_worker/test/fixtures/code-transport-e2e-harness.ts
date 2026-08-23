import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  type DirectCapabilityBinding,
  type EncryptionKeyGrant,
  type EncryptionPrincipal,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import {
  tunnelContentRecordSchema,
  type TunnelDataProtectionConfiguration,
} from "@cantrip/protocol/tunnel-content";
import WebSocket, { WebSocketServer } from "ws";

import { DesktopTunnelEndpoint } from "../../../cantrip_server/src/tunnels/desktop-endpoint.js";
import {
  TunnelStreamBroker,
  type TunnelDataPlaneEndpoint,
  type TunnelEndpointFrameListener,
} from "../../../cantrip_server/src/tunnels/broker.js";
import { CodeDirectEndpointManager } from "../../src/code/direct-endpoint.js";
import type { CodeSupervisor } from "../../src/code/supervisor.js";
import { DirectBroker } from "../../src/direct-broker.js";
import { protectWorkerEndpointContent } from "../../src/endpoint-content-encryption.js";
import { subscribeWorkerLogs } from "../../src/logger.js";
import type { ProjectShareManager } from "../../src/project-share-manager.js";
import { TunnelDestinationRouter } from "../../src/tunnel-destination-router.js";
import { TunnelTcpDestinationAdapter } from "../../src/tunnel-tcp-adapter.js";
import { WorkerEncryptionService } from "../../src/worker-encryption.js";

interface HarnessStart {
  attachmentId: string;
  badCapabilityId: string;
  badDiagnosticTraceId: string;
  badSecret: string;
  clientId: string;
  dataProtection: TunnelDataProtectionConfiguration;
  expiresAt: string;
  goodCapabilityId: string;
  goodDiagnosticTraceId: string;
  goodSecret: string;
  leaseExpiresAt: string;
  ownerId: string;
  relaySecret: string;
  serverId: string;
  sessionId: string;
  tunnelId: string;
  workerId: string;
}

const serverUrl = "https://cantrip-native-e2e.test";

interface HarnessCommand {
  type: "snapshot" | "shutdown";
}

class HarnessSupervisor {
  readonly activeStreams = new Set<string>();

  constructor(
    private readonly editorOrigin: string,
    private readonly connectionToken: string,
    private readonly workspaceUri: string,
  ) {}

  beginTunnelStream(_sessionId: string, streamId: string): void {
    this.activeStreams.add(streamId);
  }

  endTunnelStream(_sessionId: string, streamId: string): void {
    this.activeStreams.delete(streamId);
  }

  proxyTarget() {
    return {
      codeTabId: "code-e2e",
      connectionToken: this.connectionToken,
      editorOrigin: this.editorOrigin,
      processInstanceId: "process-e2e",
      workspaceUri: this.workspaceUri,
    };
  }
}

class RouterEndpoint implements TunnelDataPlaneEndpoint {
  readonly endpointId: string;
  readonly placement: { kind: "worker"; workerId: string };
  readonly #listeners = new Set<TunnelEndpointFrameListener>();
  readonly #disconnectListeners = new Set<() => void>();
  #closed = false;

  constructor(
    workerId: string,
    private readonly sendToWorker: (
      header: TunnelDataPlaneFrameHeader,
      payload: Uint8Array,
    ) => void,
  ) {
    this.endpointId = `worker:${workerId}`;
    this.placement = { kind: "worker", workerId };
  }

  send(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean {
    if (this.#closed) return false;
    queueMicrotask(() => this.sendToWorker(header, payload));
    return true;
  }

  subscribe(listener: TunnelEndpointFrameListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  emit(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean {
    if (this.#closed) return false;
    for (const listener of this.#listeners) listener(header, payload);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#disconnectListeners) listener();
    this.#disconnectListeners.clear();
    this.#listeners.clear();
  }
}

function output(prefix: string, value: unknown): void {
  process.stdout.write(`${prefix}${JSON.stringify(value)}\n`);
}

function mutateCiphertext<T>(record: T): T {
  const mutated = structuredClone(record) as T & {
    protectedContent: { envelope: { ciphertext: string } };
  };
  const ciphertext = mutated.protectedContent.envelope.ciphertext;
  mutated.protectedContent.envelope.ciphertext = `${
    ciphertext.startsWith("A") ? "B" : "A"
  }${ciphertext.slice(1)}`;
  return mutated;
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function openEncryption(start: HarnessStart, dataDirectory: string) {
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl,
    workerId: start.workerId,
  });
  const registration = service.registration();
  const now = "2026-08-23T12:00:00.000Z";
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId: start.ownerId,
    kind: "worker",
    workerId: start.workerId,
    label: "Code transport E2E worker",
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
    ownerId: start.ownerId,
    component: "tunnel-content",
    keyRevision: 1,
  });
  const grant: EncryptionKeyGrant = {
    id: randomUUID(),
    ownerId: start.ownerId,
    principalId: principal.id,
    component: "tunnel-content",
    keyRevision: 1,
    wrappedKey: await wrapComponentKeyForWorker({
      ownerId: start.ownerId,
      workerId: start.workerId,
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
  await service.acceptBootstrap({
    serverId: start.serverId,
    ownerId: start.ownerId,
    principal,
    grants: [grant],
  });
  return service;
}

async function main(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) throw new Error("Harness start configuration was omitted.");
  const start = JSON.parse(first.value) as HarnessStart;
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-code-native-e2e-"),
  );
  const observedRequests: Array<{
    authenticated: boolean;
    forwardedPrefix: string | null;
    url: string;
  }> = [];
  let hangingRequestReached = false;
  let hangingRequestClosed = false;
  const connectionToken = "openvscode-e2e-token-must-stay-private";
  const workspaceUri = "file:///worker/private/project.code-workspace";
  const upstream = createServer((request, response) => {
    observedRequests.push({
      authenticated:
        request.headers.cookie ===
        `vscode-tkn=${encodeURIComponent(connectionToken)}`,
      forwardedPrefix:
        typeof request.headers["x-forwarded-prefix"] === "string"
          ? request.headers["x-forwarded-prefix"]
          : null,
      url: request.url ?? "",
    });
    if (request.url?.startsWith("/hang")) {
      hangingRequestReached = true;
      request.once("close", () => {
        hangingRequestClosed = true;
      });
      return;
    }
    response.writeHead(200, {
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "x-openvscode-workbench": "compatible",
    });
    response.end("<main>openvscode-compatible-workbench</main>");
  });
  const upstreamPort = await listen(upstream);
  const supervisor = new HarnessSupervisor(
    `http://127.0.0.1:${upstreamPort}`,
    connectionToken,
    workspaceUri,
  );
  const codeEndpoints = new CodeDirectEndpointManager(
    supervisor as unknown as CodeSupervisor,
  );
  const tcp = new TunnelTcpDestinationAdapter();
  const encryption = await openEncryption(start, dataDirectory);
  const router = new TunnelDestinationRouter(
    tcp,
    {
      open: () => Promise.reject(new Error("Project shares are out of scope")),
    } as unknown as ProjectShareManager,
    codeEndpoints,
    encryption,
    start.workerId,
  );
  const directBroker = new DirectBroker();
  directBroker.setTunnelFrameHandler((header, payload, diagnostics) =>
    router.handleFrame(header, payload, diagnostics),
  );
  const advertisement = await directBroker.start();
  if (!advertisement.available) throw new Error("Direct broker unavailable.");

  const operationId = randomUUID();
  const content = tunnelContentRecordSchema.parse({
    name: "Native Code acceptance",
    description: null,
    source: { kind: "desktop-loopback" },
    destination: {
      kind: "worker-code",
      workerId: start.workerId,
      resourceId: start.tunnelId,
      sessionId: start.sessionId,
    },
    dataProtection: start.dataProtection,
  });
  const protectedContent = await protectWorkerEndpointContent({
    context: {
      domain: "tunnel-content",
      serverId: start.serverId,
      workerId: start.workerId,
      scopeId: JSON.stringify(["tunnel", start.tunnelId]),
      operationId,
      operation: "tunnel.record",
      direction: "stored",
      sequence: 1,
    },
    content,
    schema: tunnelContentRecordSchema,
    service: encryption,
  });
  const protectedRecord = { operationId, revision: 1, protectedContent };
  const sourceEndpointId = `desktop:${start.clientId}:${start.attachmentId}`;
  const destinationEndpointId = `worker:${start.workerId}`;
  const route = {
    tunnelId: start.tunnelId,
    attachmentId: start.attachmentId,
    sourceEndpointId,
    destinationEndpointId,
    target: {
      kind: "protected-tunnel" as const,
      targetKind: "code" as const,
      recordId: start.tunnelId,
      protectedRecord,
    },
  };
  const binding = (capabilityId: string): DirectCapabilityBinding => ({
    capabilityId,
    ownerId: start.ownerId,
    authSessionId: "auth-session-e2e",
    workerId: start.workerId,
    resourceKind: "tunnel",
    resourceId: start.tunnelId,
    attachmentId: start.attachmentId,
    channels: ["tunnel-data"],
    expiresAt: start.expiresAt,
    leaseExpiresAt: start.leaseExpiresAt,
  });
  await directBroker.prepare({
    type: "direct.capability.prepare",
    binding: binding(start.goodCapabilityId),
    diagnosticTraceId: start.goodDiagnosticTraceId,
    secret: start.goodSecret,
    tunnelRoute: route,
  });
  await directBroker.prepare({
    type: "direct.capability.prepare",
    binding: binding(start.badCapabilityId),
    diagnosticTraceId: start.badDiagnosticTraceId,
    secret: start.badSecret,
    tunnelRoute: {
      ...route,
      target: {
        ...route.target,
        protectedRecord: mutateCiphertext(protectedRecord),
      },
    },
  });

  let routerEndpoint!: RouterEndpoint;
  routerEndpoint = new RouterEndpoint(start.workerId, (header, payload) =>
    router.handleFrame(header, payload),
  );
  router.setFrameEmitter(
    (header, payload) =>
      directBroker.routeTunnelFrame(header, payload) ??
      routerEndpoint.emit(header, payload),
    async () => true,
  );
  const relayBroker = new TunnelStreamBroker();
  const relayHttp = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const relaySockets = new Set<WebSocket>();
  const relayWebSockets = new WebSocketServer({ noServer: true });
  const relayPath = `/api/tunnel-attachments/${start.attachmentId}/connect`;
  relayHttp.on("upgrade", (request, socket, head) => {
    if (
      request.url !== relayPath ||
      request.headers.authorization !== `Bearer ${start.relaySecret}`
    ) {
      socket.destroy();
      return;
    }
    relayWebSockets.handleUpgrade(request, socket, head, (client) => {
      relayWebSockets.emit("connection", client, request);
    });
  });
  relayWebSockets.on("connection", (socket) => {
    relaySockets.add(socket);
    socket.once("close", () => relaySockets.delete(socket));
    socket.once("message", (message, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Tunnel initialization must be JSON");
        return;
      }
      let clientId: string;
      let diagnosticTraceId: string;
      try {
        const initialize = JSON.parse(String(message)) as {
          clientId?: unknown;
          diagnosticTraceId?: unknown;
          type?: unknown;
        };
        if (
          initialize.type !== "initialize" ||
          initialize.clientId !== start.clientId ||
          initialize.diagnosticTraceId !== start.badDiagnosticTraceId
        ) {
          throw new Error("identity mismatch");
        }
        clientId = initialize.clientId;
        diagnosticTraceId = initialize.diagnosticTraceId;
      } catch {
        socket.close(1008, "Tunnel initialization is invalid");
        return;
      }
      const source = new DesktopTunnelEndpoint(
        socket,
        clientId,
        start.attachmentId,
      );
      const routeHandle = relayBroker.registerRoute({
        attachmentId: start.attachmentId,
        diagnosticTraceId,
        destination: routerEndpoint,
        destinationTarget: route.target,
        source,
        tunnelId: start.tunnelId,
        ownerId: start.ownerId,
        workerId: start.workerId,
      });
      socket.once("close", () => routeHandle.close());
      socket.send(
        JSON.stringify({
          type: "ready",
          attachmentId: start.attachmentId,
          tunnelId: start.tunnelId,
          sourceEndpointId,
          destinationEndpointId,
          expiresAt: start.expiresAt,
        }),
      );
    });
  });
  const relayPort = await listen(relayHttp);
  const workerRecords: Array<{ context?: unknown }> = [];
  const unsubscribeLogs = subscribeWorkerLogs((record) =>
    workerRecords.push(record),
  );

  output("CANTRIP_CODE_E2E_READY ", {
    broker: advertisement,
    relayPath,
    relayPort,
  });

  const snapshot = async () => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const relayStats = relayBroker.stats();
      const hangingRequestSettled =
        !hangingRequestReached || hangingRequestClosed;
      const relaySettled =
        relayStats.activeConnections === 0 &&
        relayStats.closedConnections === relayStats.openedConnections;
      if (hangingRequestSettled && relaySettled) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return {
      activeStreams: supervisor.activeStreams.size,
      hangingRequestClosed,
      hangingRequestReached,
      observedRequests,
      relayStats: relayBroker.stats(),
      workerContexts: workerRecords
        .map((record) => record.context)
        .filter((context): context is Record<string, unknown> =>
          Boolean(context && typeof context === "object"),
        ),
    };
  };
  for (;;) {
    const next = await lines.next();
    if (next.done) break;
    const command = JSON.parse(next.value) as HarnessCommand;
    if (command.type === "snapshot") {
      output("CANTRIP_CODE_E2E_SNAPSHOT ", await snapshot());
      continue;
    }
    if (command.type === "shutdown") break;
  }
  input.close();

  const finalSnapshot = await snapshot();
  for (const socket of relaySockets) socket.terminate();
  await new Promise<void>((resolve) => relayWebSockets.close(() => resolve()));
  relayBroker.close();
  routerEndpoint.close();
  await directBroker.close();
  router.close();
  tcp.close();
  codeEndpoints.close();
  await closeServer(relayHttp);
  await closeServer(upstream);
  unsubscribeLogs();
  await rm(dataDirectory, { recursive: true });
  output("CANTRIP_CODE_E2E_DONE ", finalSnapshot);
}

void main().catch((error: unknown) => {
  output("CANTRIP_CODE_E2E_FATAL ", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
