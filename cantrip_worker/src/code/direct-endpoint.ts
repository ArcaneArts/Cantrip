import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";

import {
  CODE_MAX_WEBSOCKET_MESSAGE_BYTES,
  codeOpenFileRequestSchema,
  codeOpenFileResultSchema,
  codeOpenSettingsRequestSchema,
  codeOpenSettingsResultSchema,
  codePresentationUpdateSchema,
  codeThemeUpdateSchema,
  isForwardableCodeWebSocketCloseCode,
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

interface Endpoint {
  address: { kind: "tcp"; host: "127.0.0.1"; port: number };
  connectionContexts: Map<number, CodeEndpointPreparationContext>;
  diagnosticOutcomes: Map<
    string,
    Set<"health" | "http-success" | "websocket-success">
  >;
  fallbackConnection: CodeEndpointPreparationContext;
  server: HttpServer;
  sessionId: string;
  sockets: Set<WebSocket>;
  tunnelId: string;
}

interface EndpointPreparation {
  promise: Promise<{ kind: "tcp"; host: "127.0.0.1"; port: number }>;
  sessionId: string;
}

interface CodeEndpointPreparationContext {
  attachmentId?: string;
  connectionId?: string;
  diagnosticTraceId?: string;
}

interface CodeEndpointContext extends CodeEndpointPreparationContext {
  sessionId: string;
  tunnelId: string;
}

const BASE_PATH = "/code";
const OPEN_FILE_PATH = `${BASE_PATH}/_cantrip/open-file`;
const OPEN_SETTINGS_PATH = `${BASE_PATH}/_cantrip/open-settings`;
const PRESENTATION_PATH = `${BASE_PATH}/_cantrip/presentation`;
const THEME_PATH = `${BASE_PATH}/_cantrip/theme`;
const MAX_CONTROL_REQUEST_BYTES = 16 * 1_024;
const MAX_BUFFERED_BYTES = 8 * 1_024 * 1_024;
const MAX_ENDPOINT_DIAGNOSTIC_TRACES = 128;
const FRAME_ANCESTORS =
  "frame-ancestors 'self' http://127.0.0.1:1420 http://tauri.localhost https://tauri.localhost tauri://localhost";
const ABNORMAL_CLOSE_CODE = 1011;
const ABNORMAL_CLOSE_REASON = "Cantrip Code peer disconnected abnormally";
const WEB_CODE_BASE_PATH =
  /^\/__cantrip_code\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/code$/iu;

function publicBasePath(request: IncomingMessage): string {
  const value = request.headers["x-cantrip-code-base-path"];
  return typeof value === "string" && WEB_CODE_BASE_PATH.test(value)
    ? value
    : BASE_PATH;
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

  constructor(private readonly supervisor: CodeSupervisor) {}

  async prepareProtected(
    tunnelId: string,
    sessionId: string,
    connection: CodeEndpointPreparationContext = {},
  ): Promise<{ kind: "tcp"; host: "127.0.0.1"; port: number }> {
    const endpointId = `protected:${tunnelId}`;
    const details = { tunnelId, sessionId, ...connection };
    const existing = this.#endpoints.get(endpointId);
    if (existing?.sessionId === sessionId) {
      existing.fallbackConnection = connection;
      return existing.address;
    }
    const pending = this.#preparations.get(endpointId);
    if (pending?.sessionId === sessionId) {
      const address = await pending.promise;
      const prepared = this.#endpoints.get(endpointId);
      if (prepared?.sessionId === sessionId) {
        prepared.fallbackConnection = connection;
      }
      return address;
    }
    this.revoke(endpointId, "Protected Code session rotated");
    const preparation = {} as EndpointPreparation;
    preparation.sessionId = sessionId;
    preparation.promise = (async () => {
      const endpoint = await this.#create({ sessionId, tunnelId }, connection);
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
    context: CodeEndpointContext,
    connection: CodeEndpointPreparationContext,
  ): Promise<Endpoint> {
    const { sessionId, tunnelId } = context;
    const endpoint: Endpoint = {
      address: { kind: "tcp", host: "127.0.0.1", port: 0 },
      connectionContexts: new Map(),
      diagnosticOutcomes: new Map(),
      fallbackConnection: connection,
      server: createServer(),
      sessionId,
      sockets: new Set(),
      tunnelId,
    };
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: CODE_MAX_WEBSOCKET_MESSAGE_BYTES,
    });
    endpoint.server.on("request", (request, response) =>
      this.#proxyHttp(
        endpoint,
        this.#requestContext(endpoint, request),
        request,
        response,
      ),
    );
    endpoint.server.on("upgrade", (request, socket, head) => {
      const requestContext = this.#requestContext(endpoint, request);
      if (!this.#validPath(request.url)) {
        workerLogger.rateLimited(
          this.#failureKey("websocket", requestContext, "invalid-path"),
          "warn",
          "Cantrip Code direct WebSocket path rejected",
          {
            event: "code.direct.websocket-rejected",
            subsystem: "code",
            operation: "open-websocket",
            reasonCode: "invalid-path",
            status: "rejected",
            ...requestContext,
          },
        );
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit("connection", client, request);
      });
    });
    webSockets.on("connection", (socket, request) => {
      endpoint.sockets.add(socket);
      socket.once("close", () => endpoint.sockets.delete(socket));
      this.#proxyWebSocket(
        endpoint,
        this.#requestContext(endpoint, request),
        socket,
        request,
      );
    });
    endpoint.server.on("connection", (socket) => {
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

  bindProtectedConnection(
    tunnelId: string,
    endpointPort: number,
    remotePort: number,
    connection: CodeEndpointPreparationContext,
  ): void {
    const endpoint = this.#endpoints.get(`protected:${tunnelId}`);
    if (!endpoint || endpoint.address.port !== endpointPort) return;
    endpoint.connectionContexts.set(remotePort, connection);
  }

  revoke(capabilityId: string, reason: string): void {
    this.#preparations.delete(capabilityId);
    const endpoint = this.#endpoints.get(capabilityId);
    if (!endpoint) return;
    this.#endpoints.delete(capabilityId);
    this.#closeEndpoint(endpoint, reason);
  }

  #closeEndpoint(endpoint: Endpoint, reason: string): void {
    for (const socket of endpoint.sockets) {
      socket.close(1008, reason.slice(0, 123));
    }
    endpoint.server.close();
    endpoint.server.closeAllConnections();
  }

  async closeSession(sessionId: string): Promise<void> {
    this.#sessionGenerations.set(
      sessionId,
      (this.#sessionGenerations.get(sessionId) ?? 0) + 1,
    );
    for (const [endpointId, endpoint] of this.#endpoints) {
      if (endpoint.sessionId === sessionId) {
        this.revoke(endpointId, "Code session stopped");
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
    for (const capabilityId of new Set([
      ...this.#endpoints.keys(),
      ...this.#preparations.keys(),
    ])) {
      this.revoke(capabilityId, "Worker control connection lost");
    }
  }

  close(): void {
    for (const capabilityId of new Set([
      ...this.#endpoints.keys(),
      ...this.#preparations.keys(),
    ])) {
      this.revoke(capabilityId, "Worker stopping");
    }
  }

  #validPath(rawPath: string | undefined): boolean {
    try {
      const url = new URL(rawPath ?? "/", "http://cantrip-code.invalid");
      return (
        url.pathname === BASE_PATH || url.pathname.startsWith(`${BASE_PATH}/`)
      );
    } catch {
      return false;
    }
  }

  #requestContext(
    endpoint: Endpoint,
    request: IncomingMessage,
  ): CodeEndpointContext {
    const remotePort = request.socket.remotePort;
    const connection =
      (remotePort === undefined
        ? undefined
        : endpoint.connectionContexts.get(remotePort)) ??
      endpoint.fallbackConnection;
    return {
      sessionId: endpoint.sessionId,
      tunnelId: endpoint.tunnelId,
      ...connection,
    };
  }

  #firstOutcome(
    endpoint: Endpoint,
    outcome: "health" | "http-success" | "websocket-success",
    context: CodeEndpointContext,
  ): boolean {
    const traceKey = context.diagnosticTraceId ?? "untraced";
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
    const { sessionId, tunnelId, ...connection } = context;
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
      pathname === `${BASE_PATH}/_cantrip/health` &&
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
    if (pathname === `${BASE_PATH}/_cantrip/health`) {
      response
        .writeHead(200, {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json",
        })
        .end('{"status":"ok"}');
      return;
    }
    if (pathname === OPEN_FILE_PATH) {
      void this.#openFile(context, request, response);
      return;
    }
    if (pathname === OPEN_SETTINGS_PATH) {
      void this.#openSettings(context, request, response);
      return;
    }
    if (pathname === PRESENTATION_PATH) {
      void this.#setPresentation(context, request, response);
      return;
    }
    if (pathname === THEME_PATH) {
      void this.#setTheme(context, request, response);
      return;
    }
    if (!this.#validPath(request.url)) {
      response.writeHead(404, { "cache-control": "no-store" }).end("Not found");
      return;
    }
    let releaseStream: (() => void) | null = null;
    let failureReason = "session-unavailable";
    try {
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
        request.url ?? `${BASE_PATH}/`,
        BASE_PATH,
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
            publicBasePath(request),
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
      const result = codeOpenFileResultSchema.parse(
        await this.#enqueueControl(sessionId, () =>
          (this.#sessionGenerations.get(sessionId) ?? 0) === sessionGeneration
            ? this.supervisor.openFile(sessionId, input.data.relativePath)
            : Promise.reject(new Error("Cantrip Code session stopped.")),
        ),
      );
      writeControlResponse(response, 200, result);
      workerLogger.event("debug", "Cantrip Code direct file opened", {
        event: "code.direct.file-opened",
        subsystem: "code",
        operation: "open-file",
        status: "completed",
        ...context,
      });
    } catch (error) {
      workerLogger.event("warn", "Cantrip Code direct file open failed", {
        event: "code.direct.file-open-failed",
        subsystem: "code",
        operation: "open-file",
        reasonCode: "open-failed",
        status: "failed",
        ...context,
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
      const result = codeOpenSettingsResultSchema.parse(
        await this.#enqueueControl(sessionId, () =>
          (this.#sessionGenerations.get(sessionId) ?? 0) === sessionGeneration
            ? this.supervisor.openSettings(sessionId)
            : Promise.reject(new Error("Cantrip Code session stopped.")),
        ),
      );
      writeControlResponse(response, 200, result);
      workerLogger.event("debug", "Cantrip Code graphical settings opened", {
        event: "code.direct.settings-opened",
        subsystem: "code",
        operation: "open-settings",
        status: "completed",
        ...context,
      });
    } catch (error) {
      workerLogger.event("warn", "Cantrip Code settings open failed", {
        event: "code.direct.settings-open-failed",
        subsystem: "code",
        operation: "open-settings",
        reasonCode: "open-failed",
        status: "failed",
        ...context,
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
      await this.#enqueueControl(sessionId, () =>
        (this.#sessionGenerations.get(sessionId) ?? 0) === sessionGeneration
          ? this.supervisor.setPresentation(sessionId, "editor")
          : Promise.reject(new Error("Cantrip Code session stopped.")),
      );
      writeControlResponse(response, 200, input.data);
      workerLogger.event("debug", "Cantrip Code direct presentation updated", {
        event: "code.direct.presentation-updated",
        subsystem: "code",
        operation: "set-presentation",
        status: "completed",
        presentation: "editor",
        ...context,
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
          ...context,
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
      await this.#enqueueControl(sessionId, () =>
        (this.#sessionGenerations.get(sessionId) ?? 0) === sessionGeneration
          ? this.supervisor.setTheme(
              sessionId,
              input.data.themeMode,
              input.data.appearance,
            )
          : Promise.reject(new Error("Cantrip Code session stopped.")),
      );
      writeControlResponse(response, 200, input.data);
      workerLogger.event("debug", "Cantrip Code direct theme updated", {
        event: "code.direct.theme-updated",
        subsystem: "code",
        operation: "set-theme",
        status: "completed",
        themeMode: input.data.themeMode,
        appearance: input.data.appearance,
        ...context,
      });
    } catch (error) {
      workerLogger.event("warn", "Cantrip Code direct theme update failed", {
        event: "code.direct.theme-update-failed",
        subsystem: "code",
        operation: "set-theme",
        reasonCode: "update-failed",
        status: "failed",
        ...context,
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
    const { sessionId, tunnelId, ...connection } = context;
    const requestId = randomUUID();
    const startedAtMs = Date.now();
    const details = { sessionId, tunnelId, ...connection, requestId };
    let releaseStream: (() => void) | null = null;
    let failureReason = "session-unavailable";
    try {
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
        request.url ?? `${BASE_PATH}/`,
        BASE_PATH,
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
          publicBasePath(request),
          proxy.connectionToken,
        ),
        maxPayload: CODE_MAX_WEBSOCKET_MESSAGE_BYTES,
      });
      const queued: Array<{ data: Buffer; binary: boolean }> = [];
      let queuedBytes = 0;
      let authenticationForwarded = false;
      const closeBoth = (code = 1011, reason = "Cantrip Code disconnected") => {
        if (client.readyState === WebSocket.OPEN) client.close(code, reason);
        if (upstream.readyState === WebSocket.OPEN)
          upstream.close(code, reason);
        else upstream.terminate();
      };
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
            queued.push({ data: payload, binary });
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
          upstream.send(payload, { binary });
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
          upstream.send(item.data, { binary: item.binary });
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
        client.send(payload, { binary });
      });
      client.once("close", (code, reason) => {
        endStream();
        if (upstream.readyState === WebSocket.OPEN) {
          const forwarded = forwardableCodeWebSocketClose(code, reason);
          upstream.close(forwarded.code, forwarded.reason);
        } else upstream.terminate();
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
      });
      upstream.once("error", (error) => {
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
