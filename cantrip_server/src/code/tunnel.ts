import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES,
  type CodeAttachment,
  type CodeRuntimeStatus,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer } from "ws";

import type { ServerRepository } from "../db/repository.js";
import {
  TunnelStreamBroker,
  type TunnelRouteHandle,
} from "../tunnels/broker.js";
import { ManagedServerRelayTelemetry } from "../tunnels/managed-relay-telemetry.js";
import { WorkerTunnelEndpoint } from "../tunnels/worker-endpoint.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import {
  type ProjectShareTunnelBroker,
  projectShareTokenFromRequest,
} from "../project-shares/tunnel.js";
import { CodeHttpEndpoint } from "./http-endpoint.js";

export interface CodeAttachmentBinding {
  attachmentId: string;
  authSessionId: string | null;
  codeTabId: string;
  createdAt: number;
  endpoint: CodeHttpEndpoint;
  expiresAt: number;
  lastSeenAt: number;
  ownerId: string;
  projectId: string;
  route: TunnelRouteHandle;
  sessionId: string;
  token: string;
  telemetry: ManagedServerRelayTelemetry | null;
  tunnelId: string;
  workerId: string;
}

export interface CreateCodeAttachmentInput {
  authSessionId?: string | null;
  codeTabId: string;
  ownerId: string;
  projectId: string;
  runtime: CodeRuntimeStatus;
  sessionId: string;
  workerId: string;
}

export interface CodeTunnelBrokerOptions {
  allowedFrameAncestors: string[];
  consumeRelayBytes?(ownerId: string, workerId: string, bytes: number): boolean;
  idleTtlMs?: number;
  maxAttachments?: number;
  maxLifetimeMs?: number;
  surfaceOrigin: string;
}

type CodeTunnelChange = (input: {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}) => void;

const surfaceWebSockets = new WeakMap<Server, WebSocketServer>();

export class CodeTunnelBroker {
  readonly #allowedFrameAncestors: string;
  readonly #attachments = new Map<string, CodeAttachmentBinding>();
  readonly #idleTtlMs: number;
  readonly #maxAttachments: number;
  readonly #maxLifetimeMs: number;
  readonly #surfaceOrigin: URL;
  readonly #sweepTimer: ReturnType<typeof setInterval>;
  readonly #workerDisconnectSubscriptions = new Map<string, () => void>();
  #changed: CodeTunnelChange | null = null;
  #ownsStreamBroker = true;
  #repository: ServerRepository | null = null;
  #streamBroker: TunnelStreamBroker;

  constructor(
    private readonly bridge: WorkerCommandBus,
    options: CodeTunnelBrokerOptions,
  ) {
    this.#streamBroker = new TunnelStreamBroker({
      consumeRelayBytes: options.consumeRelayBytes,
    });
    this.#surfaceOrigin = new URL(options.surfaceOrigin);
    this.#allowedFrameAncestors = [
      "'self'",
      ...options.allowedFrameAncestors,
    ].join(" ");
    this.#idleTtlMs = options.idleTtlMs ?? 15 * 60_000;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? 12 * 60 * 60_000;
    this.#maxAttachments = options.maxAttachments ?? 128;
    this.#sweepTimer = setInterval(
      () => this.#prune(),
      Math.max(1_000, Math.min(60_000, this.#idleTtlMs)),
    );
    this.#sweepTimer.unref();
  }

  configureControlPlane(
    repository: ServerRepository,
    streamBroker: TunnelStreamBroker,
    changed: CodeTunnelChange,
  ): void {
    if (this.#attachments.size > 0) {
      throw new Error("Code control plane must be configured before use.");
    }
    if (this.#ownsStreamBroker) this.#streamBroker.close();
    this.#repository = repository;
    this.#streamBroker = streamBroker;
    this.#ownsStreamBroker = false;
    this.#changed = changed;
  }

  async createAttachment(
    input: CreateCodeAttachmentInput,
  ): Promise<CodeAttachment> {
    this.#prune();
    let workspacePath: string | null = null;
    if (input.runtime.workspaceUri) {
      const workspace = new URL(input.runtime.workspaceUri);
      if (
        workspace.protocol !== "file:" ||
        workspace.host !== "" ||
        workspace.search !== "" ||
        workspace.hash !== ""
      ) {
        throw new Error("Cantrip Code supplied an invalid workspace URI.");
      }
      workspacePath = decodeURIComponent(workspace.pathname);
    }
    if (this.#attachments.size >= this.#maxAttachments) {
      throw new Error(
        "This server has reached its Cantrip Code attachment limit.",
      );
    }
    if (!this.bridge.isConnected(input.workerId)) {
      throw new Error("Cantrip Code worker is offline.");
    }
    const now = Date.now();
    const token = randomBytes(32).toString("base64url");
    const attachmentId = randomUUID();
    const expiresAt = now + this.#idleTtlMs;
    let tunnelId = `code:${input.codeTabId}`;
    let registeredRelay = false;
    if (this.#repository) {
      const tunnel = await this.#repository.registerManagedTunnel(
        input.ownerId,
        {
          name: "Cantrip Code",
          description: "Isolated editor access for the owning Code tab.",
          projectId: input.projectId,
          origin: "code",
          management: "managed-ephemeral",
          protocolHint: "http-websocket",
          source: { kind: "server-http", adapter: "code" },
          destination: {
            kind: "worker-adapter",
            workerId: input.workerId,
            adapter: "code",
            resourceId: input.codeTabId,
          },
          managedBy: { kind: "code", id: input.codeTabId },
          desiredState: "started",
          status: "starting",
        },
      );
      if (!tunnel) throw new Error("Could not register the Code tunnel.");
      tunnelId = tunnel.id;
      if (
        !(await this.#repository.createManagedServerRelayAttachment(
          input.ownerId,
          tunnel.id,
          attachmentId,
          new Date(expiresAt),
        ))
      ) {
        throw new Error("Could not activate the Code tunnel.");
      }
      registeredRelay = true;
    }
    let binding!: CodeAttachmentBinding;
    try {
      const destination = new WorkerTunnelEndpoint(
        this.bridge,
        input.workerId,
        `worker:code:${attachmentId}`,
      );
      const endpoint = new CodeHttpEndpoint(
        tunnelId,
        attachmentId,
        destination.endpointId,
        input.sessionId,
        this.basePath(token),
        this.#surfaceOrigin,
        this.#allowedFrameAncestors,
        (metrics) => this.#recordMetrics(binding, metrics),
      );
      const route = this.#streamBroker.registerRoute({
        attachmentId,
        destination,
        destinationTarget: {
          kind: "adapter",
          adapter: "code",
          resourceId: input.codeTabId,
        },
        source: endpoint,
        tunnelId,
        ownerId: input.ownerId,
        workerId: input.workerId,
      });
      binding = {
        attachmentId,
        authSessionId: input.authSessionId ?? null,
        codeTabId: input.codeTabId,
        createdAt: now,
        endpoint,
        expiresAt,
        lastSeenAt: now,
        ownerId: input.ownerId,
        projectId: input.projectId,
        route,
        sessionId: input.sessionId,
        token,
        telemetry: this.#repository
          ? new ManagedServerRelayTelemetry(
              this.#repository,
              {
                attachmentId,
                ownerId: input.ownerId,
                projectId: input.projectId,
                tunnelId,
              },
              this.#changed,
            )
          : null,
        tunnelId,
        workerId: input.workerId,
      };
    } catch (error) {
      if (registeredRelay && this.#repository) {
        await this.#repository
          .removeManagedServerRelayAttachment(input.ownerId, attachmentId)
          .catch(() => null);
      }
      throw error;
    }
    this.#attachments.set(token, binding);
    this.#trackWorkerDisconnect(input.workerId);
    this.#changed?.({
      attachmentId,
      ownerId: input.ownerId,
      projectId: input.projectId,
      tunnelId,
    });
    const attachmentUrl = new URL(
      `${this.basePath(token)}/`,
      this.#surfaceOrigin,
    );
    if (workspacePath)
      attachmentUrl.searchParams.set("workspace", workspacePath);
    return {
      attachmentId,
      sessionId: input.sessionId,
      url: attachmentUrl.toString(),
      expiresAt: new Date(expiresAt).toISOString(),
      runtime: input.runtime,
    };
  }

  basePath(token: string): string {
    return `/code/${token}`;
  }

  hasAttachment(token: string): boolean {
    return this.#resolve(token) !== null;
  }

  async revokeAttachment(
    attachmentId: string,
    ownerId: string,
  ): Promise<boolean> {
    for (const [token, binding] of this.#attachments) {
      if (
        binding.attachmentId === attachmentId &&
        binding.ownerId === ownerId
      ) {
        await this.#removeAttachment(token, binding);
        return true;
      }
    }
    return false;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.#revokeWhere((binding) => binding.sessionId === sessionId);
  }

  async revokeAuthSession(authSessionId: string): Promise<void> {
    await this.#revokeWhere(
      (binding) => binding.authSessionId === authSessionId,
    );
  }

  async revokeOwner(ownerId: string): Promise<void> {
    await this.#revokeWhere((binding) => binding.ownerId === ownerId);
  }

  async close(): Promise<void> {
    clearInterval(this.#sweepTimer);
    await this.#revokeWhere(() => true);
    for (const unsubscribe of this.#workerDisconnectSubscriptions.values()) {
      unsubscribe();
    }
    this.#workerDisconnectSubscriptions.clear();
    if (this.#ownsStreamBroker) this.#streamBroker.close();
  }

  proxyHttp(
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const binding = this.#resolve(token);
    if (!binding) {
      this.#writeUnavailable(response);
      return;
    }
    if (!this.bridge.isConnected(binding.workerId)) {
      response
        .writeHead(503, { "cache-control": "no-store" })
        .end("Worker offline");
      return;
    }
    binding.endpoint.proxyHttp(request, response);
  }

  proxyWebSocket(
    token: string,
    socket: WebSocket,
    request: IncomingMessage,
  ): void {
    const binding = this.#resolve(token);
    if (!binding || !this.bridge.isConnected(binding.workerId)) {
      socket.close(1013, "Cantrip Code worker is unavailable");
      return;
    }
    binding.endpoint.proxyWebSocket(socket, request);
  }

  #resolve(token: string): CodeAttachmentBinding | null {
    const binding = this.#attachments.get(token);
    if (!binding) return null;
    const now = Date.now();
    if (
      binding.expiresAt <= now ||
      binding.createdAt + this.#maxLifetimeMs <= now
    ) {
      void this.#removeAttachment(token, binding);
      return null;
    }
    this.#touch(binding, now);
    return binding;
  }

  #prune(): void {
    const now = Date.now();
    for (const [token, binding] of this.#attachments) {
      if (
        binding.expiresAt <= now ||
        binding.createdAt + this.#maxLifetimeMs <= now
      ) {
        void this.#removeAttachment(token, binding);
      }
    }
  }

  #touch(binding: CodeAttachmentBinding, now = Date.now()): void {
    binding.lastSeenAt = now;
    binding.expiresAt = Math.min(
      binding.createdAt + this.#maxLifetimeMs,
      now + this.#idleTtlMs,
    );
    binding.telemetry?.renew(new Date(binding.expiresAt));
  }

  async #removeAttachment(
    token: string,
    binding: CodeAttachmentBinding,
  ): Promise<void> {
    if (this.#attachments.get(token) !== binding) return;
    this.#attachments.delete(token);
    binding.endpoint.close();
    binding.route.close();
    await binding.telemetry?.close(new Date(binding.expiresAt));
    if (this.#repository) {
      const removed = await this.#repository
        .removeManagedServerRelayAttachment(
          binding.ownerId,
          binding.attachmentId,
        )
        .catch(() => null);
      this.#changed?.({
        attachmentId: binding.attachmentId,
        ownerId: binding.ownerId,
        projectId: binding.projectId,
        tunnelId: removed?.tunnelId ?? binding.tunnelId,
      });
    }
    this.#stopTrackingWorkerIfUnused(binding.workerId);
  }

  async #revokeWhere(
    predicate: (binding: CodeAttachmentBinding) => boolean,
  ): Promise<void> {
    await Promise.all(
      [...this.#attachments.entries()]
        .filter(([, binding]) => predicate(binding))
        .map(([token, binding]) => this.#removeAttachment(token, binding)),
    );
  }

  #recordMetrics(
    binding: CodeAttachmentBinding,
    input: {
      bytesFromSource: number;
      bytesToSource: number;
      connectionDelta: number;
    },
  ): void {
    if (!binding) return;
    const now = Date.now();
    binding.lastSeenAt = now;
    binding.expiresAt = Math.min(
      binding.createdAt + this.#maxLifetimeMs,
      now + this.#idleTtlMs,
    );
    binding.telemetry?.record(input, new Date(binding.expiresAt));
  }

  #trackWorkerDisconnect(workerId: string): void {
    if (this.#workerDisconnectSubscriptions.has(workerId)) return;
    const unsubscribe = this.bridge.subscribeWorkerDisconnect(workerId, () => {
      for (const [token, binding] of [...this.#attachments]) {
        if (binding.workerId !== workerId) continue;
        void this.#removeAttachment(token, binding);
      }
      this.#stopTrackingWorkerIfUnused(workerId);
    });
    this.#workerDisconnectSubscriptions.set(workerId, unsubscribe);
  }

  #stopTrackingWorkerIfUnused(workerId: string): void {
    if (
      [...this.#attachments.values()].some(
        (binding) => binding.workerId === workerId,
      )
    )
      return;
    this.#workerDisconnectSubscriptions.get(workerId)?.();
    this.#workerDisconnectSubscriptions.delete(workerId);
  }

  #writeUnavailable(response: ServerResponse): void {
    const message = JSON.stringify({
      type: "cantrip-code-attachment-unavailable-v1",
    });
    response.writeHead(404, {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors ${this.#allowedFrameAncestors}`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(`<!doctype html>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:Canvas;color:GrayText;font:14px system-ui,sans-serif}</style>
<p>Reconnecting to Cantrip Code…</p>
<script>window.parent.postMessage(${message}, "*");</script>`);
  }
}

function tokenFromRequest(request: IncomingMessage): string | null {
  const url = new URL(request.url ?? "/", "http://cantrip-surface.invalid");
  return (
    /^\/code\/([A-Za-z0-9_-]{43})(?:\/|$)/u.exec(url.pathname)?.[1] ?? null
  );
}

export function createCodeSurfaceServer(
  broker: CodeTunnelBroker,
  surfaceOrigin: string,
  projectShares?: ProjectShareTunnelBroker,
): Server {
  const expectedOrigin = new URL(surfaceOrigin).origin;
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: CODE_ADAPTER_MAX_WEBSOCKET_MESSAGE_BYTES,
  });
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end('{"status":"ok"}');
      return;
    }
    const projectShareToken = projectShareTokenFromRequest(request);
    if (projectShareToken && projectShares) {
      projectShares.proxyHttp(projectShareToken, request, response);
      return;
    }
    const token = tokenFromRequest(request);
    if (!token) {
      response.writeHead(404, { "cache-control": "no-store" }).end("Not found");
      return;
    }
    broker.proxyHttp(token, request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    const token = tokenFromRequest(request);
    const origin = request.headers.origin;
    if (
      !token ||
      !broker.hasAttachment(token) ||
      (origin && origin !== expectedOrigin)
    ) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      broker.proxyWebSocket(token, webSocket, request);
    });
  });
  surfaceWebSockets.set(server, webSockets);
  return server;
}

export async function closeCodeSurfaceServer(server: Server): Promise<void> {
  const webSockets = surfaceWebSockets.get(server);
  for (const client of webSockets?.clients ?? []) client.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  await new Promise<void>(
    (resolve) => webSockets?.close(() => resolve()) ?? resolve(),
  );
  surfaceWebSockets.delete(server);
}
