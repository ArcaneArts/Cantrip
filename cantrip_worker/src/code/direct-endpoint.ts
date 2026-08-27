import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

import {
  CODE_MAX_WEBSOCKET_MESSAGE_BYTES,
  codeOpenExtensionsRequestSchema,
  codeOpenExtensionsResultSchema,
  codeOpenFileRequestSchema,
  codeOpenFileResultSchema,
  codeOpenSettingsRequestSchema,
  codeOpenSettingsResultSchema,
  codePresentationUpdateSchema,
  parseCodeSessionRoutePath,
  codeSessionRouteBasePath,
  codeThemeUpdateSchema,
  isForwardableCodeWebSocketCloseCode,
  type CodeTransportRouteAuthorizeCommand,
  type CodeTransportRouteAuthorizeResult,
  type CodeTransportRouteRevokeCommand,
  type CodeTransportRouteRevokeResult,
  type CodeTransportRevokeCommand,
  type CodeTransportRevokeResult,
} from "@cantrip/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import {
  workerLogError,
  workerLogErrorIdentity,
  workerLogger,
} from "../logger.js";
import type { CodeSupervisor } from "./supervisor.js";
import {
  codeEditorRequestHeaders,
  codeEditorResponseHeaders,
  codeEditorTargetUrl,
  editorAuthenticatedPayload,
  rawCodeWebSocketBytes,
} from "./proxy-utils.js";

interface SharedSessionRoute {
  readonly attachmentId: string;
  expiresAtMs: number;
  expiryGeneration: symbol;
  expiryTimer: NodeJS.Timeout | null;
  readonly basePath: string;
  readonly routeGrant: string;
  readonly sessionId: string;
  readonly sessionIncarnationId: string;
  readonly sockets: Set<WebSocket>;
  readonly activeRequests: Set<() => void>;
  bufferedWebSocketBytes: number;
  readonly webSocketTeardowns: Set<() => void>;
}

interface SharedTransportIdentity {
  readonly authSessionId: string;
  readonly ownerId: string;
  readonly protectedKeyRevision: number;
  readonly serverControlPlaneGeneration: string;
  readonly serverId: string;
  readonly workerProcessGeneration: string;
}

export interface ActiveCodeTransportSecurityIdentity {
  readonly ownerId: string;
  readonly protectedKeyRevision: number;
  readonly serverId: string;
}

interface Endpoint {
  address: { kind: "tcp"; host: "127.0.0.1"; port: number };
  connectionContexts: Map<number, CodeEndpointPreparationContext>;
  diagnosticOutcomes: Map<
    string,
    Set<"health" | "http-success" | "websocket-success">
  >;
  fallbackConnection: CodeEndpointPreparationContext;
  kind: "legacy" | "shared";
  routesByAttachmentId: Map<string, SharedSessionRoute>;
  routesByGrant: Map<string, SharedSessionRoute>;
  server: HttpServer;
  sessionId: string | null;
  sharedIdentity: SharedTransportIdentity | null;
  sharedBufferedWebSocketBytes: number;
  sockets: Set<WebSocket>;
  tcpSockets: Set<Socket>;
  tunnelId: string;
}

interface EndpointPreparation {
  promise: Promise<{ kind: "tcp"; host: "127.0.0.1"; port: number }>;
  kind: "legacy" | "shared";
  sessionId: string | null;
  tunnelId: string;
}

interface CodeEndpointPreparationContext {
  attachmentId?: string;
  connectionId?: string;
  diagnosticTraceId?: string;
}

interface CodeEndpointContext extends CodeEndpointPreparationContext {
  attachmentId?: string;
  basePath: string;
  route?: SharedSessionRoute;
  sessionId: string;
  sessionIncarnationId?: string;
  tunnelId: string;
}

interface EndpointCreationContext {
  kind: "legacy" | "shared";
  sessionId: string | null;
  tunnelId: string;
}

export interface CodeDirectEndpointManagerOptions {
  readonly now?: () => number;
  readonly serverControlPlaneGeneration?: string;
  readonly workerProcessGeneration?: string;
}

const BASE_PATH = "/code";
const MAX_CONTROL_REQUEST_BYTES = 16 * 1_024;
const MAX_BUFFERED_BYTES = 8 * 1_024 * 1_024;
const MAX_ENDPOINT_DIAGNOSTIC_TRACES = 128;
const MAX_SHARED_TRANSPORTS = 128;
const MAX_SHARED_ROUTES_PER_TRANSPORT = 128;
const MAX_SHARED_CONNECTIONS_PER_ROUTE = 64;
const MAX_SHARED_CONNECTIONS_PER_TRANSPORT = 256;
const MAX_SHARED_RAW_CONNECTIONS_PER_TRANSPORT = 192;
const MAX_SHARED_ROUTE_BUFFERED_BYTES = 16 * 1_024 * 1_024;
const MAX_SHARED_TRANSPORT_BUFFERED_BYTES = 64 * 1_024 * 1_024;
const MAX_SHARED_TOMBSTONES = 8_192;
const MAX_SHARED_ROUTE_LEASE_MS = 13 * 60 * 60_000;
const MAX_SHARED_TOMBSTONE_MS = MAX_SHARED_ROUTE_LEASE_MS;
const FRAME_ANCESTORS =
  "frame-ancestors 'self' http://127.0.0.1:1420 http://tauri.localhost https://tauri.localhost tauri://localhost";
const ABNORMAL_CLOSE_CODE = 1011;
const ABNORMAL_CLOSE_REASON = "Cantrip Code peer disconnected abnormally";
const WEB_CODE_BASE_PATH =
  /^\/__cantrip_code\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/code$/iu;

function publicBasePath(request: IncomingMessage, fallback: string): string {
  const value = request.headers["x-cantrip-code-base-path"];
  return typeof value === "string" && WEB_CODE_BASE_PATH.test(value)
    ? value
    : fallback;
}

export function forwardableCodeWebSocketClose(
  code: number,
  reason: Buffer,
): { code: number; reason: Buffer | string } {
  return isForwardableCodeWebSocketCloseCode(code)
    ? { code, reason }
    : { code: ABNORMAL_CLOSE_CODE, reason: ABNORMAL_CLOSE_REASON };
}

function rawHeaders(request: IncomingMessage): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value !== undefined) result.push([name, value]);
  }
  return result;
}

function protocols(headers: IncomingHttpHeaders): string[] {
  const value = headers["sec-websocket-protocol"];
  return (Array.isArray(value) ? value.join(",") : (value ?? ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function writeResponseHeaders(
  response: ServerResponse,
  upstream: IncomingMessage,
): void {
  let contentSecurityPolicy = "";
  for (const [name, value] of codeEditorResponseHeaders(upstream)) {
    const lower = name.toLowerCase();
    if (lower === "x-frame-options") continue;
    if (lower === "content-security-policy") {
      contentSecurityPolicy = value;
      continue;
    }
    response.appendHeader(name, value);
  }
  const policy = contentSecurityPolicy
    .split(";")
    .map((directive) => directive.trim())
    .filter(
      (directive) =>
        directive && !directive.toLowerCase().startsWith("frame-ancestors"),
    );
  policy.push(FRAME_ANCESTORS);
  response.setHeader("Content-Security-Policy", policy.join("; "));
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.writeHead(upstream.statusCode ?? 502);
}

function writeControlResponse(
  response: ServerResponse,
  statusCode: number,
  body?: unknown,
): void {
  response.writeHead(statusCode, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readControlRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_CONTROL_REQUEST_BYTES) {
      throw new Error("Cantrip Code control request is too large.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class CodeDirectEndpointManager {
  readonly #endpoints = new Map<string, Endpoint>();
  readonly #controlTails = new Map<string, Promise<void>>();
  readonly #preparations = new Map<string, EndpointPreparation>();
  readonly #sessionGenerations = new Map<string, number>();
  readonly #transportTails = new Map<string, Promise<void>>();
  readonly #revokedSharedRoutes = new Map<string, number>();
  readonly #revokedSharedTransports = new Map<string, number>();

  readonly #now: () => number;
  readonly #workerProcessGeneration: string;
  #activeSecurityIdentity:
    ActiveCodeTransportSecurityIdentity | null | undefined;
  #acceptingAuthorizations = true;
  #activeControlPlaneGeneration: string | null = null;
  #lifecycleGeneration = 0;
  #stopped = false;
  #tombstoneCapacityExceeded = false;

  constructor(
    private readonly supervisor: CodeSupervisor,
    options: CodeDirectEndpointManagerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#activeControlPlaneGeneration =
      options.serverControlPlaneGeneration ?? null;
    this.#workerProcessGeneration =
      options.workerProcessGeneration ?? randomUUID();
  }

  authorizeSharedRoute(
    command: CodeTransportRouteAuthorizeCommand,
    activeIdentity: ActiveCodeTransportSecurityIdentity,
    expectedLifecycleGeneration = this.#lifecycleGeneration,
  ): Promise<CodeTransportRouteAuthorizeResult> {
    return this.#enqueueTransport(command.transportId, async () => {
      this.#assertAuthorizationLifecycle(expectedLifecycleGeneration);
      this.#assertCommandIdentity(command, activeIdentity);
      if (
        this.#isTombstoned(this.#revokedSharedTransports, command.transportId)
      ) {
        throw new Error("The shared Code transport has already been revoked.");
      }
      const routeKey = this.#sharedRouteKey(
        command.transportId,
        command.attachmentId,
      );
      if (this.#isTombstoned(this.#revokedSharedRoutes, routeKey)) {
        throw new Error("The shared Code route has already been revoked.");
      }
      const expiresAtMs = Date.parse(command.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.#now()) {
        throw new Error("The shared Code route authorization has expired.");
      }
      if (expiresAtMs - this.#now() > MAX_SHARED_ROUTE_LEASE_MS) {
        throw new Error(
          "The shared Code route authorization exceeds its maximum lease.",
        );
      }
      const runtime = this.supervisor.status(command.sessionId);
      if (
        runtime.status !== "running" ||
        runtime.sessionIncarnationId !== command.expectedSessionIncarnationId
      ) {
        throw new Error(
          "The shared Code route does not match the running session incarnation.",
        );
      }
      const endpoint = await this.#ensureSharedEndpoint(command.transportId);
      this.#assertAuthorizationLifecycle(expectedLifecycleGeneration);
      this.#assertCommandIdentity(command, activeIdentity);
      const currentRuntime = this.supervisor.status(command.sessionId);
      if (
        currentRuntime.status !== "running" ||
        currentRuntime.sessionIncarnationId !==
          command.expectedSessionIncarnationId
      ) {
        if (endpoint.routesByAttachmentId.size === 0) {
          this.revoke(
            this.#protectedEndpointId(command.transportId),
            "Shared Code authorization became stale",
          );
        }
        throw new Error(
          "The shared Code session changed while its route was authorizing.",
        );
      }
      const commandIdentity = this.#commandIdentity(command);
      if (
        endpoint.sharedIdentity &&
        !this.#sameTransportIdentity(endpoint.sharedIdentity, commandIdentity)
      ) {
        throw new Error(
          "The shared Code transport belongs to another security identity.",
        );
      }
      endpoint.sharedIdentity ??= commandIdentity;
      const existing = endpoint.routesByAttachmentId.get(command.attachmentId);
      if (existing) {
        if (
          existing.routeGrant !== command.routeGrant ||
          existing.sessionId !== command.sessionId ||
          existing.sessionIncarnationId !== command.expectedSessionIncarnationId
        ) {
          throw new Error(
            "The shared Code attachment is already bound to another route.",
          );
        }
        existing.expiresAtMs = expiresAtMs;
        this.#scheduleSharedRouteExpiry(endpoint, existing);
      } else {
        if (
          endpoint.routesByAttachmentId.size >= MAX_SHARED_ROUTES_PER_TRANSPORT
        ) {
          throw new Error("The shared Code transport route limit was reached.");
        }
        if (endpoint.routesByGrant.has(command.routeGrant)) {
          throw new Error(
            "The shared Code route grant is already bound to another attachment.",
          );
        }
        const route: SharedSessionRoute = {
          activeRequests: new Set(),
          attachmentId: command.attachmentId,
          basePath: codeSessionRouteBasePath(command.routeGrant),
          bufferedWebSocketBytes: 0,
          expiresAtMs,
          expiryGeneration: Symbol(command.attachmentId),
          expiryTimer: null,
          routeGrant: command.routeGrant,
          sessionId: command.sessionId,
          sessionIncarnationId: command.expectedSessionIncarnationId,
          sockets: new Set(),
          webSocketTeardowns: new Set(),
        };
        endpoint.routesByAttachmentId.set(route.attachmentId, route);
        endpoint.routesByGrant.set(route.routeGrant, route);
        this.#scheduleSharedRouteExpiry(endpoint, route);
      }
      workerLogger.event("info", "Shared Cantrip Code route authorized", {
        event: "code.transport.route.authorized",
        subsystem: "code",
        operation: "authorize-transport-route",
        status: "completed",
        transportId: command.transportId,
        attachmentId: command.attachmentId,
        sessionId: command.sessionId,
        sessionIncarnationId: command.expectedSessionIncarnationId,
      });
      return {
        ownerId: command.ownerId,
        authSessionId: command.authSessionId,
        serverId: command.serverId,
        serverControlPlaneGeneration: command.serverControlPlaneGeneration,
        protectedKeyRevision: command.protectedKeyRevision,
        workerProcessGeneration: command.workerProcessGeneration,
        transportId: command.transportId,
        attachmentId: command.attachmentId,
        sessionId: command.sessionId,
        sessionIncarnationId: command.expectedSessionIncarnationId,
        authorized: true,
        expiresAt: command.expiresAt,
      };
    });
  }

  revokeSharedRoute(
    command: CodeTransportRouteRevokeCommand,
    activeIdentity: ActiveCodeTransportSecurityIdentity,
    expectedLifecycleGeneration = this.#lifecycleGeneration,
  ): Promise<CodeTransportRouteRevokeResult> {
    return this.#enqueueTransport(command.transportId, async () => {
      this.#assertAuthorizationLifecycle(expectedLifecycleGeneration);
      this.#assertCommandIdentity(command, activeIdentity);
      const endpoint = this.#endpoints.get(
        this.#protectedEndpointId(command.transportId),
      );
      if (endpoint?.kind === "shared") {
        this.#assertSharedEndpointIdentity(endpoint, command);
      }
      this.#recordTombstone(
        this.#revokedSharedRoutes,
        this.#sharedRouteKey(command.transportId, command.attachmentId),
      );
      const route =
        endpoint?.kind === "shared"
          ? endpoint.routesByAttachmentId.get(command.attachmentId)
          : undefined;
      if (route && endpoint?.kind === "shared") {
        this.#removeSharedRoute(endpoint, route, "Code tab closed");
      }
      return {
        ownerId: command.ownerId,
        authSessionId: command.authSessionId,
        serverId: command.serverId,
        serverControlPlaneGeneration: command.serverControlPlaneGeneration,
        protectedKeyRevision: command.protectedKeyRevision,
        workerProcessGeneration: command.workerProcessGeneration,
        transportId: command.transportId,
        attachmentId: command.attachmentId,
        revoked: true,
      };
    });
  }

  revokeSharedTransport(
    command: CodeTransportRevokeCommand,
    activeIdentity: ActiveCodeTransportSecurityIdentity,
    expectedLifecycleGeneration = this.#lifecycleGeneration,
  ): Promise<CodeTransportRevokeResult> {
    return this.#enqueueTransport(command.transportId, async () => {
      this.#assertAuthorizationLifecycle(expectedLifecycleGeneration);
      this.#assertCommandIdentity(command, activeIdentity);
      const endpoint = this.#endpoints.get(
        this.#protectedEndpointId(command.transportId),
      );
      if (endpoint?.kind === "shared") {
        this.#assertSharedEndpointIdentity(endpoint, command);
      }
      this.#recordTombstone(this.#revokedSharedTransports, command.transportId);
      this.revoke(
        this.#protectedEndpointId(command.transportId),
        "Shared Code transport released",
      );
      return {
        ownerId: command.ownerId,
        authSessionId: command.authSessionId,
        serverId: command.serverId,
        serverControlPlaneGeneration: command.serverControlPlaneGeneration,
        protectedKeyRevision: command.protectedKeyRevision,
        workerProcessGeneration: command.workerProcessGeneration,
        transportId: command.transportId,
        revoked: true,
      };
    });
  }

  async prepareSharedProtected(
    transportId: string,
    activeIdentity: ActiveCodeTransportSecurityIdentity,
    connection: CodeEndpointPreparationContext = {},
  ): Promise<{ kind: "tcp"; host: "127.0.0.1"; port: number }> {
    const endpointId = this.#protectedEndpointId(transportId);
    const pending = this.#preparations.get(endpointId);
    if (pending?.kind === "shared") await pending.promise;
    const endpoint = this.#endpoints.get(endpointId);
    if (
      !endpoint ||
      endpoint.kind !== "shared" ||
      endpoint.routesByAttachmentId.size === 0 ||
      !endpoint.sharedIdentity ||
      endpoint.sharedIdentity.ownerId !== activeIdentity.ownerId ||
      endpoint.sharedIdentity.serverId !== activeIdentity.serverId ||
      endpoint.sharedIdentity.protectedKeyRevision !==
        activeIdentity.protectedKeyRevision ||
      endpoint.sharedIdentity.workerProcessGeneration !==
        this.#workerProcessGeneration
    ) {
      throw new Error(
        "The shared Code transport has no authorized session routes.",
      );
    }
    endpoint.fallbackConnection = connection;
    return endpoint.address;
  }

  workerProcessGeneration(): string {
    return this.#workerProcessGeneration;
  }

  lifecycleGeneration(): number {
    return this.#lifecycleGeneration;
  }

  serverControlPlaneGeneration(): string | null {
    return this.#activeControlPlaneGeneration;
  }

  reconnect(): void {
    if (this.#stopped) return;
    this.#acceptingAuthorizations = true;
  }

  synchronizeControlPlaneGeneration(generation: string): void {
    if (this.#activeControlPlaneGeneration === generation) return;
    const previouslyInitialized = this.#activeControlPlaneGeneration !== null;
    this.#activeControlPlaneGeneration = generation;
    if (!previouslyInitialized) return;
    this.#lifecycleGeneration += 1;
    this.#retireSharedTransports("Code control-plane generation changed");
  }

  invalidateControlPlaneGeneration(): void {
    if (this.#activeControlPlaneGeneration === null) return;
    this.#activeControlPlaneGeneration = null;
    this.#lifecycleGeneration += 1;
    this.#retireSharedTransports("Code control-plane identity unavailable");
  }

  synchronizeSecurityIdentity(
    activeIdentity: ActiveCodeTransportSecurityIdentity,
  ): void {
    if (
      this.#activeSecurityIdentity !== null &&
      this.#activeSecurityIdentity !== undefined &&
      this.#sameActiveSecurityIdentity(
        this.#activeSecurityIdentity,
        activeIdentity,
      )
    ) {
      return;
    }
    const previouslyInitialized = this.#activeSecurityIdentity !== undefined;
    this.#activeSecurityIdentity = { ...activeIdentity };
    if (!previouslyInitialized) return;
    this.#lifecycleGeneration += 1;
    this.#retireSharedTransports("Code transport security identity changed");
  }

  invalidateSecurityIdentity(): void {
    if (this.#activeSecurityIdentity === null) return;
    this.#activeSecurityIdentity = null;
    this.#lifecycleGeneration += 1;
    this.#retireSharedTransports(
      "Code transport security identity unavailable",
    );
  }

  async prepareProtected(
    tunnelId: string,
    sessionId: string,
    connection: CodeEndpointPreparationContext = {},
  ): Promise<{ kind: "tcp"; host: "127.0.0.1"; port: number }> {
    const endpointId = `protected:${tunnelId}`;
    const details = { tunnelId, sessionId, ...connection };
    const existing = this.#endpoints.get(endpointId);
    if (existing?.kind === "shared") {
      throw new Error(
        "A shared Code transport already owns this protected endpoint.",
      );
    }
    if (existing?.kind === "legacy" && existing.sessionId === sessionId) {
      existing.fallbackConnection = connection;
      return existing.address;
    }
    const pending = this.#preparations.get(endpointId);
    if (pending?.kind === "shared") {
      throw new Error(
        "A shared Code transport is preparing this protected endpoint.",
      );
    }
    if (pending?.kind === "legacy" && pending.sessionId === sessionId) {
      const address = await pending.promise;
      const prepared = this.#endpoints.get(endpointId);
      if (prepared?.kind === "legacy" && prepared.sessionId === sessionId) {
        prepared.fallbackConnection = connection;
      }
      return address;
    }
    this.revoke(endpointId, "Protected Code session rotated");
    const preparation = {} as EndpointPreparation;
    preparation.kind = "legacy";
    preparation.sessionId = sessionId;
    preparation.tunnelId = tunnelId;
    preparation.promise = (async () => {
      const endpoint = await this.#create(
        { kind: "legacy", sessionId, tunnelId },
        connection,
      );
      if (this.#preparations.get(endpointId) !== preparation) {
        this.#closeEndpoint(endpoint, "Protected Code preparation superseded");
        throw new Error("Protected Code endpoint preparation was superseded.");
      }
      this.#endpoints.set(endpointId, endpoint);
      return endpoint.address;
    })();
    this.#preparations.set(endpointId, preparation);
    try {
      const address = await preparation.promise;
      workerLogger.event("info", "Cantrip Code direct endpoint prepared", {
        event: "code.direct.prepared",
        subsystem: "code",
        operation: "prepare-direct-endpoint",
        status: "completed",
        reused: false,
        ...details,
      });
      return address;
    } catch (error) {
      workerLogger.event("warn", "Cantrip Code direct endpoint failed", {
        event: "code.direct.prepare-failed",
        subsystem: "code",
        operation: "prepare-direct-endpoint",
        reasonCode: "endpoint-preparation-failed",
        status: "failed",
        ...details,
        ...workerLogErrorIdentity(error),
      });
      throw error;
    } finally {
      if (this.#preparations.get(endpointId) === preparation) {
        this.#preparations.delete(endpointId);
      }
    }
  }

  async #create(
    context: EndpointCreationContext,
    connection: CodeEndpointPreparationContext,
  ): Promise<Endpoint> {
    const { kind, sessionId, tunnelId } = context;
    const endpoint: Endpoint = {
      address: { kind: "tcp", host: "127.0.0.1", port: 0 },
      connectionContexts: new Map(),
      diagnosticOutcomes: new Map(),
      fallbackConnection: connection,
      kind,
      routesByAttachmentId: new Map(),
      routesByGrant: new Map(),
      server: createServer(),
      sessionId,
      sharedBufferedWebSocketBytes: 0,
      sharedIdentity: null,
      sockets: new Set(),
      tcpSockets: new Set(),
      tunnelId,
    };
    if (kind === "shared") {
      endpoint.server.maxConnections = MAX_SHARED_RAW_CONNECTIONS_PER_TRANSPORT;
    }
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: CODE_MAX_WEBSOCKET_MESSAGE_BYTES,
    });
    const upgradedContexts = new WeakMap<
      IncomingMessage,
      CodeEndpointContext
    >();
    endpoint.server.on("request", (request, response) => {
      const requestContext = this.#requestContext(endpoint, request);
      if (!requestContext) {
        response
          .writeHead(404, { "cache-control": "no-store" })
          .end("Not found");
        return;
      }
      const unregisterRouteRequest = this.#registerRouteRequest(
        requestContext,
        () => {
          if (!response.destroyed) response.destroy();
        },
      );
      response.once("close", unregisterRouteRequest);
      response.once("finish", unregisterRouteRequest);
      this.#proxyHttp(endpoint, requestContext, request, response);
    });
    endpoint.server.on("upgrade", (request, socket, head) => {
      const requestContext = this.#requestContext(endpoint, request);
      if (!requestContext) {
        const connection = this.#connectionContext(endpoint, request);
        workerLogger.rateLimited(
          `code-direct:websocket:${connection.diagnosticTraceId ?? "untraced"}:${endpoint.tunnelId}:invalid-route`,
          "warn",
          "Cantrip Code direct WebSocket path rejected",
          {
            event: "code.direct.websocket-rejected",
            subsystem: "code",
            operation: "open-websocket",
            reasonCode: "invalid-route",
            status: "rejected",
            tunnelId: endpoint.tunnelId,
            ...connection,
          },
        );
        socket.destroy();
        return;
      }
      upgradedContexts.set(request, requestContext);
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit("connection", client, request);
      });
    });
    webSockets.on("connection", (socket, request) => {
      const requestContext = upgradedContexts.get(request);
      upgradedContexts.delete(request);
      if (!requestContext) {
        socket.close(1008, "Unauthorized Code route");
        return;
      }
      endpoint.sockets.add(socket);
      socket.once("close", () => endpoint.sockets.delete(socket));
      requestContext.route?.sockets.add(socket);
      socket.once("close", () => requestContext.route?.sockets.delete(socket));
      this.#proxyWebSocket(endpoint, requestContext, socket, request);
    });
    endpoint.server.on("connection", (socket) => {
      endpoint.tcpSockets.add(socket);
      socket.once("close", () => endpoint.tcpSockets.delete(socket));
      const remotePort = socket.remotePort;
      if (remotePort === undefined) return;
      socket.once("close", () =>
        endpoint.connectionContexts.delete(remotePort),
      );
    });
    await new Promise<void>((resolve, reject) => {
      endpoint.server.once("error", reject);
      endpoint.server.listen(0, "127.0.0.1", () => {
        endpoint.server.off("error", reject);
        resolve();
      });
    });
    const address = endpoint.server.address();
    if (!address || typeof address === "string") {
      endpoint.server.close();
      throw new Error("Direct Code endpoint did not bind a loopback port.");
    }
    endpoint.address = {
      kind: "tcp",
      host: "127.0.0.1",
      port: address.port,
    };
    return endpoint;
  }

  async #ensureSharedEndpoint(transportId: string): Promise<Endpoint> {
    const endpointId = this.#protectedEndpointId(transportId);
    const existing = this.#endpoints.get(endpointId);
    if (existing?.kind === "shared") return existing;
    if (existing) {
      throw new Error(
        "A legacy Code session already owns this protected endpoint.",
      );
    }
    const pending = this.#preparations.get(endpointId);
    if (pending?.kind === "shared") {
      await pending.promise;
      const prepared = this.#endpoints.get(endpointId);
      if (prepared?.kind === "shared") return prepared;
      throw new Error("Shared Code endpoint preparation was superseded.");
    }
    if (pending) {
      throw new Error(
        "A legacy Code session is preparing this protected endpoint.",
      );
    }
    const sharedCount = [...this.#endpoints.values()].filter(
      (endpoint) => endpoint.kind === "shared",
    ).length;
    const sharedPending = [...this.#preparations.values()].filter(
      (preparation) => preparation.kind === "shared",
    ).length;
    if (sharedCount + sharedPending >= MAX_SHARED_TRANSPORTS) {
      throw new Error("The shared Code transport limit was reached.");
    }
    const preparation = {} as EndpointPreparation;
    preparation.kind = "shared";
    preparation.sessionId = null;
    preparation.tunnelId = transportId;
    preparation.promise = (async () => {
      const endpoint = await this.#create(
        { kind: "shared", sessionId: null, tunnelId: transportId },
        {},
      );
      if (this.#preparations.get(endpointId) !== preparation) {
        this.#closeEndpoint(endpoint, "Shared Code preparation superseded");
        throw new Error("Shared Code endpoint preparation was superseded.");
      }
      this.#endpoints.set(endpointId, endpoint);
      workerLogger.event("info", "Shared Cantrip Code endpoint prepared", {
        event: "code.transport.prepared",
        subsystem: "code",
        operation: "prepare-shared-transport",
        status: "completed",
        transportId,
      });
      return endpoint.address;
    })();
    this.#preparations.set(endpointId, preparation);
    try {
      await preparation.promise;
      const prepared = this.#endpoints.get(endpointId);
      if (prepared?.kind !== "shared") {
        throw new Error("Shared Code endpoint preparation did not complete.");
      }
      return prepared;
    } finally {
      if (this.#preparations.get(endpointId) === preparation) {
        this.#preparations.delete(endpointId);
      }
    }
  }

  bindProtectedConnection(
    tunnelId: string,
    endpointPort: number,
    remotePort: number,
    connection: CodeEndpointPreparationContext,
  ): void {
    const endpoint = this.#endpoints.get(this.#protectedEndpointId(tunnelId));
    if (!endpoint || endpoint.address.port !== endpointPort) return;
    endpoint.connectionContexts.set(remotePort, connection);
  }

  revoke(capabilityId: string, reason: string): void {
    this.#preparations.delete(capabilityId);
    const endpoint = this.#endpoints.get(capabilityId);
    if (!endpoint) return;
    this.#endpoints.delete(capabilityId);
    this.#closeEndpoint(endpoint, reason);
    workerLogger.event("info", "Cantrip Code direct endpoint revoked", {
      event: "code.direct.revoked",
      subsystem: "code",
      operation: "revoke-direct-endpoint",
      reasonCode: "endpoint-revoked",
      status: "completed",
      endpointKind: endpoint.kind,
      ...(endpoint.sessionId ? { sessionId: endpoint.sessionId } : {}),
      tunnelId: endpoint.tunnelId,
    });
  }

  #closeEndpoint(endpoint: Endpoint, reason: string): void {
    for (const route of [...endpoint.routesByAttachmentId.values()]) {
      this.#removeSharedRoute(endpoint, route, reason);
    }
    for (const socket of endpoint.sockets) {
      socket.close(1008, reason.slice(0, 123));
    }
    for (const socket of endpoint.tcpSockets) socket.destroy();
    endpoint.server.close();
    endpoint.server.closeAllConnections();
  }

  async closeSession(
    sessionId: string,
    expectedSessionIncarnationId?: string,
  ): Promise<void> {
    this.#sessionGenerations.set(
      sessionId,
      (this.#sessionGenerations.get(sessionId) ?? 0) + 1,
    );
    for (const [endpointId, endpoint] of this.#endpoints) {
      if (endpoint.kind === "legacy" && endpoint.sessionId === sessionId) {
        this.revoke(endpointId, "Code session stopped");
        continue;
      }
      if (endpoint.kind === "shared") {
        for (const route of [...endpoint.routesByAttachmentId.values()]) {
          if (
            route.sessionId === sessionId &&
            (expectedSessionIncarnationId === undefined ||
              route.sessionIncarnationId === expectedSessionIncarnationId)
          ) {
            this.#recordTombstone(
              this.#revokedSharedRoutes,
              this.#sharedRouteKey(endpoint.tunnelId, route.attachmentId),
            );
            this.#removeSharedRoute(endpoint, route, "Code session stopped");
          }
        }
      }
    }
    for (const [endpointId, preparation] of this.#preparations) {
      if (preparation.sessionId === sessionId) {
        this.revoke(endpointId, "Code session stopped");
      }
    }
    await this.#controlTails.get(sessionId);
  }

  disconnect(): void {
    this.#acceptingAuthorizations = false;
    this.#lifecycleGeneration += 1;
    this.#tombstoneSharedTransports();
    for (const capabilityId of new Set([
      ...this.#endpoints.keys(),
      ...this.#preparations.keys(),
    ])) {
      this.revoke(capabilityId, "Worker control connection lost");
    }
  }

  close(): void {
    this.#stopped = true;
    this.#acceptingAuthorizations = false;
    this.#lifecycleGeneration += 1;
    this.#tombstoneSharedTransports();
    for (const capabilityId of new Set([
      ...this.#endpoints.keys(),
      ...this.#preparations.keys(),
    ])) {
      this.revoke(capabilityId, "Worker stopping");
    }
    this.#transportTails.clear();
  }

  #validPath(rawPath: string | undefined, basePath: string): boolean {
    try {
      const url = new URL(rawPath ?? "/", "http://cantrip-code.invalid");
      return (
        url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)
      );
    } catch {
      return false;
    }
  }

  #requestContext(
    endpoint: Endpoint,
    request: IncomingMessage,
  ): CodeEndpointContext | null {
    const connection = this.#connectionContext(endpoint, request);
    if (endpoint.kind === "legacy") {
      if (!endpoint.sessionId || !this.#validPath(request.url, BASE_PATH)) {
        return null;
      }
      return {
        basePath: BASE_PATH,
        sessionId: endpoint.sessionId,
        tunnelId: endpoint.tunnelId,
        ...connection,
      };
    }
    const selection = parseCodeSessionRoutePath(request.url ?? "/");
    if (!selection) return null;
    const route = endpoint.routesByGrant.get(selection.routeGrant);
    if (!route || selection.basePath !== route.basePath) return null;
    const routeConnections = route.sockets.size + route.activeRequests.size;
    const transportConnections = [
      ...endpoint.routesByAttachmentId.values(),
    ].reduce(
      (total, candidate) =>
        total + candidate.sockets.size + candidate.activeRequests.size,
      0,
    );
    if (
      routeConnections >= MAX_SHARED_CONNECTIONS_PER_ROUTE ||
      transportConnections >= MAX_SHARED_CONNECTIONS_PER_TRANSPORT
    ) {
      return null;
    }
    if (route.expiresAtMs <= this.#now()) {
      this.#expireSharedRoute(endpoint, route);
      return null;
    }
    let runtime;
    try {
      runtime = this.supervisor.status(route.sessionId);
    } catch {
      this.#retireStaleSharedRoute(endpoint, route);
      return null;
    }
    if (runtime.sessionIncarnationId !== route.sessionIncarnationId) {
      this.#retireStaleSharedRoute(endpoint, route);
      return null;
    }
    if (runtime.status !== "running") return null;
    return {
      ...connection,
      attachmentId: route.attachmentId,
      basePath: route.basePath,
      route,
      sessionId: route.sessionId,
      sessionIncarnationId: route.sessionIncarnationId,
      tunnelId: endpoint.tunnelId,
    };
  }

  #connectionContext(
    endpoint: Endpoint,
    request: IncomingMessage,
  ): CodeEndpointPreparationContext {
    const remotePort = request.socket.remotePort;
    return (
      (remotePort === undefined
        ? undefined
        : endpoint.connectionContexts.get(remotePort)) ??
      endpoint.fallbackConnection
    );
  }

  #protectedEndpointId(transportId: string): string {
    return `protected:${transportId}`;
  }

  #sharedRouteKey(transportId: string, attachmentId: string): string {
    return `${transportId}\0${attachmentId}`;
  }

  #pruneTombstones(map: Map<string, number>): void {
    const now = this.#now();
    for (const [key, expiresAtMs] of map) {
      if (expiresAtMs <= now) map.delete(key);
    }
  }

  #isTombstoned(map: Map<string, number>, key: string): boolean {
    const expiresAtMs = map.get(key);
    if (expiresAtMs === undefined) return false;
    if (expiresAtMs > this.#now()) return true;
    map.delete(key);
    return false;
  }

  #recordTombstone(map: Map<string, number>, key: string): void {
    this.#pruneTombstones(map);
    if (!map.has(key) && map.size >= MAX_SHARED_TOMBSTONES) {
      this.#tombstoneCapacityExceeded = true;
      return;
    }
    map.set(key, this.#now() + MAX_SHARED_TOMBSTONE_MS);
  }

  #tombstoneSharedTransports(): void {
    for (const endpoint of this.#endpoints.values()) {
      if (endpoint.kind === "shared") {
        this.#recordTombstone(this.#revokedSharedTransports, endpoint.tunnelId);
      }
    }
    for (const preparation of this.#preparations.values()) {
      if (preparation.kind === "shared") {
        this.#recordTombstone(
          this.#revokedSharedTransports,
          preparation.tunnelId,
        );
      }
    }
  }

  #retireSharedTransports(reason: string): void {
    this.#tombstoneSharedTransports();
    for (const [endpointId, endpoint] of [...this.#endpoints]) {
      if (endpoint.kind === "shared") this.revoke(endpointId, reason);
    }
    for (const [endpointId, preparation] of [...this.#preparations]) {
      if (preparation.kind === "shared") this.revoke(endpointId, reason);
    }
  }

  #assertAuthorizationLifecycle(expectedGeneration: number): void {
    if (
      this.#stopped ||
      !this.#acceptingAuthorizations ||
      this.#lifecycleGeneration !== expectedGeneration ||
      this.#tombstoneCapacityExceeded
    ) {
      throw new Error(
        "The worker is not accepting shared Code route authorizations.",
      );
    }
  }

  #commandIdentity(
    command:
      | CodeTransportRouteAuthorizeCommand
      | CodeTransportRouteRevokeCommand
      | CodeTransportRevokeCommand,
  ): SharedTransportIdentity {
    return {
      authSessionId: command.authSessionId,
      ownerId: command.ownerId,
      protectedKeyRevision: command.protectedKeyRevision,
      serverControlPlaneGeneration: command.serverControlPlaneGeneration,
      serverId: command.serverId,
      workerProcessGeneration: command.workerProcessGeneration,
    };
  }

  #sameTransportIdentity(
    left: SharedTransportIdentity,
    right: SharedTransportIdentity,
  ): boolean {
    return (
      left.authSessionId === right.authSessionId &&
      left.ownerId === right.ownerId &&
      left.protectedKeyRevision === right.protectedKeyRevision &&
      left.serverControlPlaneGeneration ===
        right.serverControlPlaneGeneration &&
      left.serverId === right.serverId &&
      left.workerProcessGeneration === right.workerProcessGeneration
    );
  }

  #sameActiveSecurityIdentity(
    left: ActiveCodeTransportSecurityIdentity,
    right: ActiveCodeTransportSecurityIdentity,
  ): boolean {
    return (
      left.ownerId === right.ownerId &&
      left.protectedKeyRevision === right.protectedKeyRevision &&
      left.serverId === right.serverId
    );
  }

  #assertCommandIdentity(
    command:
      | CodeTransportRouteAuthorizeCommand
      | CodeTransportRouteRevokeCommand
      | CodeTransportRevokeCommand,
    activeIdentity: ActiveCodeTransportSecurityIdentity,
  ): void {
    if (this.#activeSecurityIdentity === undefined) {
      this.#activeSecurityIdentity = { ...activeIdentity };
    }
    if (
      this.#activeSecurityIdentity === null ||
      !this.#sameActiveSecurityIdentity(
        this.#activeSecurityIdentity,
        activeIdentity,
      ) ||
      command.ownerId !== activeIdentity.ownerId ||
      command.serverId !== activeIdentity.serverId ||
      command.serverControlPlaneGeneration !==
        this.#activeControlPlaneGeneration ||
      command.protectedKeyRevision !== activeIdentity.protectedKeyRevision ||
      command.workerProcessGeneration !== this.#workerProcessGeneration
    ) {
      throw new Error(
        "The shared Code lifecycle command belongs to another security identity.",
      );
    }
  }

  #assertSharedEndpointIdentity(
    endpoint: Endpoint,
    command:
      | CodeTransportRouteAuthorizeCommand
      | CodeTransportRouteRevokeCommand
      | CodeTransportRevokeCommand,
  ): void {
    if (
      !endpoint.sharedIdentity ||
      !this.#sameTransportIdentity(
        endpoint.sharedIdentity,
        this.#commandIdentity(command),
      )
    ) {
      throw new Error(
        "The shared Code transport belongs to another security identity.",
      );
    }
  }

  #enqueueTransport<T>(
    transportId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#transportTails.get(transportId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#transportTails.set(transportId, tail);
    void tail.then(() => {
      if (this.#transportTails.get(transportId) === tail) {
        this.#transportTails.delete(transportId);
      }
    });
    return result;
  }

  #scheduleSharedRouteExpiry(
    endpoint: Endpoint,
    route: SharedSessionRoute,
  ): void {
    if (route.expiryTimer) clearTimeout(route.expiryTimer);
    const generation = Symbol(route.attachmentId);
    route.expiryGeneration = generation;
    const schedule = () => {
      const remaining = route.expiresAtMs - this.#now();
      if (remaining <= 0) {
        if (
          route.expiryGeneration === generation &&
          endpoint.routesByAttachmentId.get(route.attachmentId) === route
        ) {
          this.#expireSharedRoute(endpoint, route);
        }
        return;
      }
      route.expiryTimer = setTimeout(
        schedule,
        Math.min(remaining, 2_147_483_647),
      );
      route.expiryTimer.unref();
    };
    schedule();
  }

  #expireSharedRoute(endpoint: Endpoint, route: SharedSessionRoute): void {
    this.#recordTombstone(
      this.#revokedSharedRoutes,
      this.#sharedRouteKey(endpoint.tunnelId, route.attachmentId),
    );
    this.#removeSharedRoute(endpoint, route, "Code route expired");
  }

  #retireStaleSharedRoute(endpoint: Endpoint, route: SharedSessionRoute): void {
    this.#recordTombstone(
      this.#revokedSharedRoutes,
      this.#sharedRouteKey(endpoint.tunnelId, route.attachmentId),
    );
    this.#removeSharedRoute(endpoint, route, "Code session changed");
  }

  #removeSharedRoute(
    endpoint: Endpoint,
    route: SharedSessionRoute,
    reason: string,
  ): void {
    if (endpoint.routesByAttachmentId.get(route.attachmentId) !== route) return;
    endpoint.routesByAttachmentId.delete(route.attachmentId);
    if (endpoint.routesByGrant.get(route.routeGrant) === route) {
      endpoint.routesByGrant.delete(route.routeGrant);
    }
    if (route.expiryTimer) {
      clearTimeout(route.expiryTimer);
      route.expiryTimer = null;
    }
    route.expiryGeneration = Symbol(route.attachmentId);
    for (const close of [...route.activeRequests]) close();
    for (const teardown of [...route.webSocketTeardowns]) teardown();
    for (const socket of [...route.sockets])
      socket.close(1008, reason.slice(0, 123));
    workerLogger.event("info", "Shared Cantrip Code route revoked", {
      event: "code.transport.route.revoked",
      subsystem: "code",
      operation: "revoke-transport-route",
      reasonCode: "route-revoked",
      status: "completed",
      transportId: endpoint.tunnelId,
      attachmentId: route.attachmentId,
      sessionId: route.sessionId,
      sessionIncarnationId: route.sessionIncarnationId,
    });
  }

  #registerRouteRequest(
    context: CodeEndpointContext,
    close: () => void,
  ): () => void {
    const route = context.route;
    if (!route) return () => undefined;
    route.activeRequests.add(close);
    return () => route.activeRequests.delete(close);
  }

  #assertRouteActive(context: CodeEndpointContext): void {
    const route = context.route;
    if (!route) return;
    const endpoint = this.#endpoints.get(
      this.#protectedEndpointId(context.tunnelId),
    );
    if (
      endpoint?.kind !== "shared" ||
      endpoint.routesByAttachmentId.get(route.attachmentId) !== route
    ) {
      throw new Error("The shared Code route was revoked.");
    }
    if (route.expiresAtMs <= this.#now()) {
      this.#expireSharedRoute(endpoint, route);
      throw new Error("The shared Code route expired.");
    }
    let runtime;
    try {
      runtime = this.supervisor.status(route.sessionId);
    } catch {
      this.#retireStaleSharedRoute(endpoint, route);
      throw new Error("The shared Code session is unavailable.");
    }
    if (runtime.sessionIncarnationId !== route.sessionIncarnationId) {
      this.#retireStaleSharedRoute(endpoint, route);
      throw new Error("The shared Code session changed.");
    }
    if (runtime.status !== "running") {
      throw new Error("The shared Code session is recovering.");
    }
  }

  #logContext(context: CodeEndpointContext): Record<string, unknown> {
    return {
      ...(context.attachmentId ? { attachmentId: context.attachmentId } : {}),
      ...(context.connectionId ? { connectionId: context.connectionId } : {}),
      ...(context.diagnosticTraceId
        ? { diagnosticTraceId: context.diagnosticTraceId }
        : {}),
      sessionId: context.sessionId,
      ...(context.sessionIncarnationId
        ? { sessionIncarnationId: context.sessionIncarnationId }
        : {}),
      tunnelId: context.tunnelId,
    };
  }

  #firstOutcome(
    endpoint: Endpoint,
    outcome: "health" | "http-success" | "websocket-success",
    context: CodeEndpointContext,
  ): boolean {
    const traceKey = `${context.diagnosticTraceId ?? "untraced"}:${context.attachmentId ?? "legacy"}`;
    let outcomes = endpoint.diagnosticOutcomes.get(traceKey);
    if (outcomes?.has(outcome)) return false;
    if (!outcomes) {
      if (endpoint.diagnosticOutcomes.size >= MAX_ENDPOINT_DIAGNOSTIC_TRACES) {
        const oldestTrace = endpoint.diagnosticOutcomes.keys().next().value;
        if (oldestTrace !== undefined) {
          endpoint.diagnosticOutcomes.delete(oldestTrace);
        }
      }
      outcomes = new Set();
      endpoint.diagnosticOutcomes.set(traceKey, outcomes);
    }
    outcomes.add(outcome);
    return true;
  }

  #failureKey(
    transport: "http" | "websocket",
    context: CodeEndpointContext,
    reasonCode: string,
  ): string {
    return `code-direct:${transport}:${context.diagnosticTraceId ?? "untraced"}:${context.tunnelId}:${reasonCode}`;
  }

  #proxyHttp(
    endpoint: Endpoint,
    context: CodeEndpointContext,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const {
      basePath,
      route: _route,
      sessionId,
      sessionIncarnationId,
      tunnelId,
      ...connection
    } = context;
    const requestId = randomUUID();
    const startedAtMs = Date.now();
    const details = {
      sessionId,
      tunnelId,
      ...connection,
      requestId,
      method: request.method ?? "GET",
    };
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://cantrip-code.invalid")
        .pathname;
    } catch {
      response.writeHead(404, { "cache-control": "no-store" }).end("Not found");
      return;
    }
    if (
      pathname === `${basePath}/_cantrip/health` &&
      this.#firstOutcome(endpoint, "health", context)
    ) {
      workerLogger.event("info", "Cantrip Code direct health reached", {
        event: "code.direct.health-reached",
        subsystem: "code",
        operation: "check-direct-endpoint",
        status: "completed",
        ...details,
        durationMs: Date.now() - startedAtMs,
      });
    }
    if (pathname === `${basePath}/_cantrip/health`) {
      response
        .writeHead(200, {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json",
        })
        .end('{"status":"ok"}');
      return;
    }
    if (pathname === `${basePath}/_cantrip/open-file`) {
      void this.#openFile(context, request, response);
      return;
    }
    if (pathname === `${basePath}/_cantrip/open-settings`) {
      void this.#openSettings(context, request, response);
      return;
    }
    if (pathname === `${basePath}/_cantrip/open-extensions`) {
      void this.#openExtensions(context, request, response);
      return;
    }
    if (pathname === `${basePath}/_cantrip/presentation`) {
      void this.#setPresentation(context, request, response);
      return;
    }
    if (pathname === `${basePath}/_cantrip/theme`) {
      void this.#setTheme(context, request, response);
      return;
    }
    if (!this.#validPath(request.url, basePath)) {
      response.writeHead(404, { "cache-control": "no-store" }).end("Not found");
      return;
    }
    let releaseStream: (() => void) | null = null;
    let failureReason = "session-unavailable";
    try {
      this.#assertRouteActive(context);
      const proxy = this.supervisor.proxyTarget(sessionId);
      const streamId = `direct-http:${randomUUID()}`;
      failureReason = "stream-registration-failed";
      this.supervisor.beginTunnelStream(sessionId, streamId);
      let ended = false;
      const endStream = () => {
        if (ended) return;
        ended = true;
        this.supervisor.endTunnelStream(sessionId, streamId);
      };
      releaseStream = endStream;
      failureReason = "invalid-editor-target";
      const target = codeEditorTargetUrl(
        proxy.editorOrigin,
        request.url ?? `${basePath}/`,
        basePath,
        proxy.workspaceUri,
      );
      failureReason = "editor-request-start-failed";
      let incomingResponse: IncomingMessage | null = null;
      let downstreamClosed = false;
      const upstream = requestHttp(
        target,
        {
          method: request.method ?? "GET",
          headers: codeEditorRequestHeaders(
            rawHeaders(request),
            target,
            publicBasePath(request, basePath),
            proxy.connectionToken,
          ),
        },
        (incoming) => {
          incomingResponse = incoming;
          if (downstreamClosed) {
            incoming.destroy();
            upstream.destroy();
            endStream();
            return;
          }
          if (this.#firstOutcome(endpoint, "http-success", context)) {
            workerLogger.event(
              "debug",
              "Cantrip Code editor HTTP response received",
              {
                event: "code.direct.http-upstream-responded",
                subsystem: "code",
                operation: "proxy-http",
                status: "completed",
                ...details,
                statusCode: incoming.statusCode ?? 502,
                durationMs: Date.now() - startedAtMs,
              },
            );
          }
          writeResponseHeaders(response, incoming);
          incoming.pipe(response);
          incoming.once("end", endStream);
          incoming.once("error", (error) => {
            endStream();
            workerLogger.rateLimited(
              this.#failureKey("http", context, "editor-response-error"),
              "warn",
              "Cantrip Code editor HTTP response failed",
              {
                event: "code.direct.http-upstream-failed",
                subsystem: "code",
                operation: "proxy-http",
                reasonCode: "editor-response-error",
                status: "failed",
                ...details,
                durationMs: Date.now() - startedAtMs,
                ...workerLogErrorIdentity(error),
              },
            );
          });
        },
      );
      upstream.once("error", (error) => {
        endStream();
        if (downstreamClosed) return;
        workerLogger.rateLimited(
          this.#failureKey("http", context, "editor-connection-error"),
          "warn",
          "Cantrip Code editor HTTP request failed",
          {
            event: "code.direct.http-upstream-failed",
            subsystem: "code",
            operation: "proxy-http",
            reasonCode: "editor-connection-error",
            status: "failed",
            ...details,
            durationMs: Date.now() - startedAtMs,
            ...workerLogErrorIdentity(error),
          },
        );
        if (!response.headersSent) response.writeHead(502);
        response.end("Cantrip Code is unavailable.");
      });
      const closeUpstream = () => {
        if (downstreamClosed) return;
        downstreamClosed = true;
        incomingResponse?.destroy();
        upstream.destroy();
        if (!response.destroyed) response.destroy();
        endStream();
      };
      request.once("aborted", closeUpstream);
      response.once("close", closeUpstream);
      request.pipe(upstream);
    } catch (error) {
      releaseStream?.();
      workerLogger.rateLimited(
        this.#failureKey("http", context, failureReason),
        "warn",
        "Cantrip Code HTTP proxy rejected",
        {
          event: "code.direct.http-proxy-failed",
          subsystem: "code",
          operation: "proxy-http",
          reasonCode: failureReason,
          status: "failed",
          ...details,
          durationMs: Date.now() - startedAtMs,
          ...workerLogErrorIdentity(error),
        },
      );
      response
        .writeHead(503, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        })
        .end(
          error instanceof Error
            ? error.message
            : "Cantrip Code is unavailable.",
        );
    }
  }

  async #openFile(
    context: CodeEndpointContext,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const { sessionId } = context;
    const sessionGeneration = this.#sessionGenerations.get(sessionId) ?? 0;
    if (request.method === "OPTIONS") {
      writeControlResponse(response, 204);
      return;
    }
    if (request.method !== "POST") {
      writeControlResponse(response, 405, {
        error: "Cantrip Code file-open requests require POST.",
      });
      return;
    }
    let body: unknown;
    try {
      body = await readControlRequest(request);
    } catch {
      writeControlResponse(response, 400, {
        error: "Cantrip Code requires a valid JSON request body.",
      });
      return;
    }
    const input = codeOpenFileRequestSchema.safeParse(body);
    if (!input.success) {
      writeControlResponse(response, 400, {
        error: "Cantrip Code requires a valid worktree-relative file path.",
      });
      return;
    }
    try {
      this.#assertRouteActive(context);
      const result = codeOpenFileResultSchema.parse(
        await this.#enqueueControl(sessionId, () => {
          this.#assertRouteActive(context);
          return (this.#sessionGenerations.get(sessionId) ?? 0) ===
            sessionGeneration
            ? this.supervisor.openFile(sessionId, input.data.relativePath)
            : Promise.reject(new Error("Cantrip Code session stopped."));
        }),
      );
      writeControlResponse(response, 200, result);
      workerLogger.event("debug", "Cantrip Code direct file opened", {
        event: "code.direct.file-opened",
        subsystem: "code",
        operation: "open-file",
        status: "completed",
        ...this.#logContext(context),
      });
    } catch (error) {
      workerLogger.event("warn", "Cantrip Code direct file open failed", {
        event: "code.direct.file-open-failed",
        subsystem: "code",
        operation: "open-file",
        reasonCode: "open-failed",
        status: "failed",
        ...this.#logContext(context),
        error: workerLogError(error),
      });
      writeControlResponse(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : "Cantrip Code could not open this file.",
      });
    }
  }

  #enqueueControl<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#controlTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#controlTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#controlTails.get(sessionId) === tail) {
        this.#controlTails.delete(sessionId);
      }
    });
    return result;
  }

  async #openSettings(
    context: CodeEndpointContext,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const { sessionId } = context;
    const sessionGeneration = this.#sessionGenerations.get(sessionId) ?? 0;
    if (request.method === "OPTIONS") {
      writeControlResponse(response, 204);
      return;
    }
    if (request.method !== "POST") {
      writeControlResponse(response, 405, {
        error: "Cantrip Code settings-open requests require POST.",
      });
      return;
    }
    let body: unknown;
    try {
      body = await readControlRequest(request);
    } catch {
      writeControlResponse(response, 400, {
        error: "Cantrip Code requires a valid JSON request body.",
      });
      return;
    }
    if (!codeOpenSettingsRequestSchema.safeParse(body).success) {
      writeControlResponse(response, 400, {
        error: "Cantrip Code settings-open requests require an empty body.",
      });
      return;
    }
    try {
      this.#assertRouteActive(context);
      const result = codeOpenSettingsResultSchema.parse(
        await this.#enqueueControl(sessionId, () => {
          this.#assertRouteActive(context);
          return (this.#sessionGenerations.get(sessionId) ?? 0) ===
            sessionGeneration
            ? this.supervisor.openSettings(sessionId)
            : Promise.reject(new Error("Cantrip Code session stopped."));
        }),
      );
      writeControlResponse(response, 200, result);
      workerLogger.event("debug", "Cantrip Code graphical settings opened", {
        event: "code.direct.settings-opened",
        subsystem: "code",
        operation: "open-settings",
        status: "completed",
        ...this.#logContext(context),
      });
    } catch (error) {
      workerLogger.event("warn", "Cantrip Code settings open failed", {
        event: "code.direct.settings-open-failed",
        subsystem: "code",
        operation: "open-settings",
        reasonCode: "open-failed",
        status: "failed",
        ...this.#logContext(context),
        error: workerLogError(error),
      });
      writeControlResponse(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : "Cantrip Code could not open graphical settings.",
      });
    }
  }

  async #openExtensions(
    context: CodeEndpointContext,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const { sessionId } = context;
    const sessionGeneration = this.#sessionGenerations.get(sessionId) ?? 0;
    if (request.method === "OPTIONS") {
      writeControlResponse(response, 204);
      return;
    }
    if (request.method !== "POST") {
      writeControlResponse(response, 405, {
        error: "Cantrip Code extensions-open requests require POST.",
      });
      return;
    }
    let body: unknown;
    try {
      body = await readControlRequest(request);
    } catch {
      writeControlResponse(response, 400, {
        error: "Cantrip Code requires a valid JSON request body.",
      });
      return;
    }
    if (!codeOpenExtensionsRequestSchema.safeParse(body).success) {
      writeControlResponse(response, 400, {
        error: "Cantrip Code extensions-open requests require an empty body.",
      });
      return;
    }
    try {
      this.#assertRouteActive(context);
      const result = codeOpenExtensionsResultSchema.parse(
        await this.#enqueueControl(sessionId, () => {
          this.#assertRouteActive(context);
          return (this.#sessionGenerations.get(sessionId) ?? 0) ===
            sessionGeneration
            ? this.supervisor.openExtensions(sessionId)
            : Promise.reject(new Error("Cantrip Code session stopped."));
        }),
      );
      writeControlResponse(response, 200, result);
      workerLogger.event("debug", "Cantrip Code extensions opened", {
        event: "code.direct.extensions-opened",
        subsystem: "code",
        operation: "open-extensions",
        status: "completed",
        ...this.#logContext(context),
      });
    } catch (error) {
      workerLogger.event("warn", "Cantrip Code extensions open failed", {
        event: "code.direct.extensions-open-failed",
        subsystem: "code",
        operation: "open-extensions",
        reasonCode: "open-failed",
        status: "failed",
        ...this.#logContext(context),
        error: workerLogError(error),
      });
      writeControlResponse(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : "Cantrip Code could not open extensions.",
      });
    }
  }

  async #setPresentation(
    context: CodeEndpointContext,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const { sessionId } = context;
    const sessionGeneration = this.#sessionGenerations.get(sessionId) ?? 0;
    if (request.method === "OPTIONS") {
      writeControlResponse(response, 204);
      return;
    }
    if (request.method !== "POST") {
      writeControlResponse(response, 405, {
        error: "Cantrip Code presentation requests require POST.",
      });
      return;
    }
    let body: unknown;
    try {
      body = await readControlRequest(request);
    } catch {
      writeControlResponse(response, 400, {
        error: "Cantrip Code requires a valid JSON request body.",
      });
      return;
    }
    const input = codePresentationUpdateSchema.safeParse(body);
    if (!input.success || input.data.presentation !== "editor") {
      writeControlResponse(response, 400, {
        error: "Cantrip Code only supports the editor presentation here.",
      });
      return;
    }
    try {
      this.#assertRouteActive(context);
      await this.#enqueueControl(sessionId, () => {
        this.#assertRouteActive(context);
        return (this.#sessionGenerations.get(sessionId) ?? 0) ===
          sessionGeneration
          ? this.supervisor.setPresentation(sessionId, "editor")
          : Promise.reject(new Error("Cantrip Code session stopped."));
      });
      writeControlResponse(response, 200, input.data);
      workerLogger.event("debug", "Cantrip Code direct presentation updated", {
        event: "code.direct.presentation-updated",
        subsystem: "code",
        operation: "set-presentation",
        status: "completed",
        presentation: "editor",
        ...this.#logContext(context),
      });
    } catch (error) {
      workerLogger.event(
        "warn",
        "Cantrip Code direct presentation update failed",
        {
          event: "code.direct.presentation-update-failed",
          subsystem: "code",
          operation: "set-presentation",
          reasonCode: "update-failed",
          status: "failed",
          ...this.#logContext(context),
          error: workerLogError(error),
        },
      );
      writeControlResponse(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : "Cantrip Code could not enter editor-only mode.",
      });
    }
  }

  async #setTheme(
    context: CodeEndpointContext,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const { sessionId } = context;
    const sessionGeneration = this.#sessionGenerations.get(sessionId) ?? 0;
    if (request.method === "OPTIONS") {
      writeControlResponse(response, 204);
      return;
    }
    if (request.method !== "POST") {
      writeControlResponse(response, 405, {
        error: "Cantrip Code theme requests require POST.",
      });
      return;
    }
    let body: unknown;
    try {
      body = await readControlRequest(request);
    } catch {
      writeControlResponse(response, 400, {
        error: "Cantrip Code requires a valid JSON request body.",
      });
      return;
    }
    const input = codeThemeUpdateSchema.safeParse(body);
    if (!input.success || input.data.themeMode !== "follow-cantrip") {
      writeControlResponse(response, 400, {
        error: "Cantrip Code only supports follow-Cantrip theme updates here.",
      });
      return;
    }
    try {
      this.#assertRouteActive(context);
      await this.#enqueueControl(sessionId, () => {
        this.#assertRouteActive(context);
        return (this.#sessionGenerations.get(sessionId) ?? 0) ===
          sessionGeneration
          ? this.supervisor.setTheme(
              sessionId,
              input.data.themeMode,
              input.data.appearance,
            )
          : Promise.reject(new Error("Cantrip Code session stopped."));
      });
      writeControlResponse(response, 200, input.data);
      workerLogger.event("debug", "Cantrip Code direct theme updated", {
        event: "code.direct.theme-updated",
        subsystem: "code",
        operation: "set-theme",
        status: "completed",
        themeMode: input.data.themeMode,
        appearance: input.data.appearance,
        ...this.#logContext(context),
      });
    } catch (error) {
      workerLogger.event("warn", "Cantrip Code direct theme update failed", {
        event: "code.direct.theme-update-failed",
        subsystem: "code",
        operation: "set-theme",
        reasonCode: "update-failed",
        status: "failed",
        ...this.#logContext(context),
        error: workerLogError(error),
      });
      writeControlResponse(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : "Cantrip Code could not update the editor theme.",
      });
    }
  }

  #proxyWebSocket(
    endpoint: Endpoint,
    context: CodeEndpointContext,
    client: WebSocket,
    request: IncomingMessage,
  ): void {
    const {
      basePath,
      route: _route,
      sessionId,
      sessionIncarnationId,
      tunnelId,
      ...connection
    } = context;
    const requestId = randomUUID();
    const startedAtMs = Date.now();
    const details = { sessionId, tunnelId, ...connection, requestId };
    let releaseStream: (() => void) | null = null;
    let failureReason = "session-unavailable";
    try {
      this.#assertRouteActive(context);
      const proxy = this.supervisor.proxyTarget(sessionId);
      const streamId = `direct-websocket:${randomUUID()}`;
      failureReason = "stream-registration-failed";
      this.supervisor.beginTunnelStream(sessionId, streamId);
      let ended = false;
      const endStream = () => {
        if (ended) return;
        ended = true;
        this.supervisor.endTunnelStream(sessionId, streamId);
      };
      releaseStream = endStream;
      failureReason = "invalid-editor-target";
      const target = codeEditorTargetUrl(
        proxy.editorOrigin,
        request.url ?? `${basePath}/`,
        basePath,
        proxy.workspaceUri,
      );
      target.protocol = "ws:";
      failureReason = "editor-websocket-start-failed";
      const upstream = new WebSocket(target, protocols(request.headers), {
        headers: codeEditorRequestHeaders(
          rawHeaders(request).filter(
            ([name]) => name.toLowerCase() !== "sec-websocket-protocol",
          ),
          target,
          publicBasePath(request, basePath),
          proxy.connectionToken,
        ),
        maxPayload: CODE_MAX_WEBSOCKET_MESSAGE_BYTES,
      });
      const reservations = new Set<() => void>();
      const reserveBufferedBytes = (bytes: number): (() => void) | null => {
        const route = context.route;
        if (!route) return () => undefined;
        if (
          route.bufferedWebSocketBytes + bytes >
            MAX_SHARED_ROUTE_BUFFERED_BYTES ||
          endpoint.sharedBufferedWebSocketBytes + bytes >
            MAX_SHARED_TRANSPORT_BUFFERED_BYTES
        ) {
          return null;
        }
        route.bufferedWebSocketBytes += bytes;
        endpoint.sharedBufferedWebSocketBytes += bytes;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          reservations.delete(release);
          route.bufferedWebSocketBytes = Math.max(
            0,
            route.bufferedWebSocketBytes - bytes,
          );
          endpoint.sharedBufferedWebSocketBytes = Math.max(
            0,
            endpoint.sharedBufferedWebSocketBytes - bytes,
          );
        };
        reservations.add(release);
        return release;
      };
      const queued: Array<{
        data: Buffer;
        binary: boolean;
        release: () => void;
      }> = [];
      let queuedBytes = 0;
      let authenticationForwarded = false;
      let forceCloseTimer: NodeJS.Timeout | null = null;
      let teardownRequested = false;
      const releaseReservations = () => {
        for (const release of [...reservations]) release();
        queued.length = 0;
        queuedBytes = 0;
      };
      let revokeTeardown: (() => void) | null = null;
      const unregisterTeardown = () => {
        if (revokeTeardown) {
          context.route?.webSocketTeardowns.delete(revokeTeardown);
        }
      };
      const forceTeardown = () => {
        teardownRequested = true;
        releaseReservations();
        endStream();
        unregisterTeardown();
        if (client.readyState !== WebSocket.CLOSED) client.terminate();
        if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
      };
      const scheduleForcedTeardown = () => {
        if (forceCloseTimer) return;
        forceCloseTimer = setTimeout(forceTeardown, 1_000);
        forceCloseTimer.unref();
      };
      const finishTeardown = () => {
        if (
          client.readyState !== WebSocket.CLOSED ||
          upstream.readyState !== WebSocket.CLOSED
        ) {
          scheduleForcedTeardown();
          return;
        }
        if (forceCloseTimer) clearTimeout(forceCloseTimer);
        forceCloseTimer = null;
        releaseReservations();
        unregisterTeardown();
      };
      const closeBoth = (code = 1011, reason = "Cantrip Code disconnected") => {
        teardownRequested = true;
        if (client.readyState === WebSocket.OPEN) client.close(code, reason);
        if (upstream.readyState === WebSocket.OPEN)
          upstream.close(code, reason);
        else upstream.terminate();
        scheduleForcedTeardown();
      };
      revokeTeardown = () => closeBoth(1008, "Code route revoked");
      context.route?.webSocketTeardowns.add(revokeTeardown);
      const forward = (data: RawData, binary: boolean) => {
        try {
          let payload = rawCodeWebSocketBytes(data);
          if (!authenticationForwarded) {
            payload = Buffer.from(
              editorAuthenticatedPayload(payload, proxy.connectionToken),
            );
            authenticationForwarded = true;
          }
          if (upstream.readyState !== WebSocket.OPEN) {
            const release = reserveBufferedBytes(payload.byteLength);
            if (!release) {
              closeBoth(1009, "Route buffer exceeded");
              return;
            }
            queued.push({ data: payload, binary, release });
            queuedBytes += payload.byteLength;
            if (queuedBytes > MAX_BUFFERED_BYTES)
              closeBoth(1009, "Startup buffer exceeded");
            return;
          }
          if (
            upstream.bufferedAmount + payload.byteLength >
            MAX_BUFFERED_BYTES
          ) {
            closeBoth(1009, "Client buffer exceeded");
            return;
          }
          const release = reserveBufferedBytes(payload.byteLength);
          if (!release) {
            closeBoth(1009, "Route buffer exceeded");
            return;
          }
          upstream.send(payload, { binary }, (error) => {
            release();
            if (error) closeBoth();
          });
        } catch (error) {
          workerLogger.rateLimited(
            this.#failureKey(
              "websocket",
              context,
              "invalid-authentication-frame",
            ),
            "warn",
            "Cantrip Code direct WebSocket input rejected",
            {
              event: "code.direct.websocket-rejected",
              subsystem: "code",
              operation: "forward-websocket",
              reasonCode: "invalid-authentication-frame",
              status: "rejected",
              ...details,
              ...workerLogErrorIdentity(error),
            },
          );
          closeBoth(1008, "Invalid Code authentication frame");
        }
      };
      client.on("message", forward);
      upstream.once("open", () => {
        try {
          this.#assertRouteActive(context);
        } catch {
          closeBoth(1008, "Code route revoked");
          return;
        }
        if (client.readyState !== WebSocket.OPEN) {
          upstream.close(1008, "Code route revoked");
          return;
        }
        if (this.#firstOutcome(endpoint, "websocket-success", context)) {
          workerLogger.event(
            "debug",
            "Cantrip Code direct editor WebSocket opened",
            {
              event: "code.direct.websocket-opened",
              subsystem: "code",
              operation: "open-websocket",
              status: "completed",
              ...details,
              durationMs: Date.now() - startedAtMs,
            },
          );
        }
        for (const item of queued.splice(0)) {
          upstream.send(item.data, { binary: item.binary }, (error) => {
            item.release();
            if (error) closeBoth();
          });
        }
        queuedBytes = 0;
      });
      upstream.on("message", (data, binary) => {
        const payload = rawCodeWebSocketBytes(data);
        if (
          client.readyState !== WebSocket.OPEN ||
          client.bufferedAmount + payload.byteLength > MAX_BUFFERED_BYTES
        ) {
          closeBoth(1009, "Editor buffer exceeded");
          return;
        }
        const release = reserveBufferedBytes(payload.byteLength);
        if (!release) {
          closeBoth(1009, "Route buffer exceeded");
          return;
        }
        client.send(payload, { binary }, (error) => {
          release();
          if (error) closeBoth();
        });
      });
      client.once("close", (code, reason) => {
        endStream();
        if (upstream.readyState === WebSocket.OPEN) {
          const forwarded = forwardableCodeWebSocketClose(code, reason);
          upstream.close(forwarded.code, forwarded.reason);
        } else upstream.terminate();
        finishTeardown();
      });
      client.once("error", (error) => {
        workerLogger.rateLimited(
          this.#failureKey("websocket", context, "client-error"),
          "warn",
          "Cantrip Code direct client WebSocket failed",
          {
            event: "code.direct.client-failed",
            subsystem: "code",
            operation: "forward-websocket",
            reasonCode: "client-error",
            status: "degraded",
            ...details,
            durationMs: Date.now() - startedAtMs,
            ...workerLogErrorIdentity(error),
          },
        );
        endStream();
        closeBoth();
      });
      upstream.once("close", (code, reason) => {
        endStream();
        if (client.readyState === WebSocket.OPEN) {
          const forwarded = forwardableCodeWebSocketClose(code, reason);
          client.close(forwarded.code, forwarded.reason);
        }
        finishTeardown();
      });
      upstream.once("error", (error) => {
        if (!teardownRequested) {
          workerLogger.rateLimited(
            this.#failureKey("websocket", context, "editor-websocket-error"),
            "warn",
            "Cantrip Code direct editor WebSocket failed",
            {
              event: "code.direct.editor-failed",
              subsystem: "code",
              operation: "forward-websocket",
              reasonCode: "editor-websocket-error",
              status: "degraded",
              ...details,
              durationMs: Date.now() - startedAtMs,
              ...workerLogErrorIdentity(error),
            },
          );
        }
        endStream();
        closeBoth();
      });
    } catch (error) {
      releaseStream?.();
      workerLogger.rateLimited(
        this.#failureKey("websocket", context, failureReason),
        "warn",
        "Cantrip Code WebSocket proxy rejected",
        {
          event: "code.direct.websocket-proxy-failed",
          subsystem: "code",
          operation: "open-websocket",
          reasonCode: failureReason,
          status: "failed",
          ...details,
          durationMs: Date.now() - startedAtMs,
          ...workerLogErrorIdentity(error),
        },
      );
      client.close(
        1013,
        (error instanceof Error
          ? error.message
          : "Cantrip Code is unavailable"
        ).slice(0, 123),
      );
    }
  }
}
